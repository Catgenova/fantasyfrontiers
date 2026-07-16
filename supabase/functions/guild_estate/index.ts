// Fantasy Frontiers — guild_estate edge function: DECOMMISSIONED.
//
// This function backed the OLD "5 shared estate-crafting task slots" design (start/collect/cancel on
// public.guild_estate_tasks). The Guild Estate was later reworked into a shared jsonb-blob CANVAS that
// the client syncs directly against the `guild_estate` TABLE (chatClient.from('guild_estate')), and its
// job output is deposited to the guild bank through the item_debit-gated `guild_bank` deposit path -- so
// the client no longer calls THIS function at all.
//
// The old `start`/`collect` actions never debited the crafting inputs from the server item ledger and
// took a client-supplied output_key/batches, so a member could mint arbitrary items into the guild bank
// (then withdraw them into the real ledger via the unthrottled item_credit transfer) for free. Because
// the function was still deployed, that path stayed callable directly via the API even though the client
// abandoned it. It is decommissioned here: every action is refused, so nothing can be minted.
//
// Safe to DELETE the function entirely in the dashboard; this neutralized stub is the redeploy-safe
// alternative if you'd rather keep the endpoint returning a clear error.
import "https://esm.sh/@supabase/supabase-js@2"; // (unused) keep the import graph stable across deploys

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve((req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  // Every action (get/start/collect/cancel) is gone. Return 410 Gone so an old client fails loudly.
  return json({ ok: false, error: "The guild_estate task API has been removed." }, 410);
});
