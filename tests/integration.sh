#!/usr/bin/env bash
#
# Fantasy Frontiers — backend integration tests.
#
# Drives the real Supabase backend end-to-end (Edge Functions + SECURITY DEFINER RPCs + RLS):
# registration/auth, the full guild lifecycle, the shared bank + gold treasury, guild_estate
# row-level security + the optimistic version guard, and submit_profile validation. Assertions
# check the actual HTTP/JSON responses.
#
# These hit the LIVE project and create throwaway accounts (prefixed `it_<runid>_`). Guilds are
# disbanded at the end (cascade), but Supabase Auth users can't be deleted with the publishable
# key -- the script prints the accounts it made so you can remove them under Authentication > Users.
#
# Usage:   bash tests/integration.sh
# Config:  SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY  (env vars override the defaults below)
#
# Requires: bash + curl. No jq needed. Exits non-zero if any assertion fails.

set -uo pipefail

BASE="${SUPABASE_URL:-https://varyclnmlrgdzgdxhcyd.supabase.co}"
PUB="${SUPABASE_PUBLISHABLE_KEY:-sb_publishable_NH0IJ65wCtOk3_2RfALDRg_qRFrmekL}"
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
# mkuser SUFFIX -> sets USER + TOK for a freshly registered + signed-in account
mkuser(){ USER="${RUN}_$1"; ACCOUNTS+=("$USER"); reg "{\"username\":\"$USER\",\"password\":\"testpass12345\"}" >/dev/null; TOK="$(signin "{\"email\":\"$USER@players.fantasyfrontiers.app\",\"password\":\"testpass12345\"}")"; }

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

# --------------------------------------------------------------------------------------------
sect "submit_profile validation"
assert_ok  "$(fn submit_profile "$TOK_A" '{"total_level":3,"gold":100,"skills":{"mining":3}}')" "valid profile accepted"
assert_err "$(fn submit_profile "$TOK_A" '{"total_level":5,"gold":100,"skills":{"mining":3}}')" "total_level != sum(skills) rejected"
assert_err "$(fn submit_profile "$TOK_A" '{"total_level":999,"gold":100,"skills":{"mining":999}}')" "out-of-range skill level rejected"

# --------------------------------------------------------------------------------------------
sect "Cleanup"
# Demote-free path: leader disband cascades members/apps/messages/bank/estate for the test guild.
DIS=$(fn guild_action "$TOK_A" '{"action":"disband"}')
assert_has "$DIS" "\"disbanded\":true" "leader disbands the test guild (cascade cleanup)"

printf '\n\033[1mResult: %d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
printf 'Throwaway accounts created (delete under Authentication > Users):\n'
for u in "${ACCOUNTS[@]}"; do printf '  - %s\n' "$u"; done
[ "$FAIL" -eq 0 ]
