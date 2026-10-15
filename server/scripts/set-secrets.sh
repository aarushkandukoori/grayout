#!/usr/bin/env bash
# Set the 5 secrets a Grayout Worker needs, in one go. Run it AFTER deploy.sh.
#
#   bash scripts/set-secrets.sh sandbox https://grayout-api-sandbox.<you>.workers.dev
#   bash scripts/set-secrets.sh live    https://grayout-api.<you>.workers.dev
#
# Only Aarush runs this, typing in his own Terminal window. It asks for two
# keys and shows LICENSE_SECRET once, for his password manager. Anywhere else
# (a pipe, a log file, an agent's shell) that one showing could be lost or
# recorded, so the script refuses to start without a terminal.
#
# You paste 2 keys (the Stripe restricted key and the OpenAI key). The other 3
# are made here and go straight into Cloudflare. A secret is never saved in a
# file, never passed as a command-line argument (anyone on the Mac can see
# those in `ps`), and never printed, except LICENSE_SECRET once on screen.
# Every value is checked before it is stored: an empty or malformed secret is
# never stored, and any problem stops the script with a plain message.
#
# Safe to run again: a secret that is already set is skipped (LICENSE_SECRET
# must NEVER change, every customer's key is derived from it).

set -euo pipefail
cd "$(dirname "$0")/.."                       # the server/ folder

if [[ ! -t 0 || ! -t 1 ]]; then
  echo "set-secrets.sh only runs in a Terminal window, with Aarush typing." >&2
  echo "It asks for two keys and shows LICENSE_SECRET once. Without a terminal that" >&2
  echo "secret could be stored but never seen (lost keys could then never be re-sent)," >&2
  echo "or end up in a log. Nothing was done. Open Terminal and run it there:" >&2
  echo "    cd server && bash scripts/set-secrets.sh sandbox|live https://<worker>.workers.dev" >&2
  exit 2
fi

TARGET="${1:-}"; BASE="${2:-}"
case "$TARGET" in
  sandbox) ENV=(--env sandbox); STRIPE_MODE=();      KEY_HINT="rk_test_" ;;
  live)    ENV=();              STRIPE_MODE=(--live); KEY_HINT="rk_live_" ;;
  *) echo "Usage: bash scripts/set-secrets.sh sandbox|live https://<worker>.workers.dev" >&2; exit 2 ;;
esac
[[ "$BASE" == https://*.workers.dev* ]] || { echo "Give the Worker address deploy.sh printed." >&2; exit 2; }
BASE="${BASE%/}"

stop() { echo "    Stopped: $*" >&2; echo "    Fix that and run the script again; the secrets already set are skipped." >&2; exit 1; }

# Values travel only through pipes. printf is built into bash, so
# `printf '%s' "$value" | …` starts no new process and puts nothing in `ps`.
# (No here-strings either: old bash writes those to a temporary file.)
put() { npx wrangler secret put "$1" ${ENV[@]+"${ENV[@]}"} >/dev/null && echo "    set $1"; }

# Leading and trailing spaces from a paste are dropped.
trim() { local v="$1"; v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"; printf '%s' "$v"; }

# Names of the secrets already set on this Worker (names only, never values).
# A listing that fails must stop the script: read as "nothing set yet", it
# would make a new LICENSE_SECRET over the real one.
listing="$(npx wrangler secret list ${ENV[@]+"${ENV[@]}"} </dev/null 2>/dev/null)" \
  || stop "could not list this Worker's secrets. Is wrangler logged in (npx wrangler login), and was deploy.sh run?"
names="$(printf '%s' "$listing" | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    try {
      const list = JSON.parse(s.slice(s.indexOf("["), s.lastIndexOf("]") + 1));
      if (!Array.isArray(list)) process.exit(1);
      for (const item of list) if (item && typeof item.name === "string") console.log(item.name);
    } catch { process.exit(1); }
  });')" || stop "wrangler's list of secrets was not readable, so it is not safe to go on."
is_set() { printf '%s\n' "$names" | grep -qx "$1"; }

echo "1/5 STRIPE_SECRET_KEY"
if is_set STRIPE_SECRET_KEY; then echo "    already set"; else
  echo "    Paste the restricted key ($KEY_HINT...) from Stripe > Developers > API keys > Create restricted key"
  echo "    (permissions: server/README.md step 5). It will not show on screen."
  read -rs key; echo; key="$(trim "$key")"
  [[ "$key" =~ ^${KEY_HINT}[A-Za-z0-9]{20,}$ ]] \
    || { unset key; stop "that is not a ${KEY_HINT} key. Use a restricted key (README step 5), never the full sk_ secret key. Nothing was stored."; }
  printf '%s' "$key" | put STRIPE_SECRET_KEY; unset key
