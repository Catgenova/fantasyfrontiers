#!/usr/bin/env bash
#
# Fantasy Frontiers — backend integration tests.
#
# Drives the real Supabase backend end-to-end (Edge Functions + SECURITY DEFINER RPCs + RLS):
# registration/auth, the full guild lifecycle, the shared bank + gold treasury, guild_estate
# row-level security + the optimistic version guard, and submit_profile validation. Assertions
# check the actual HTTP/JSON responses.
#
# These hit whatever project SUPABASE_URL points at and create throwaway accounts (prefixed
# `it_<runid>_`). Guilds are disbanded at the end (cascade), but Supabase Auth users can't be deleted
# with the publishable key -- the script prints the accounts it made so you can remove them under
# Authentication > Users. Point this at a STAGING project, not production.
#
# Usage:   SUPABASE_URL=... SUPABASE_PUBLISHABLE_KEY=... bash tests/integration.sh
# Config:  SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY  (REQUIRED -- no production fallback)
#
# Requires: bash + curl. No jq needed. Exits non-zero if any assertion fails.

set -uo pipefail

BASE="${SUPABASE_URL:-}"
PUB="${SUPABASE_PUBLISHABLE_KEY:-}"
# No production fallback: if a staging target isn't configured, SKIP cleanly rather than churn accounts
# on the live project. Set both secrets (to a staging Supabase project) to actually run.
if [ -z "$BASE" ] || [ -z "$PUB" ]; then
  echo "SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY not set -- skipping integration tests."
  echo "Point them at a STAGING project to run (refusing to fall back to production)."
  exit 0
fi
RUN="it_$(date +%s)_$((RANDOM%9000+1000))"
PASS=0; FAIL=0
declare -a ACCOUNTS=()

c()  { printf '%s' "$1"; }                        # identity (kept for readability)
field(){ printf '%s' "$1" | grep -oE "\"$2\"[[:space:]]*:[[:space:]]*(\"[^\"]*\"|-?[0-9.]+|true|false|null)" | head -1 | sed -E "s/^\"$2\"[[:space:]]*:[[:space:]]*//; s/^\"//; s/\"$//"; }
has()  { printf '%s' "$1" | grep -qF -- "$2"; }
jwtsub(){ # user id from a JWT's `sub` claim (base64url-decode the payload segment)
  local p; p="$(printf '%s' "$1" | cut -d. -f2 | tr '_-' '/+')"
  case $(( ${#p} % 4 )) in 2) p="$p==";; 3) p="$p=";; esac
  printf '%s' "$p" | base64 -d 2>/dev/null | grep -oE '"sub":"[^"]*"' | head -1 | sed -E 's/.*:"//; s/"//'
}

pass(){ PASS=$((PASS+1)); printf '   \033[32mok\033[0m   %s\n' "$1"; }
faild(){ FAIL=$((FAIL+1)); printf '   \033[31mFAIL\033[0m %s\n' "$1"; [ -n "${2:-}" ] && printf '        %s\n' "$2"; }
sect(){ printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
assert_ok(){   [ "$(field "$1" ok)" = "true" ]  && pass "$2" || faild "$2" "resp: $1"; }
assert_err(){  [ "$(field "$1" ok)" = "false" ] && pass "$2" || faild "$2" "resp: $1"; }
assert_eq(){   [ "$2" = "$3" ] && pass "$1" || faild "$1" "expected [$3] got [$2]"; }
assert_has(){  has "$1" "$2" && pass "$3" || faild "$3" "missing [$2] in: $1"; }
assert_nohas(){ has "$1" "$2" && faild "$3" "unexpected [$2] in: $1" || pass "$3"; }
assert_denied(){  case "$1" in 2*) faild "$3" "expected denial, got HTTP $1: $2";; *) pass "$3";; esac; }  # $1=status $2=body $3=label
assert_allowed(){ case "$1" in 2*) pass "$3";; *) faild "$3" "expected success, got HTTP $1: $2";; esac; }

