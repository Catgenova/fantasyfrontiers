// Fantasy Frontiers — server-authoritative async Guild Bosses (damage pool).
//
// Officers summon a boss (shared HP). Members "assault" it — each ping accrues
// power*elapsed damage, rate-capped here (power is a clamped client DPS proxy; elapsed is
// capped per ping). On the kill the boss gold is paid into the guild treasury (once) and
// contributors claim an item share by damage fraction (items are granted client-side).
//
// Actions (POST { action, ... }):
//   get                 -> { active, claimable, mine, contributors, now }
//   summon { boss_key } -> (leader/officer) start a boss if none is active
//   assault { power }   -> accrue damage against the active boss
//   claim { boss_id }   -> mark your share claimed; returns your damage fraction
//
// Verify JWT must be OFF (publishable key isn't a JWT; token validated internally).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// Server-authoritative boss roster (HP / gold / duration). The client keeps a matching
// roster for display + the loot table (loot is granted client-side on claim).
const BOSSES: Record<string, { name: string; hp: number; gold: number; hours: number }> = {
  gorehoof:   { name: "Gorehoof the Trampler", hp: 100_000,   gold: 50_000,    hours: 24 },
  embermaw:   { name: "Embermaw Wyrm",         hp: 500_000,   gold: 200_000,   hours: 24 },
  hollowking: { name: "The Hollow King",       hp: 2_000_000, gold: 1_000_000, hours: 48 },
};
const POWER_CEILING = 8000;      // max accepted DPS proxy (anti-cheat clamp)
const MAX_CREDIT_SECONDS = 300;  // max real-time credited per assault ping (anti-burst)

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return json({ ok: false, error: "Server not configured." }, 500);
  const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ ok: false, error: "Not authenticated." }, 401);
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  const user = userData?.user;
  if (userErr || !user) return json({ ok: false, error: "Not authenticated." }, 401);
  const username = (user.user_metadata && (user.user_metadata as Record<string, unknown>).username) as string | undefined;
  if (!username) return json({ ok: false, error: "Account has no username." }, 400);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ ok: false, error: "Invalid request." }, 400); }
  const action = String(body.action || "");

  const { data: me } = await admin.from("guild_members").select("guild_id, rank").eq("user_id", user.id).maybeSingle();
  if (!me) return json({ ok: false, error: "You're not in a guild." }, 403);
  const guildId = me.guild_id as string;
  const isOfficer = me.rank === "officer" || me.rank === "leader";

  async function snapshot() {
    const { data: active } = await admin.from("guild_bosses")
      .select("id, boss_key, name, hp_max, hp_current, gold_reward, total_damage, status, started_at, expires_at")
      .eq("guild_id", guildId).eq("status", "active").maybeSingle();
    let mine: { damage: number; claimed: boolean } | null = null;
    let contributors: unknown[] = [];
    if (active) {
      const { data: top } = await admin.from("guild_boss_damage")
        .select("username, damage").eq("boss_id", active.id).order("damage", { ascending: false }).limit(10);
      contributors = top || [];
      const { data: myd } = await admin.from("guild_boss_damage")
        .select("damage, claimed").eq("boss_id", active.id).eq("user_id", user.id).maybeSingle();
      mine = myd || null;
    }
    // A recently-defeated boss this member can still claim from.
    const { data: def } = await admin.from("guild_bosses")
      .select("id, boss_key, name, hp_max, total_damage, defeated_at")
      .eq("guild_id", guildId).eq("status", "defeated").order("defeated_at", { ascending: false }).limit(1).maybeSingle();
    let claimable: unknown = null;
    if (def) {
      const { data: myd2 } = await admin.from("guild_boss_damage")
        .select("damage, claimed").eq("boss_id", def.id).eq("user_id", user.id).maybeSingle();
      if (myd2 && !myd2.claimed && myd2.damage > 0) claimable = { ...def, my_damage: myd2.damage };
    }
    return { active: active || null, claimable, mine, contributors, now: new Date().toISOString() };
  }

  if (action === "get") return json({ ok: true, ...(await snapshot()) });

  if (action === "summon") {
    if (!isOfficer) return json({ ok: false, error: "Only officers or the leader can summon a boss." }, 403);
    const key = String(body.boss_key || "");
    const def = BOSSES[key];
    if (!def) return json({ ok: false, error: "Unknown boss." }, 400);
    const expires = new Date(Date.now() + def.hours * 3_600_000).toISOString();
    const { error } = await admin.from("guild_bosses").insert({
      guild_id: guildId, boss_key: key, name: def.name, hp_max: def.hp, hp_current: def.hp,
      gold_reward: def.gold, expires_at: expires,
    });
    if (error) {
      if (String(error.message || "").toLowerCase().includes("one_active")) return json({ ok: false, error: "A boss is already active." }, 409);
      return json({ ok: false, error: "Could not summon the boss." }, 500);
    }
    return json({ ok: true, ...(await snapshot()) });
  }

  if (action === "assault") {
    let power = Number(body.power);
    if (!Number.isFinite(power) || power < 0) power = 0;
    power = Math.min(POWER_CEILING, Math.round(power));
    const { data: active } = await admin.from("guild_bosses")
      .select("id").eq("guild_id", guildId).eq("status", "active").maybeSingle();
    if (!active) return json({ ok: false, error: "No active boss." }, 404);
    const { data: r, error } = await admin.rpc("guild_boss_assault", {
      p_boss: active.id, p_user: user.id, p_username: username, p_power: power, p_max_seconds: MAX_CREDIT_SECONDS,
    });
    if (error) return json({ ok: false, error: "Assault failed." }, 500);
    return json({ ok: true, result: r, ...(await snapshot()) });
  }

  if (action === "claim") {
    const bossId = Number(body.boss_id);
    if (!Number.isInteger(bossId)) return json({ ok: false, error: "Invalid boss." }, 400);
    // Confirm the boss belongs to the caller's guild before touching it.
    const { data: b } = await admin.from("guild_bosses").select("id").eq("id", bossId).eq("guild_id", guildId).maybeSingle();
    if (!b) return json({ ok: false, error: "Boss not found." }, 404);
    const { data: r, error } = await admin.rpc("guild_boss_claim", { p_boss: bossId, p_user: user.id });
    if (error) return json({ ok: false, error: "Claim failed." }, 500);
    const res = r as { status?: string; boss_key?: string; my_damage?: number; total_damage?: number };
    if (res?.status === "claimed") return json({ ok: false, error: "You've already claimed this boss's loot." }, 409);
    if (res?.status === "nocontribution") return json({ ok: false, error: "You didn't damage this boss." }, 403);
    if (res?.status !== "ok") return json({ ok: false, error: "Nothing to claim." }, 409);
    return json({ ok: true, claim: { boss_key: res.boss_key, my_damage: res.my_damage, total_damage: res.total_damage }, ...(await snapshot()) });
  }

  return json({ ok: false, error: "Unknown action." }, 400);
});
