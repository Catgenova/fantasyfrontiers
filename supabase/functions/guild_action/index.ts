// Fantasy Frontiers — server-authoritative guild actions.
//
// The client cannot write the guild tables directly (see the RLS migration). Every
// mutation goes through this function, which derives the caller's identity from their
// auth token (never the body) and enforces membership + rank rules with the service role.
//
// Actions (POST { action, ... }):
//   get_state                         -> { guild, members, myRank, applications } | { guild:null }
//   create   { name, tag, description }-> creates a guild, caller becomes leader
//   apply    { guild_id, message }    -> submit an application to an open guild
//   cancel_application                -> withdraw the caller's pending application
//   accept   { user_id }              -> (leader/officer) admit an applicant
//   reject   { user_id }              -> (leader/officer) decline an applicant
//   kick     { user_id }              -> (leader/officer) remove a member (not the leader)
//   promote  { user_id }              -> (leader) member -> officer
//   demote   { user_id }              -> (leader) officer -> member
//   transfer { user_id }              -> (leader) hand leadership to another member
//   leave                             -> leave your guild (leader must transfer/disband first)
//   disband                           -> (leader) delete the guild
//   set_open { open }                 -> (leader/officer) toggle accepting applications
//   set_description { description }   -> (leader/officer) update the blurb
//
// Verify JWT must be OFF for this function (the client key is a publishable key, not a
// JWT — the gateway would 401 otherwise; the token is validated internally below).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