reg(){ curl -s -X POST "$BASE/functions/v1/register" -H "apikey: $PUB" -H "Authorization: Bearer $PUB" -H "Content-Type: application/json" -d "$1"; }
signin(){ curl -s -X POST "$BASE/auth/v1/token?grant_type=password" -H "apikey: $PUB" -H "Content-Type: application/json" -d "$1" | grep -oE '"access_token":"[^"]*"' | head -1 | sed -E 's/.*:"//; s/"//'; }
fn(){ curl -s -X POST "$BASE/functions/v1/$1" -H "apikey: $PUB" -H "Authorization: Bearer $2" -H "Content-Type: application/json" -d "$3"; }
rest(){ # rest METHOD PATH TOKEN [BODY]  -> REST API with return=representation
  local m="$1" path="$2" tok="$3" body="${4:-}"
  if [ -n "$body" ]; then
    curl -s -X "$m" "$BASE/rest/v1/$path" -H "apikey: $PUB" -H "Authorization: Bearer $tok" -H "Content-Type: application/json" -H "Prefer: return=representation" -d "$body"
  else
    curl -s -X "$m" "$BASE/rest/v1/$path" -H "apikey: $PUB" -H "Authorization: Bearer $tok"
  fi
}
rpc_call(){ # rpc_call NAME TOKEN [BODY] -> POST /rest/v1/rpc/NAME, prints "<body>\n<http_status>"
  curl -s -w '\n%{http_code}' -X POST "$BASE/rest/v1/rpc/$1" -H "apikey: $PUB" -H "Authorization: Bearer $2" -H "Content-Type: application/json" -d "${3:-{}}"
}
# Fund a signed-in account's SERVER wallet (gold is server-authoritative -- guild create, treasury
# donations and market buys all debit it). The earn allowance is now gated on account age AND validated
# progression (profiles.total_level), so a fresh test account (level 0, no profile) is pinned to the
# early-game floor and this 10M earn would be throttled -- STAGING MUST SET secret FF_RATE_RAMP_OFF=1,
# which pins the full allowance so one earn banks 10M in full.
fund_wallet(){ fn wallet "$1" '{"action":"earn","earned_total":10000000}' >/dev/null; }
# Fund a signed-in account's item LEDGER (market SELL debits it). First sync grandfathers the reported
# stock (age-capped, well above these small test quantities).
fund_items(){ fn items "$1" "{\"action\":\"sync\",\"inventory\":$2}" >/dev/null; }
# mkuser SUFFIX -> sets USER + TOK for a freshly registered + signed-in account, wallet pre-funded.
mkuser(){ USER="${RUN}_$1"; ACCOUNTS+=("$USER"); reg "{\"username\":\"$USER\",\"password\":\"testpass12345\"}" >/dev/null; TOK="$(signin "{\"email\":\"$USER@players.fantasyfrontiers.app\",\"password\":\"testpass12345\"}")"; fund_wallet "$TOK"; }

printf '\033[1mFantasy Frontiers integration tests\033[0m  (run id: %s)\n' "$RUN"
printf 'target: %s\n' "$BASE"

# --------------------------------------------------------------------------------------------
sect "Registration & auth"
RA=$(reg "{\"username\":\"${RUN}_a\",\"password\":\"testpass12345\"}"); ACCOUNTS+=("${RUN}_a")
assert_ok "$RA" "register a fresh account"
assert_err "$(reg "{\"username\":\"${RUN}_a\",\"password\":\"testpass12345\"}")" "duplicate username rejected"
assert_err "$(reg "{\"username\":\"ab\",\"password\":\"testpass12345\"}")" "too-short username rejected"
assert_err "$(reg "{\"username\":\"${RUN}_a\",\"password\":\"short\"}")" "too-short password rejected"
TOK_A="$(signin "{\"email\":\"${RUN}_a@players.fantasyfrontiers.app\",\"password\":\"testpass12345\"}")"
[ -n "$TOK_A" ] && pass "sign in returns an access token" || faild "sign in returns an access token"
USER_A="${RUN}_a"
fund_wallet "$TOK_A"   # gold is server-authoritative -- fund the wallet before guild create / treasury donations

# --------------------------------------------------------------------------------------------
sect "Wallet: spoofed earn/sync is clamped"
# The reported-fetch-inject exploit shape: intercept the sync and report ~1T earned_total + 1T gold. The
# allowance bucket + min() clamp must bound the result at ONE DAY's allowance at most (500M under
# FF_RATE_RAMP_OFF; the early-game FLOOR of 250k on a real fresh account) -- never honor the claim.
mkuser wspoof; TOK_W="$TOK"
WS=$(fn wallet "$TOK_W" '{"action":"sync","earned_total":999999999999,"gold":999999999999}')
assert_ok "$WS" "spoofed sync returns ok (clamped, not honored)"
WG="$(field "$WS" gold)"; WGI="${WG%.*}"
if [ -n "$WGI" ] && [ "$WGI" -le 500000000 ] 2>/dev/null; then pass "spoofed gold clamped by the bucket (gold=$WG)"; else faild "spoofed gold clamped by the bucket" "gold=$WG"; fi

# --------------------------------------------------------------------------------------------
sect "Guild create & validation"
GNAME="Guild ${RUN:3:10}"; GTAG="T$((RANDOM%9000+1000))"
GC=$(fn guild_action "$TOK_A" "{\"action\":\"create\",\"name\":\"$GNAME\",\"tag\":\"$GTAG\"}")
assert_ok "$GC" "leader creates a guild"
GID="$(field "$GC" id)"
[ -n "$GID" ] && pass "guild id returned ($GID)" || faild "guild id returned"
assert_err "$(fn guild_action "$TOK_A" "{\"action\":\"create\",\"name\":\"Another $RUN\",\"tag\":\"X$((RANDOM%900+100))\"}")" "already-in-a-guild create rejected"
mkuser c
assert_err "$(fn guild_action "$TOK" "{\"action\":\"create\",\"name\":\"$GNAME\",\"tag\":\"Z$((RANDOM%900+100))\"}")" "duplicate guild name rejected"
TOK_C="$TOK"

# --------------------------------------------------------------------------------------------
sect "Membership: apply / accept"
assert_ok  "$(fn guild_action "$TOK_A" "{\"action\":\"set_open\",\"open\":false}")" "leader closes the guild to applications"
assert_err "$(fn guild_action "$TOK_C" "{\"action\":\"apply\",\"guild_id\":\"$GID\"}")" "apply to a closed guild rejected"
assert_ok  "$(fn guild_action "$TOK_A" "{\"action\":\"set_open\",\"open\":true}")" "leader re-opens the guild"
mkuser b; TOK_B="$TOK"; USER_B="$USER"; BID="$(jwtsub "$TOK_B")"
[ -n "$BID" ] && pass "derived applicant user id from JWT" || faild "derived applicant user id from JWT"
assert_ok "$(fn guild_action "$TOK_B" "{\"action\":\"apply\",\"guild_id\":\"$GID\"}")" "member applies to the open guild"
ST=$(fn guild_action "$TOK_A" "{\"action\":\"get_state\"}")
assert_has "$ST" "$USER_B" "applicant shows in leader's get_state"
assert_ok "$(fn guild_action "$TOK_A" "{\"action\":\"accept\",\"user_id\":\"$BID\"}")" "leader accepts an applicant"
STB=$(fn guild_action "$TOK_B" "{\"action\":\"get_state\"}")
assert_has "$STB" "\"myRank\":\"member\"" "accepted user is a member"

# --------------------------------------------------------------------------------------------
sect "Roster permissions"
assert_ok  "$(fn guild_action "$TOK_A" "{\"action\":\"promote\",\"user_id\":\"$BID\"}")" "leader promotes member to officer"
assert_err "$(fn guild_action "$TOK_B" "{\"action\":\"promote\",\"user_id\":\"$BID\"}")" "officer cannot promote (leader-only)"
assert_ok  "$(fn guild_action "$TOK_A" "{\"action\":\"demote\",\"user_id\":\"$BID\"}")" "leader demotes officer to member"

# --------------------------------------------------------------------------------------------
sect "Guild bank (items)"
BG=$(fn guild_bank "$TOK_A" '{"action":"get"}')
assert_eq "bank starts with 5 slots" "$(field "$BG" slots)" "5"
assert_eq "bank starts empty" "$(field "$BG" used)" "0"
DEP=$(fn guild_bank "$TOK_A" '{"action":"deposit","item_key":"coal","qty":50}')
assert_eq "deposit fills one slot" "$(field "$DEP" used)" "1"
assert_has "$DEP" "\"coal\"" "deposited item appears in the vault"
WD=$(fn guild_bank "$TOK_A" '{"action":"withdraw","item_key":"coal","qty":20}')
assert_has "$WD" "\"qty\":30" "withdraw leaves the remainder (30)"
assert_err "$(fn guild_bank "$TOK_A" '{"action":"withdraw","item_key":"coal","qty":9999}')" "over-withdraw rejected"

# --------------------------------------------------------------------------------------------
sect "Guild treasury (coffers)"
assert_eq "treasury starts at 0" "$(field "$BG" treasury)" "0"
assert_eq "donate 100000" "$(field "$(fn guild_bank "$TOK_A" '{"action":"donate_gold","amount":100000}')" treasury)" "100000"
BS=$(fn guild_bank "$TOK_A" '{"action":"buy_slot"}')
assert_eq "buy_slot: slots -> 6" "$(field "$BS" slots)" "6"
assert_eq "buy_slot: treasury -> 90000 (paid from coffers)" "$(field "$BS" treasury)" "90000"
assert_eq "spend_gold 5000 -> 85000" "$(field "$(fn guild_bank "$TOK_A" '{"action":"spend_gold","amount":5000}')" treasury)" "85000"
assert_eq "withdraw_gold 5000 (leader) -> 80000" "$(field "$(fn guild_bank "$TOK_A" '{"action":"withdraw_gold","amount":5000}')" treasury)" "80000"
POOR=$(fn guild_bank "$TOK_A" '{"action":"spend_gold","amount":999999999}')
assert_err "$POOR" "spend beyond the treasury is rejected"
assert_has "$POOR" "\"code\":\"poor\"" "over-spend returns code=poor"
# withdraw permission: restrict to leader, then the member cannot withdraw but can donate
assert_ok "$(fn guild_bank "$TOK_A" '{"action":"set_withdraw_rank","rank":"leader"}')" "leader restricts withdrawals to leader"
assert_err "$(fn guild_bank "$TOK_B" '{"action":"withdraw_gold","amount":10}')" "member blocked from withdrawing"
assert_ok  "$(fn guild_bank "$TOK_B" '{"action":"donate_gold","amount":10}')" "member can still donate"
assert_err "$(fn guild_bank "$TOK_B" '{"action":"buy_slot"}')" "member cannot buy slots (officer/leader only)"

# --------------------------------------------------------------------------------------------
sect "Guild estate: RLS + optimistic version guard"
INS=$(rest POST "guild_estate" "$TOK_A" "{\"guild_id\":\"$GID\",\"data\":{\"grid\":[],\"jobs\":[]},\"version\":0}")
assert_has "$INS" "\"version\":0" "leader can insert the guild estate blob"
RD_B=$(rest GET "guild_estate?guild_id=eq.$GID&select=version" "$TOK_B")
assert_has "$RD_B" "\"version\":0" "fellow member can read the shared blob"
RD_C=$(rest GET "guild_estate?guild_id=eq.$GID&select=version" "$TOK_C")
assert_nohas "$RD_C" "\"version\"" "non-member cannot read another guild's estate (RLS)"
UP1=$(rest PATCH "guild_estate?guild_id=eq.$GID&version=eq.0" "$TOK_A" "{\"data\":{\"grid\":[],\"jobs\":[]},\"version\":1}")
assert_has "$UP1" "\"version\":1" "version-guarded update at v0 succeeds"
UP2=$(rest PATCH "guild_estate?guild_id=eq.$GID&version=eq.0" "$TOK_A" "{\"data\":{\"grid\":[],\"jobs\":[]},\"version\":2}")
assert_eq "stale update (v0 again) matches no rows" "$(printf '%s' "$UP2" | tr -d '[:space:]')" "[]"
# The old guild_estate task-slot EDGE FUNCTION is decommissioned (it minted items into the bank with no
# input debit). Every action must now be refused, so the mint path is closed.
assert_err "$(fn guild_estate "$TOK_A" '{"action":"start","slot":0,"skill_id":"paving","output_key":"fantastic_relic","batches":100,"time_per_batch_ms":3000}')" "decommissioned guild_estate start is refused"
assert_err "$(fn guild_estate "$TOK_A" '{"action":"collect","slot":0}')" "decommissioned guild_estate collect is refused"

# --------------------------------------------------------------------------------------------
sect "submit_profile validation"
assert_ok  "$(fn submit_profile "$TOK_A" '{"total_level":3,"gold":100,"skills":{"mining":3}}')" "valid profile accepted"
assert_err "$(fn submit_profile "$TOK_A" '{"total_level":5,"gold":100,"skills":{"mining":3}}')" "total_level != sum(skills) rejected"
assert_err "$(fn submit_profile "$TOK_A" '{"total_level":999,"gold":100,"skills":{"mining":999}}')" "out-of-range skill level rejected"
# Rapid-fire injection: each submit used to grant a fresh BURST (400 levels), so firing N in a row banked
# 400*N onto the leaderboard in seconds (and unlocked the total_level-gated gold rate). The token bucket
# must bound repeated jumps -- after several instant 800-level submits the stored total_level stays near
# one burst (~400), not 800. profiles is publicly readable, so read it back via REST.
mkuser lvl; TOK_L="$TOK"; LID="$(jwtsub "$TOK_L")"
LVLBIG='{"total_level":800,"gold":100,"skills":{"a":100,"b":100,"c":100,"d":100,"e":100,"f":100,"g":100,"h":100}}'
fn submit_profile "$TOK_L" "$LVLBIG" >/dev/null; fn submit_profile "$TOK_L" "$LVLBIG" >/dev/null; fn submit_profile "$TOK_L" "$LVLBIG" >/dev/null
LVLNOW="$(field "$(rest GET "profiles?id=eq.$LID&select=total_level" "$TOK_L")" total_level)"
if [ -n "$LVLNOW" ] && [ "$LVLNOW" -le 500 ] 2>/dev/null; then pass "rapid submit_profile is bucket-bounded (total_level=$LVLNOW, not 800)"; else faild "rapid submit_profile is bucket-bounded" "total_level=$LVLNOW"; fi

# --------------------------------------------------------------------------------------------
sect "Marketplace"
# Uses a random item_key so parallel/nightly runs don't share a book.
# Single-char suffixes keep the username within the 20-char cap (${RUN} is already ~18 chars).
IKEY="itest_${RANDOM}${RANDOM}"
mkuser d; TOK_MA="$TOK"
mkuser e; TOK_MB="$TOK"
fund_items "$TOK_MA" "{\"$IKEY\":100}"   # market SELL debits the item ledger -- give the seller stock

MS1=$(fn marketplace "$TOK_MA" "{\"action\":\"place\",\"side\":\"sell\",\"item_key\":\"$IKEY\",\"unit_price\":100,\"qty\":10}")
assert_ok "$MS1" "A places a sell order (10 @ 100)"
assert_eq "sell rests fully (0 filled)" "$(field "$MS1" filled)" "0"
assert_eq "sell rests 10"               "$(field "$MS1" rest)"   "10"

# The global "For Sale" listings feed includes A's resting sell.
LS=$(fn marketplace "$TOK_MB" '{"action":"listings"}')
assert_has "$LS" "\"item_key\":\"$IKEY\"" "listings feed shows the item for sale"

MB1=$(fn marketplace "$TOK_MB" "{\"action\":\"place\",\"side\":\"buy\",\"item_key\":\"$IKEY\",\"unit_price\":100,\"qty\":10}")
assert_ok "$MB1" "B places a crossing buy (10 @ 100)"
assert_eq "buy fills all 10 instantly" "$(field "$MB1" filled)" "10"
assert_eq "buy rests 0"                "$(field "$MB1" rest)"   "0"

BC=$(fn marketplace "$TOK_MB" '{"action":"collect"}')
assert_ok  "$BC" "B collects proceeds"
assert_has "$BC" "\"item_key\":\"$IKEY\"" "B receives the bought item"

AC=$(fn marketplace "$TOK_MA" '{"action":"collect"}')
assert_ok "$AC" "A collects proceeds"
assert_eq "A receives 950g after 5% tax burned (1000-50)" "$(field "$AC" gold)" "950"

fn marketplace "$TOK_MA" "{\"action\":\"place\",\"side\":\"sell\",\"item_key\":\"$IKEY\",\"unit_price\":50,\"qty\":5}" >/dev/null
MB2=$(fn marketplace "$TOK_MB" "{\"action\":\"place\",\"side\":\"buy\",\"item_key\":\"$IKEY\",\"unit_price\":50,\"qty\":8}")
assert_eq "partial buy fills 5" "$(field "$MB2" filled)" "5"
assert_eq "partial buy rests 3" "$(field "$MB2" rest)"   "3"

BK=$(fn marketplace "$TOK_MB" "{\"action\":\"book\",\"item_key\":\"$IKEY\"}")
assert_eq "book best bid = 50 (B's resting order)" "$(field "$BK" best_bid)" "50"

OID=$(field "$MB2" order_id)
CX=$(fn marketplace "$TOK_MB" "{\"action\":\"cancel\",\"order_id\":$OID}")
assert_ok "$CX" "B cancels the resting buy order"
assert_eq "cancel refunds qty 3" "$(field "$CX" qty)" "3"

# No self-trade: A's buy must NOT fill against A's own resting sell.
fn marketplace "$TOK_MA" "{\"action\":\"place\",\"side\":\"sell\",\"item_key\":\"$IKEY\",\"unit_price\":10,\"qty\":1}" >/dev/null
MSELF=$(fn marketplace "$TOK_MA" "{\"action\":\"place\",\"side\":\"buy\",\"item_key\":\"$IKEY\",\"unit_price\":10,\"qty\":1}")
assert_eq "own order not self-traded (buy rests)" "$(field "$MSELF" filled)" "0"
assert_err "$(fn marketplace "$TOK_MA" "{\"action\":\"place\",\"side\":\"sideways\",\"item_key\":\"$IKEY\",\"unit_price\":1,\"qty\":1}")" "invalid side rejected"
assert_err "$(fn marketplace "$TOK_MA" "{\"action\":\"place\",\"side\":\"buy\",\"item_key\":\"$IKEY\",\"unit_price\":9999999999,\"qty\":1}")" "over-max price rejected"

# --------------------------------------------------------------------------------------------
sect "Server buff"
# Uses the 1s 'test' kind so we don't switch on the real +50% EXP buff for every live player.
SBG=$(fn server_buff "$TOK_MA" '{"action":"get"}')
assert_ok  "$SBG" "buff status is readable"
assert_has "$SBG" "\"exp\"" "status includes the exp buff key"
SBB=$(fn server_buff "$TOK_MA" '{"action":"buy","kind":"test"}')
assert_ok  "$SBB" "buy a buff (test kind)"
assert_has "$SBB" "\"active_until\"" "buy returns the new active_until"
assert_err "$(fn server_buff "$TOK_MA" '{"action":"buy","kind":"nope"}')" "unknown buff kind rejected"
# The free, unverified `grant` action (any player could pin the server-wide +50% XP buff on for free)
# is removed -- it must be rejected now. Also confirm it did NOT extend the exp timer.
EXP_BEFORE="$(field "$(fn server_buff "$TOK_MA" '{"action":"get"}')" exp)"
assert_err "$(fn server_buff "$TOK_MA" '{"action":"grant","reason":"register"}')" "free server-buff grant is rejected"
assert_err "$(fn server_buff "$TOK_MA" '{"action":"grant","reason":"familiar"}')" "free familiar grant is rejected"
assert_eq "grant did not extend the exp buff" "$(field "$(fn server_buff "$TOK_MA" '{"action":"get"}')" exp)" "$EXP_BEFORE"

# --------------------------------------------------------------------------------------------
sect "RPC lockdown (SECURITY DEFINER RPCs are service_role-only, not callable via REST)"
# These SECURITY DEFINER functions must NOT be reachable directly at /rest/v1/rpc/<name> by anon or a
# signed-in user -- that would bypass the edge functions (which authenticate the caller and pass the
# token-verified uid) and let anyone mint gold/items, poke the treasury, or set recovery answers. A
# 2xx from any of these = a serious hole. (Migration 20260708130000 revoked EXECUTE from public/anon/
# authenticated and granted it only to service_role.)
NOBODY_UUID="00000000-0000-0000-0000-000000000000"
lockcheck(){ # lockcheck NAME TOKEN BODY LABEL -- asserts a direct RPC call is denied (non-2xx)
  local R; R="$(rpc_call "$1" "$2" "$3")"
  assert_denied "$(printf '%s' "$R" | tail -n1)" "$(printf '%s' "$R" | sed '$d')" "$4"
}
lockcheck market_credit_gold    "$PUB"    "{\"p_user\":\"$NOBODY_UUID\",\"p_amount\":1000000000}"              "anon cannot mint gold (market_credit_gold)"
lockcheck market_credit_gold    "$TOK_A"  "{\"p_user\":\"$NOBODY_UUID\",\"p_amount\":1000000000}"              "signed-in user cannot mint gold (market_credit_gold)"
lockcheck market_credit_item    "$TOK_A"  "{\"p_user\":\"$NOBODY_UUID\",\"p_item\":\"coal\",\"p_qty\":9999}"   "signed-in user cannot mint items (market_credit_item)"
lockcheck guild_treasury_donate "$TOK_A"  "{\"p_guild\":\"$GID\",\"p_amount\":1}"                              "signed-in user cannot call guild_treasury_donate directly"
lockcheck server_buff_extend    "$TOK_A"  "{\"p_kind\":\"exp\",\"p_seconds\":3600}"                            "signed-in user cannot extend the server buff directly"
lockcheck recovery_set          "$PUB"    "{\"p_user\":\"$NOBODY_UUID\",\"p_username\":\"x\",\"p_items\":[]}"   "anon cannot set recovery answers (recovery_set)"
lockcheck rls_auto_enable       "$TOK_A"  "{}"                                                                 "signed-in user cannot call rls_auto_enable"
# Positive control: the RLS helper current_guild_id() MUST stay callable by authenticated (RLS uses it).
# It's a STABLE 0-arg function, so PostgREST calls it via GET (a POST body would be PGRST102).
CG="$(curl -s -w '\n%{http_code}' "$BASE/rest/v1/rpc/current_guild_id" -H "apikey: $PUB" -H "Authorization: Bearer $TOK_A")"
assert_allowed "$(printf '%s' "$CG" | tail -n1)" "$(printf '%s' "$CG" | sed '$d')" "current_guild_id() still executable by authenticated (RLS helper)"

# --------------------------------------------------------------------------------------------
sect "Cleanup"
# Demote-free path: leader disband cascades members/apps/messages/bank/estate for the test guild.
DIS=$(fn guild_action "$TOK_A" '{"action":"disband"}')
assert_has "$DIS" "\"disbanded\":true" "leader disbands the test guild (cascade cleanup)"

printf '\n\033[1mResult: %d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
printf 'Throwaway accounts created (delete under Authentication > Users):\n'
for u in "${ACCOUNTS[@]}"; do printf '  - %s\n' "$u"; done
[ "$FAIL" -eq 0 ]
