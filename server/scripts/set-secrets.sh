#!/usr/bin/env bash
# Set the 5 secrets a Grayout Worker needs, in one go. Run it AFTER deploy.sh.
#
#   bash scripts/set-secrets.sh sandbox https://grayout-api-sandbox.<you>.workers.dev
#   bash scripts/set-secrets.sh live    https://grayout-api.<you>.workers.dev
#
# You paste 2 keys (Stripe restricted key, OpenAI key). The other 3 are made here
# and go straight into Cloudflare, so no secret is ever saved in a file or a chat.
# Safe to run again: any secret that is already set is skipped (LICENSE_SECRET
# must NEVER change, every customer's key is derived from it).

set -euo pipefail
cd "$(dirname "$0")/.."                       # the server/ folder

TARGET="${1:-}"; BASE="${2:-}"
case "$TARGET" in
  sandbox) ENV=(--env sandbox); STRIPE_MODE=();      KEY_HINT="rk_test_" ;;
  live)    ENV=();              STRIPE_MODE=(--live); KEY_HINT="rk_live_" ;;
  *) echo "Usage: bash scripts/set-secrets.sh sandbox|live https://<worker>.workers.dev" >&2; exit 2 ;;
esac
[[ "$BASE" == https://*.workers.dev* ]] || { echo "Give the Worker address deploy.sh printed." >&2; exit 2; }
BASE="${BASE%/}"

# Names of the secrets already set on this Worker (names only, never values).
already="$(npx wrangler secret list ${ENV[@]+"${ENV[@]}"} 2>/dev/null || echo '[]')"
is_set() { grep -q "\"$1\"" <<<"$already"; }
put()    { npx wrangler secret put "$1" ${ENV[@]+"${ENV[@]}"} >/dev/null && echo "    set $1"; }

echo "1/5 STRIPE_SECRET_KEY"
if is_set STRIPE_SECRET_KEY; then echo "    already set"; else
  echo "    Paste the restricted key ($KEY_HINT...) from Stripe > Developers > API keys > Create restricted key"
  echo "    (permissions: server/README.md step 5). It will not show on screen."
  read -rs key; echo; printf '%s' "$key" | put STRIPE_SECRET_KEY; unset key
fi

echo "2/5 OPENAI_API_KEY (the service's own model key)"
if is_set OPENAI_API_KEY; then echo "    already set"; else
  echo "    Paste it (it will not show on screen)."
  read -rs key; echo; printf '%s' "$key" | put OPENAI_API_KEY; unset key
fi

echo "3/5 STRIPE_WEBHOOK_SECRET (makes the Stripe webhook and stores its signing secret)"
HOOK_URL="$BASE/v1/stripe/webhook"
if is_set STRIPE_WEBHOOK_SECRET; then echo "    already set"
elif stripe webhook_endpoints list --limit 100 ${STRIPE_MODE[@]+"${STRIPE_MODE[@]}"} | grep -q "\"$HOOK_URL\""; then
  echo "    A webhook for $HOOK_URL already exists, and Stripe only shows its secret once."
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
  # Stripe answers with JSON; pull out only the whsec_ secret and pipe it into Cloudflare.
  stripe webhook_endpoints create "${args[@]}" ${STRIPE_MODE[@]+"${STRIPE_MODE[@]}"} \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).secret||""))' \
    | put STRIPE_WEBHOOK_SECRET
fi

echo "4/5 DEVICE_SECRET (random)"
if is_set DEVICE_SECRET; then echo "    already set"; else openssl rand -base64 48 | put DEVICE_SECRET; fi

echo "5/5 LICENSE_SECRET (random, NEVER change it)"
if is_set LICENSE_SECRET; then echo "    already set"; else
  echo "    Save the line below in your password manager now (needed to re-send a lost key):"
  openssl rand -base64 48 | tr -d '\n' | tee /dev/tty | put LICENSE_SECRET; echo
fi

echo
echo "Check: $BASE/v1/health  (every \"configured\" flag should say true)"
curl -s "$BASE/v1/health"; echo