const NAME_RE = /^[A-Za-z0-9 '\-]{3,24}$/;
const TAG_RE = /^[A-Za-z0-9]{2,5}$/;

// deno-lint-ignore no-explicit-any
type Admin = any;

async function loadMembership(admin: Admin, userId: string) {
  const { data } = await admin.from("guild_members")
    .select("guild_id, rank, username").eq("user_id", userId).maybeSingle();
  return data as { guild_id: string; rank: string; username: string } | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return json({ ok: false, error: "Server not configured." }, 500);
  const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  // Identity from the token (never the body).
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ ok: false, error: "Not authenticated." }, 401);
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  const user = userData?.user;
  if (userErr || !user) return json({ ok: false, error: "Not authenticated." }, 401);
  const userId = user.id;
  const username = (user.user_metadata && (user.user_metadata as Record<string, unknown>).username) as string | undefined;
  if (!username) return json({ ok: false, error: "Account has no username." }, 400);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ ok: false, error: "Invalid request." }, 400); }
  const action = String(body.action || "");

  let me = await loadMembership(admin, userId);
  // Self-heal: if my membership row points to a guild that no longer exists, clear the orphan so
  // I'm treated as guildless (can apply/create again) instead of being stuck "in" a dead guild.
  if (me) {
    const { data: myGuild } = await admin.from("guilds").select("id").eq("id", me.guild_id).maybeSingle();
    if (!myGuild) { await admin.from("guild_members").delete().eq("user_id", userId); me = null; }
  }

  // ---- Aggregated state for the Guild tab ----
  if (action === "get_state") {
    if (!me) return json({ ok: true, guild: null });
    const { data: guild } = await admin.from("guilds").select("*").eq("id", me.guild_id).maybeSingle();
    if (!guild) return json({ ok: true, guild: null }); // membership row orphaned; treat as guildless
    const { data: members } = await admin.from("guild_members")
      .select("user_id, username, rank, contribution, joined_at")
      .eq("guild_id", me.guild_id).order("joined_at", { ascending: true });
    let applications: unknown[] = [];
    if (me.rank === "leader" || me.rank === "officer") {
      const { data: apps } = await admin.from("guild_applications")
        .select("id, user_id, username, message, created_at")
        .eq("guild_id", me.guild_id).order("created_at", { ascending: true });
      applications = apps || [];
    }
    return json({ ok: true, guild, members: members || [], myRank: me.rank, applications });
  }

  // ---- Create ----
  if (action === "create") {
    if (me) return json({ ok: false, error: "You're already in a guild." }, 409);
    const name = String(body.name || "").trim();
    const tag = String(body.tag || "").trim();
    const description = String(body.description || "").trim().slice(0, 240);
    if (!NAME_RE.test(name)) return json({ ok: false, error: "Name must be 3–24 letters, numbers, spaces, ' or -." }, 400);
    if (!TAG_RE.test(tag)) return json({ ok: false, error: "Tag must be 2–5 letters or numbers." }, 400);

    const { data: guild, error: gErr } = await admin.from("guilds")
      .insert({ name, tag, description, leader_id: userId, member_count: 1 })
      .select("*").single();
    if (gErr) {
      const dup = String(gErr.message || "").toLowerCase();
      if (dup.includes("guilds_name_key")) return json({ ok: false, error: "That guild name is taken." }, 409);
      if (dup.includes("guilds_tag_key")) return json({ ok: false, error: "That guild tag is taken." }, 409);
      return json({ ok: false, error: "Could not create guild." }, 500);
    }
    const { error: mErr } = await admin.from("guild_members")
      .insert({ user_id: userId, guild_id: guild.id, username, rank: "leader" });
    if (mErr) { // roll back the guild so a failed create doesn't strand an empty guild
      await admin.from("guilds").delete().eq("id", guild.id);
      return json({ ok: false, error: "Could not create guild." }, 500);
    }
    // Clear any pending applications this user had elsewhere.
    await admin.from("guild_applications").delete().eq("user_id", userId);
    return json({ ok: true, guild });
  }

  // ---- Apply ----
  if (action === "apply") {
    if (me) return json({ ok: false, error: "You're already in a guild." }, 409);
    const guildId = String(body.guild_id || "");
    const message = String(body.message || "").trim().slice(0, 200);
    const { data: guild } = await admin.from("guilds").select("id, open, min_total_level").eq("id", guildId).maybeSingle();
    if (!guild) return json({ ok: false, error: "Guild not found." }, 404);
    if (!guild.open) return json({ ok: false, error: "That guild isn't accepting applications." }, 403);
    const { error: aErr } = await admin.from("guild_applications")
      .upsert({ guild_id: guildId, user_id: userId, username, message }, { onConflict: "guild_id,user_id" });
    if (aErr) return json({ ok: false, error: "Could not submit application." }, 500);
    return json({ ok: true });
  }

  if (action === "cancel_application") {
    await admin.from("guild_applications").delete().eq("user_id", userId);
    return json({ ok: true });
  }

  // ---- Everything below requires membership ----
  if (!me) return json({ ok: false, error: "You're not in a guild." }, 403);
  const isLeader = me.rank === "leader";
  const isOfficer = me.rank === "officer" || isLeader;

  if (action === "leave") {
    if (isLeader) return json({ ok: false, error: "As leader, transfer leadership or disband the guild first." }, 409);
    await admin.from("guild_members").delete().eq("user_id", userId);
    await admin.from("guilds").update({ member_count: await countMembers(admin, me.guild_id) }).eq("id", me.guild_id);
    return json({ ok: true, left: true });
  }

  if (action === "disband") {
    if (!isLeader) return json({ ok: false, error: "Only the leader can disband." }, 403);
    await admin.from("guilds").delete().eq("id", me.guild_id); // cascades members/apps/messages
    return json({ ok: true, disbanded: true });
  }

  if (action === "set_open") {
    if (!isOfficer) return json({ ok: false, error: "Not allowed." }, 403);
    await admin.from("guilds").update({ open: !!body.open }).eq("id", me.guild_id);
    return json({ ok: true });
  }

  if (action === "set_description") {
    if (!isOfficer) return json({ ok: false, error: "Not allowed." }, 403);
    await admin.from("guilds").update({ description: String(body.description || "").trim().slice(0, 240) }).eq("id", me.guild_id);
    return json({ ok: true });
  }

  // Actions that target another member/applicant.
  const targetId = String(body.user_id || "");

  if (action === "accept" || action === "reject") {
    if (!isOfficer) return json({ ok: false, error: "Not allowed." }, 403);
    const { data: app } = await admin.from("guild_applications")
      .select("id, user_id, username").eq("guild_id", me.guild_id).eq("user_id", targetId).maybeSingle();
    if (!app) return json({ ok: false, error: "Application not found." }, 404);
    if (action === "reject") {
      await admin.from("guild_applications").delete().eq("id", app.id);
      return json({ ok: true });
    }
    // accept: add the member FIRST, then clear the application. Deleting the app before a
    // successful insert could strand the applicant (no member row AND no application).
    let existing = await loadMembership(admin, targetId);
    if (existing) {
      // Self-heal an orphaned membership (points to a deleted guild) so it doesn't block joining.
      const { data: eg } = await admin.from("guilds").select("id").eq("id", existing.guild_id).maybeSingle();
      if (!eg) { await admin.from("guild_members").delete().eq("user_id", targetId); existing = null; }
    }
    if (existing && existing.guild_id === me.guild_id) {
      // Already a member here (e.g. a retried/duplicate accept) -> idempotent success; just tidy the app.
      await admin.from("guild_applications").delete().eq("user_id", targetId);
      return json({ ok: true });
    }
    if (existing) return json({ ok: false, error: "That player already joined another guild." }, 409); // keep their app
    const { error: jErr } = await admin.from("guild_members")
      .insert({ user_id: targetId, guild_id: me.guild_id, username: app.username, rank: "member" });
    if (jErr) return json({ ok: false, error: "Could not add member — try again." }, 500); // application preserved
    await admin.from("guild_applications").delete().eq("user_id", targetId); // clear apps only after a successful join
    await admin.from("guilds").update({ member_count: await countMembers(admin, me.guild_id) }).eq("id", me.guild_id);
    return json({ ok: true });
  }

  if (action === "kick") {
    if (!isOfficer) return json({ ok: false, error: "Not allowed." }, 403);
    if (targetId === userId) return json({ ok: false, error: "Use Leave to remove yourself." }, 400);
    const target = await loadMembership(admin, targetId);
    if (!target || target.guild_id !== me.guild_id) return json({ ok: false, error: "Member not found." }, 404);
    if (target.rank === "leader") return json({ ok: false, error: "Can't kick the leader." }, 403);
    if (target.rank === "officer" && !isLeader) return json({ ok: false, error: "Only the leader can remove an officer." }, 403);
    await admin.from("guild_members").delete().eq("user_id", targetId);
    await admin.from("guilds").update({ member_count: await countMembers(admin, me.guild_id) }).eq("id", me.guild_id);
    return json({ ok: true });
  }

  if (action === "promote" || action === "demote") {
    if (!isLeader) return json({ ok: false, error: "Only the leader can change ranks." }, 403);
    const target = await loadMembership(admin, targetId);
    if (!target || target.guild_id !== me.guild_id) return json({ ok: false, error: "Member not found." }, 404);
    if (target.rank === "leader") return json({ ok: false, error: "Can't change the leader's rank." }, 400);
    const newRank = action === "promote" ? "officer" : "member";
    await admin.from("guild_members").update({ rank: newRank }).eq("user_id", targetId);
    return json({ ok: true });
  }

  if (action === "transfer") {
    if (!isLeader) return json({ ok: false, error: "Only the leader can transfer leadership." }, 403);
    const target = await loadMembership(admin, targetId);
    if (!target || target.guild_id !== me.guild_id) return json({ ok: false, error: "Member not found." }, 404);
    if (targetId === userId) return json({ ok: false, error: "You're already the leader." }, 400);
    await admin.from("guild_members").update({ rank: "leader" }).eq("user_id", targetId);
    await admin.from("guild_members").update({ rank: "officer" }).eq("user_id", userId);
    await admin.from("guilds").update({ leader_id: targetId }).eq("id", me.guild_id);
    return json({ ok: true });
  }

  return json({ ok: false, error: "Unknown action." }, 400);
});

// deno-lint-ignore no-explicit-any
async function countMembers(admin: any, guildId: string): Promise<number> {
  const { count } = await admin.from("guild_members").select("user_id", { count: "exact", head: true }).eq("guild_id", guildId);
  return count || 0;
}
