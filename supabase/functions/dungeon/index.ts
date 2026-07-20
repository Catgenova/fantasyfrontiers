// Fantasy Frontiers — server-authoritative synchronous Dungeons (Phase 2, Stage A).
//
// 1-4 players form a party in a lobby, then descend together. The server owns the SHARED
// run state (which enemy, its shared HP, the roster, status). Each member's damage is a
// clamped power*elapsed proxy accrued into the shared pool (the server can't run the JS
// combat engine), consistent with the Guild Boss / economy trust model. On a kill the server
// advances to the next foe; clearing the 25th boss flips the run to 'cleared'.
//
// Actions (POST { action, ... }):
//   get                          -> my current session + roster (or null)
//   list { layer }               -> open lobbies for a layer (with member counts)
//   create { layer }             -> open a lobby (I become host + first member)
//   join { session_id }          -> join an open lobby
//   leave { session_id }         -> leave (host or last member disbands it)
//   start { session_id }         -> (host) begin the descent; seeds enemy 0's HP
//   assault { session_id, power }-> accrue shared damage against the current foe
//
// Verify JWT must be OFF (the publishable key isn't a JWT; the token is validated internally).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// Server-authoritative dungeon roster. These MUST match the client's DUNGEON_D1_ENEMIES:
//   hp[i]  = round(50000 * 1.05^i) for i < 24; hp[24] = round(hp[23]*10)   (boss ~10x the 24th)
//   atk[i] = round((round(80*1.04^i) + round(200*1.04^i)) / 2)             (avg enemy hit; group offense cut 60%, was 200/500)
//   spd_ms[i] = round((2.2 + (i%5)*0.3) * 1000)                            (enemy attack interval)
function d1Roster(): { hp: number[]; atk: number[]; spd: number[] } {
  const hp: number[] = [], atk: number[] = [], spd: number[] = [];
  for (let i = 0; i < 25; i++) {
    hp.push(Math.round(50000 * Math.pow(1.05, i)));
    atk.push(Math.round((Math.round(80 * Math.pow(1.04, i)) + Math.round(200 * Math.pow(1.04, i))) / 2));
    spd.push(Math.round((2.2 + (i % 5) * 0.3) * 1000));
  }
  hp[24] = Math.round(hp[23] * 10);
  return { hp, atk, spd };
}
// D2 "Tunnel" (Orcs, L126->150). Mirrors the client's DUNGEON_D2_ENEMIES:
//   hp[i]  = round(150000 * 1.05^i) for i < 24; hp[24] = round(hp[23]*10)   (boss ~10x the 24th)
//   atk[i] = round((round(400*1.04^i) + round(1000*1.04^i)) / 2)            (avg enemy hit)
//   spd_ms[i] = round((2.2 + (i%5)*0.3) * 1000)                            (enemy attack interval)
function d2Roster(): { hp: number[]; atk: number[]; spd: number[] } {
  const hp: number[] = [], atk: number[] = [], spd: number[] = [];
  for (let i = 0; i < 25; i++) {
    hp.push(Math.round(150000 * Math.pow(1.05, i)));
    atk.push(Math.round((Math.round(400 * Math.pow(1.04, i)) + Math.round(1000 * Math.pow(1.04, i))) / 2));
    spd.push(Math.round((2.2 + (i % 5) * 0.3) * 1000));
  }
  hp[24] = Math.round(hp[23] * 10);
  return { hp, atk, spd };
}
// D3 "Underground Chamber" (Undead, L151->175). Mirrors the client's DUNGEON_D3_ENEMIES:
//   hp[i]  = round(450000 * 1.05^i) for i < 24; hp[24] = round(hp[23]*10)   (boss ~10x the 24th)
//   atk[i] = round((round(800*1.04^i) + round(2000*1.04^i)) / 2)            (avg enemy hit)
//   spd_ms[i] = round((2.2 + (i%5)*0.3) * 1000)                            (enemy attack interval)
function d3Roster(): { hp: number[]; atk: number[]; spd: number[] } {
  const hp: number[] = [], atk: number[] = [], spd: number[] = [];
  for (let i = 0; i < 25; i++) {
    hp.push(Math.round(450000 * Math.pow(1.05, i)));
    atk.push(Math.round((Math.round(800 * Math.pow(1.04, i)) + Math.round(2000 * Math.pow(1.04, i))) / 2));
    spd.push(Math.round((2.2 + (i % 5) * 0.3) * 1000));
  }
  hp[24] = Math.round(hp[23] * 10);
  return { hp, atk, spd };
}
// D4 "Nest of the Depths" (Dragons, L176->200). Mirrors the client's DUNGEON_D4_ENEMIES:
//   hp[i]  = round(1350000 * 1.05^i) for i < 24; hp[24] = round(hp[23]*10)  (boss ~10x the 24th)
//   atk[i] = round((round(1600*1.04^i) + round(4000*1.04^i)) / 2)           (avg enemy hit)
//   spd_ms[i] = round((2.2 + (i%5)*0.3) * 1000)                            (enemy attack interval)
function d4Roster(): { hp: number[]; atk: number[]; spd: number[] } {
  const hp: number[] = [], atk: number[] = [], spd: number[] = [];
  for (let i = 0; i < 25; i++) {
    hp.push(Math.round(1350000 * Math.pow(1.05, i)));
    atk.push(Math.round((Math.round(1600 * Math.pow(1.04, i)) + Math.round(4000 * Math.pow(1.04, i))) / 2));
    spd.push(Math.round((2.2 + (i % 5) * 0.3) * 1000));
  }
  hp[24] = Math.round(hp[23] * 10);
  return { hp, atk, spd };
}
const DUNGEONS: Record<string, { count: number; hours: number; hp: number[]; atk: number[]; spd: number[] }> = {
  d1: { count: 25, hours: 3, ...d1Roster() },
  d2: { count: 25, hours: 4, ...d2Roster() },
  d3: { count: 25, hours: 5, ...d3Roster() },
  d4: { count: 25, hours: 6, ...d4Roster() },
};
const POWER_CEILING = 12000;         // max accepted DPS proxy (anti-cheat clamp)
const MAX_CREDIT_SECONDS = 30;       // max real-time credited per assault ping (anti-burst)
const MAX_HP_CEILING = 100_000_000;  // clamp for the client-reported effective HP proxy
const THREAT_CEILING = 1000;         // clamp for the client-reported threat proxy
// Ceiling on a single party heal. Generous next to real HP pools (MAX_HP_CEILING) but finite, so a
// tampered client can't hold the party at full health forever with one enormous claim.
const MAX_HEAL_PER_CALL = 5_000_000;

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
  // Volume rate limit (Postgres rl_hit; see migration 20260716200000). Fail-open if the limiter is down.
  try { const { data: _over } = await admin.rpc("rl_hit", { p_subject: user.id, p_bucket: "dungeon", p_limit: 300, p_window_secs: 60 }); if (_over === true) return json({ ok: false, error: "Too many requests." }, 429); } catch { /* limiter unavailable -> allow */ }
  const username = (user.user_metadata && (user.user_metadata as Record<string, unknown>).username) as string | undefined;
  if (!username) return json({ ok: false, error: "Account has no username." }, 400);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ ok: false, error: "Invalid request." }, 400); }
  const action = String(body.action || "");

  function clampPower(v: unknown): number {
    let p = Number(v);
    if (!Number.isFinite(p) || p < 0) p = 0;
    return Math.min(POWER_CEILING, Math.round(p));
  }
  function clampInt(v: unknown, lo: number, hi: number): number {
    let n = Number(v);
    if (!Number.isFinite(n)) n = lo;
    return Math.max(lo, Math.min(hi, Math.round(n)));
  }
  // Combat stats a client reports for itself (trusted-but-bounded proxies, like power).
  const combatStats = () => ({
    p_power: clampPower(body.power),
    p_threat: clampInt(body.threat, 1, THREAT_CEILING),
    p_max_hp: clampInt(body.max_hp, 1, MAX_HP_CEILING),
    p_mit: clampInt(body.mit, 0, 85),
  });

  // Full snapshot of a session id: the session row + its member roster.
  async function snapshotOf(sessionId: string) {
    const { data: session } = await admin.from("dungeon_sessions")
      .select("id, layer, host_id, status, enemy_index, enemy_count, enemy_hp, target_id, version, expires_at")
      .eq("id", sessionId).maybeSingle();
    if (!session) return { session: null, members: [] };
    const { data: members } = await admin.from("dungeon_members")
      .select("user_id, username, power, damage, alive, claimed, hp, max_hp, threat, shield").eq("session_id", sessionId).order("joined_at");
    return { session, members: members || [] };
  }

  // My current lobby/active session (a user holds at most one).
  async function mySession() {
    const { data: mine } = await admin.from("dungeon_members").select("session_id").eq("user_id", user.id);
    if (!mine || !mine.length) return { session: null, members: [] };
    for (const row of mine) {
      const snap = await snapshotOf(row.session_id as string);
      if (snap.session && ["lobby", "active", "cleared", "wiped"].includes(snap.session.status as string)) return snap;
    }
    return { session: null, members: [] };
  }

  if (action === "get") return json({ ok: true, ...(await mySession()) });

  if (action === "list") {
    const layer = String(body.layer || "");
    const { data: rows } = await admin.from("dungeon_sessions")
      .select("id, layer, host_id, status, created_at, dungeon_members(user_id, username)")
      .eq("layer", layer).eq("status", "lobby").order("created_at", { ascending: false }).limit(20);
    const lobbies = (rows || []).map((r) => {
      const mem = (r as { dungeon_members?: { username: string }[] }).dungeon_members || [];
      return { id: r.id, host_id: r.host_id, count: mem.length, members: mem.map((m) => m.username) };
    });
    return json({ ok: true, lobbies });
  }

  if (action === "create") {
    const layer = String(body.layer || "");
    const def = DUNGEONS[layer];
    if (!def) return json({ ok: false, error: "Unknown dungeon." }, 400);
    const { data: r, error } = await admin.rpc("dungeon_create", {
      p_user: user.id, p_username: username, p_layer: layer, ...combatStats(), p_count: def.count, p_hours: def.hours,
    });
    if (error) return json({ ok: false, error: "Could not create the party." }, 500);
    const res = r as { status?: string; session_id?: string };
    if (res?.status === "engaged") return json({ ok: false, error: "You're already in a dungeon party." }, 409);
    return json({ ok: true, ...(await snapshotOf(res.session_id as string)) });
  }

  if (action === "join") {
    const sid = String(body.session_id || "");
    const { data: r, error } = await admin.rpc("dungeon_join", {
      p_session: sid, p_user: user.id, p_username: username, ...combatStats(),
    });
    if (error) return json({ ok: false, error: "Could not join." }, 500);
    const st = (r as { status?: string }).status;
    if (st === "gone") return json({ ok: false, error: "That party no longer exists." }, 404);
    if (st === "started") return json({ ok: false, error: "That party has already started." }, 409);
    if (st === "full") return json({ ok: false, error: "That party is full (4/4)." }, 409);
    if (st === "engaged") return json({ ok: false, error: "You're already in a dungeon party." }, 409);
    if (st !== "ok") return json({ ok: false, error: "Could not join." }, 409);
    return json({ ok: true, ...(await snapshotOf(sid)) });
  }

  if (action === "leave") {
    const sid = String(body.session_id || "");
    const { data: r, error } = await admin.rpc("dungeon_leave", { p_session: sid, p_user: user.id });
    if (error) return json({ ok: false, error: "Could not leave." }, 500);
    return json({ ok: true, result: r, session: null, members: [] });
  }

  if (action === "start") {
    const sid = String(body.session_id || "");
    // Read the layer to seed enemy 0's HP from the server roster.
    const { data: s } = await admin.from("dungeon_sessions").select("layer").eq("id", sid).maybeSingle();
    const def = s ? DUNGEONS[s.layer as string] : null;
    if (!def) return json({ ok: false, error: "Party not found." }, 404);
    const { data: r, error } = await admin.rpc("dungeon_start", { p_session: sid, p_user: user.id, p_enemy0_hp: def.hp[0] });
    if (error) return json({ ok: false, error: "Could not start." }, 500);
    const st = (r as { status?: string }).status;
    if (st === "nothost") return json({ ok: false, error: "Only the host can start the descent." }, 403);
    if (st === "gone") return json({ ok: false, error: "That party no longer exists." }, 404);
    if (st !== "ok") return json({ ok: false, error: "Could not start (" + st + ")." }, 409);
    return json({ ok: true, ...(await snapshotOf(sid)) });
  }

  if (action === "assault") {
    const sid = String(body.session_id || "");
    const { data: s } = await admin.from("dungeon_sessions").select("layer").eq("id", sid).maybeSingle();
    const def = s ? DUNGEONS[s.layer as string] : null;
    if (!def) return json({ ok: false, error: "Party not found." }, 404);
    // Phase 3: the client runs the REAL combat engine and reports what happened -- damage it actually
    // dealt, and its own HP after resolving the enemy's swings through its own mitigation chain.
    // `power` is still sent, but now only as the CEILING the reported damage is clamped to
    // (min(reported, power*elapsed) in the RPC), so real mechanics matter without unbounding the rate.
    const ceiling = clampPower(body.power);
    const dmg = Number(body.damage);
    const reported = (Number.isFinite(dmg) && dmg > 0) ? Math.min(Math.floor(dmg), Number.MAX_SAFE_INTEGER) : 0;
    const hpRaw = Number(body.hp);
    const hpReport = Number.isFinite(hpRaw) && hpRaw >= 0 ? Math.min(Math.floor(hpRaw), MAX_HP_CEILING) : null;
    const { data: r, error } = await admin.rpc("dungeon_assault", {
      p_session: sid, p_user: user.id, p_damage: reported, p_hp_report: hpReport,
      p_power_ceiling: ceiling, p_max_seconds: MAX_CREDIT_SECONDS,
      p_hp: def.hp, p_atk: def.atk, p_spd_ms: def.spd,
    });
    if (error) return json({ ok: false, error: "Assault failed." }, 500);
    return json({ ok: true, result: r, ...(await snapshotOf(sid)) });
  }

  // Party heal: a targeted event, not a broadcast. The server owns every member's HP, so a heal is a
  // delta aimed at one member -- that keeps a single writer per value instead of N clients racing their
  // own view of the party's health. Bounded by MAX_HEAL_PER_CALL so a tampered client can't top the party
  // up infinitely; overheal only becomes a barrier for healers whose perk grants one.
  if (action === "heal") {
    const sid = String(body.session_id || "");
    const target = String(body.target_id || "");
    if (!sid || !target) return json({ ok: false, error: "Invalid heal." }, 400);
    const amtRaw = Number(body.amount);
    const amount = Number.isFinite(amtRaw) && amtRaw > 0 ? Math.floor(amtRaw) : 0;
    if (amount <= 0) return json({ ok: true, result: { status: "ok", healed: 0 } });
    const sfRaw = Number(body.shield_frac);
    const shieldFrac = Number.isFinite(sfRaw) ? Math.max(0, Math.min(1, sfRaw)) : 0;
    const { data: r, error } = await admin.rpc("dungeon_heal", {
      p_session: sid, p_healer: user.id, p_target: target,
      p_amount: amount, p_shield_frac: shieldFrac, p_max_heal: MAX_HEAL_PER_CALL,
    });
    if (error) return json({ ok: false, error: "Heal failed." }, 500);
    return json({ ok: true, result: r, ...(await snapshotOf(sid)) });
  }

  if (action === "claim") {
    const sid = String(body.session_id || "");
    const { data: s } = await admin.from("dungeon_sessions").select("id").eq("id", sid).maybeSingle();
    if (!s) return json({ ok: false, error: "Party not found." }, 404);
    const { data: r, error } = await admin.rpc("dungeon_claim", { p_session: sid, p_user: user.id });
    if (error) return json({ ok: false, error: "Claim failed." }, 500);
    const st = (r as { status?: string }).status;
    if (st === "dead") return json({ ok: false, error: "You fell — only survivors claim the Formula." }, 403);
    if (st === "claimed") return json({ ok: false, error: "You've already claimed this run's Formula." }, 409);
    if (st !== "ok") return json({ ok: false, error: "Nothing to claim." }, 409);
    return json({ ok: true, claim: r, ...(await snapshotOf(sid)) });
  }

  return json({ ok: false, error: "Unknown action." }, 400);
});