fi

echo "2/5 OPENAI_API_KEY (the service's own model key)"
if is_set OPENAI_API_KEY; then echo "    already set"; else
  echo "    Paste it (it will not show on screen)."
  read -rs key; echo; key="$(trim "$key")"
  [[ "$key" =~ ^sk-[A-Za-z0-9_-]{20,}$ ]] \
    || { unset key; stop "that does not look like an OpenAI API key (sk-...). Nothing was stored."; }
  printf '%s' "$key" | put OPENAI_API_KEY; unset key
fi

echo "3/5 STRIPE_WEBHOOK_SECRET (makes the Stripe webhook and stores its signing secret)"
HOOK_URL="$BASE/v1/stripe/webhook"
stripe_failed() {
  stop "the Stripe CLI gave no usable answer (the reason is above). STRIPE_WEBHOOK_SECRET was not stored.
    Run 'stripe login' again, or make the webhook by hand in the Dashboard and store its
    whsec_... with: npx wrangler secret put STRIPE_WEBHOOK_SECRET ${ENV[*]+"${ENV[*]}"}  (server/README.md step 6)"
}
if is_set STRIPE_WEBHOOK_SECRET; then echo "    already set"; else
  command -v stripe >/dev/null || stop "the Stripe CLI is not installed (brew install stripe/stripe-cli/stripe), or make the webhook by hand: server/README.md step 6."
  # The Stripe CLI prints an API error as JSON and still exits 0, so its exit
  # code proves nothing. scripts/stripe-answer.js reads every answer instead.
  answer="$(stripe webhook_endpoints list --limit 100 ${STRIPE_MODE[@]+"${STRIPE_MODE[@]}"} </dev/null)" || true
  exists="$(printf '%s' "$answer" | node scripts/stripe-answer.js has-url "$HOOK_URL")" || stripe_failed
  if [[ "$exists" == "yes" ]]; then
    echo "    A webhook for $HOOK_URL already exists, and the API only returns its secret when it is made."
    echo "    Copy its signing secret from Stripe > Developers > Webhooks, then run:"
    echo "    npx wrangler secret put STRIPE_WEBHOOK_SECRET ${ENV[*]+"${ENV[*]}"}"
  else
    events=(checkout.session.completed checkout.session.async_payment_succeeded
      checkout.session.async_payment_failed customer.subscription.created
      customer.subscription.updated customer.subscription.deleted customer.subscription.paused
      customer.subscription.resumed invoice.paid invoice.payment_failed charge.refunded
      charge.dispute.created radar.early_fraud_warning.created)
    args=(-d "url=$HOOK_URL" -d "api_version=2026-08-26.dahlia" -d "description=Grayout $TARGET Worker")
    for e in "${events[@]}"; do args+=(-d "enabled_events[]=$e"); done
    # The answer holds the secret: it stays in a variable, is checked for a
    # real whsec_ value, and only that value is piped into Cloudflare.
    answer="$(stripe webhook_endpoints create "${args[@]}" ${STRIPE_MODE[@]+"${STRIPE_MODE[@]}"} </dev/null)" || true
    secret="$(printf '%s' "$answer" | node scripts/stripe-answer.js secret)" || { unset answer; stripe_failed; }
    unset answer
    printf '%s' "$secret" | put STRIPE_WEBHOOK_SECRET; unset secret
  fi
fi

# A random secret: 48 random bytes as base64 (64 characters, no newline).
random_secret() { openssl rand -base64 48 | tr -d '\n'; }

echo "4/5 DEVICE_SECRET (random)"
if is_set DEVICE_SECRET; then echo "    already set"; else
  value="$(random_secret)"
  [[ ${#value} -ge 32 ]] || stop "openssl did not make a random value."
  printf '%s' "$value" | put DEVICE_SECRET; unset value
fi

echo "5/5 LICENSE_SECRET (random, NEVER change it)"
if is_set LICENSE_SECRET; then echo "    already set"; else
  value="$(random_secret)"
  [[ ${#value} -ge 32 ]] || stop "openssl did not make a random value."
  printf '%s' "$value" | put LICENSE_SECRET
  echo "    Save the line below in your password manager now. It is shown only this once,"
  echo "    and scripts/license-key.js needs it to re-send a lost key:"
  printf '\n    %s\n\n' "$value"
  unset value
  read -r -p "    Press Return once it is saved. " _
fi

echo
echo "Check: $BASE/v1/health  (every \"configured\" flag should say true)"
curl -s "$BASE/v1/health"; echo
