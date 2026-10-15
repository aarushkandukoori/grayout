#!/usr/bin/env bash
# Deploy the Grayout API, doing every step that needs no secret, and then
# print exactly what is left for you to do by hand.
#
# Safe to run again and again: each step checks whether it is already done.
#
# There are two Workers, each with its OWN database (wrangler.jsonc):
#   bash server/scripts/deploy.sh sandbox   # Stripe sandbox, test cards, gry_test_ keys
#   bash server/scripts/deploy.sh live      # real money, the address the app uses
#   bash server/scripts/deploy.sh live --fill-site   # also give the website the address
#   DRY_RUN=1 bash server/scripts/deploy.sh sandbox   # only print what it would do
#
# `live` fills the Worker's address into src/config.js (the app). It leaves
# docs/config.js (the website) alone unless you pass --fill-site, because the
# site may only get the address once a 2.x release is the GitHub "latest"
# release (ORDER MATTERS in docs/config.js): a filled-in site promises free
# checks, and its Download buttons fetch whatever release is latest.
#
# Keeping them apart is what stops a key bought with a test card from ever
# getting real service: the live Worker never sees the sandbox's rows.
#
# It never sets, prints or stores a secret. Secrets are yours to set with
# `npx wrangler secret put …` (the list at the end says which are missing).

set -euo pipefail

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$SERVER_DIR/.." && pwd)"
cd "$SERVER_DIR"

TARGET=""
FILL_SITE=0
for arg in "$@"; do
  case "$arg" in
    --fill-site) FILL_SITE=1 ;;
    live|sandbox) [[ -z "$TARGET" ]] && TARGET="$arg" || TARGET="twice" ;;
    *) TARGET="unknown: $arg" ;;
  esac
done
case "$TARGET" in
  live)
    DB_NAME="grayout"
    DB_PLACEHOLDER="__GRAYOUT_D1_DATABASE_ID__"
    ENV_ARGS=()
    ;;
  sandbox)
    DB_NAME="grayout-sandbox"
    DB_PLACEHOLDER="__GRAYOUT_SANDBOX_D1_DATABASE_ID__"
    ENV_ARGS=(--env sandbox)
    ;;
  *)
    echo "Say which Worker to deploy:" >&2
    echo "    bash scripts/deploy.sh sandbox    (do this first)" >&2
    echo "    bash scripts/deploy.sh live [--fill-site]" >&2
    exit 2
    ;;
esac
if [[ "$TARGET" == "sandbox" ]] && (( FILL_SITE )); then
  echo "--fill-site is only for live: the sandbox address is never written into the public files." >&2
  exit 2
fi
API_PLACEHOLDER="__GRAYOUT_API_BASE__"
SECRETS=(STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET OPENAI_API_KEY DEVICE_SECRET LICENSE_SECRET)
TODO=()

say()  { printf '\n==> %s\n' "$*"; }
todo() { TODO+=("$*"); }
run()  {
  if [[ "${DRY_RUN:-}" == "1" ]]; then printf '    (dry run) %s\n' "$*"; else "$@"; fi
}

# ---------------------------------------------------------------- 1. tools
say "Checking Node"
# The tests use node:sqlite, which works without a flag only from Node 22.13
# (package.json "engines" says the same). On 22.0 to 22.12 they would fail
# with a confusing "module not found", so stop here with a clear message.
node_version="$(node -p 'process.versions.node' 2>/dev/null || echo 0.0.0)"
IFS=. read -r node_major node_minor _ <<<"$node_version"
if (( node_major < 22 || (node_major == 22 && node_minor < 13) )); then
  echo "Node 22.13 or newer is needed (you have $(node --version 2>/dev/null || echo none))." >&2
  echo "Install the current LTS from https://nodejs.org, then run this script again." >&2
  exit 1
fi

# --fill-site: the site may get the address only once a 2.x release is the
# GitHub "latest" release (ORDER MATTERS in docs/config.js). Checked first, so
# nothing is deployed on a run that would break that order. Fails closed: if
# GitHub does not answer, nothing is filled.
if (( FILL_SITE )); then
  say "Checking that a 2.x release is the GitHub \"latest\" release (--fill-site)"
  if [[ "${DRY_RUN:-}" == "1" ]]; then
    echo "    (dry run) would stop here unless the latest release of aarushkandukoori/grayout is 2.x or newer"
  else
    latest="$(curl -fsS --max-time 20 https://api.github.com/repos/aarushkandukoori/grayout/releases/latest 2>/dev/null \
      | node -e 'let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
          try { console.log(JSON.parse(s).tag_name || ""); } catch { console.log(""); }
        });' || true)"
    major="$(sed -E -n 's/^v?([0-9]+)\..*/\1/p' <<<"$latest")"
    if [[ -z "$major" || "$major" -lt 2 ]]; then
      echo "STOP: the GitHub \"latest\" release is '${latest:-unknown}', not 2.x. Publish the 2.x release first," >&2
      echo "then run: bash scripts/deploy.sh live --fill-site   (without --fill-site, only the app gets the address)" >&2
      exit 1
    fi
    echo "    latest release: $latest"
  fi
fi

say "Installing packages"
run npm ci --no-audit --no-fund

say "Running the tests (nothing is deployed if they fail)"
run npm test

# ---------------------------------------------------------------- 2. Cloudflare login
say "Checking you are logged in to Cloudflare"
if [[ "${DRY_RUN:-}" != "1" ]] && ! npx wrangler whoami >/dev/null 2>&1; then
  echo "Not logged in. Run this once, then run this script again:" >&2
  echo "    cd server && npx wrangler login" >&2
  exit 1
fi

# ---------------------------------------------------------------- 3. the database
say "Deploying the $TARGET Worker. Database '$DB_NAME'"
db_id_of() {
  # Prints the database id, or nothing if the database does not exist.
  npx wrangler d1 list --json 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      try { const db = JSON.parse(s).find(d => d.name === process.argv[1]); if (db) console.log(db.uuid); } catch {}
    });' "$DB_NAME"
}
if grep -q "$DB_PLACEHOLDER" wrangler.jsonc; then
  db_id=""
  [[ "${DRY_RUN:-}" == "1" ]] || db_id="$(db_id_of)"
  if [[ -z "$db_id" ]]; then
    run npx wrangler d1 create "$DB_NAME" --no-update-config
    [[ "${DRY_RUN:-}" == "1" ]] || db_id="$(db_id_of)"
  fi
  if [[ "${DRY_RUN:-}" == "1" ]]; then
    echo "    (dry run) would write the database id into wrangler.jsonc"
  elif [[ -z "$db_id" ]]; then
    echo "Could not find the id of database '$DB_NAME'. Run: npx wrangler d1 list" >&2
    exit 1
  else
    # Write the id over the placeholder (the only edit this script makes to wrangler.jsonc).
    node -e '
      const fs = require("fs"); const f = "wrangler.jsonc";
      fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(process.argv[1], process.argv[2]));
    ' "$DB_PLACEHOLDER" "$db_id"
    echo "    wrote the database id into wrangler.jsonc"
    todo "Commit server/wrangler.jsonc (it now holds the database id; ids are not secret)."
  fi
else
  echo "    already set in wrangler.jsonc"
fi

say "Applying database migrations (only new ones run)"
run npx wrangler d1 migrations apply "$DB_NAME" --remote ${ENV_ARGS[@]+"${ENV_ARGS[@]}"}

# ---------------------------------------------------------------- 4. deploy
say "Deploying the Worker"
api_base=""
if [[ "${DRY_RUN:-}" == "1" ]]; then
  echo "    (dry run) npx wrangler deploy ${ENV_ARGS[*]+"${ENV_ARGS[*]}"}"
else
  deploy_log="$(mktemp)"
  npx wrangler deploy ${ENV_ARGS[@]+"${ENV_ARGS[@]}"} 2>&1 | tee "$deploy_log"
  api_base="$(grep -Eo 'https://[A-Za-z0-9.-]+\.workers\.dev' "$deploy_log" | head -n 1 || true)"
  rm -f "$deploy_log"
fi

# ---------------------------------------------------------------- 5. fill in the API address
# check_csp ADDRESS: every site page that calls the API must allow ADDRESS in
# its CSP connect-src, or the browser blocks it (success.html could never show
# a buyer their key). Prints each problem; returns non-zero if there is one.
check_csp() {
  node "$SERVER_DIR/scripts/check-csp.js" "$REPO_DIR/docs" "$1"
}

if [[ "$TARGET" == "sandbox" ]]; then
  # The repo is public. The public files must keep pointing at the LIVE API,
  # so the sandbox address is printed, never written into them.
  if [[ -n "$api_base" ]]; then
    say "Sandbox API address: $api_base"
    check_csp "$api_base" || echo "    (the site pages above would block this address; fine for app-only sandbox tests)"
  fi
  todo "Test against the sandbox from the app (apiBase in its config.json, or GRAYOUT_API_BASE when running it with npm start) or a local copy of the site. Do NOT commit the sandbox address into src/config.js or docs/config.js."
else
  # The app gets the address now. The site only with --fill-site (see the top).
  files=("$REPO_DIR/src/config.js")
  if (( FILL_SITE )); then files+=("$REPO_DIR/docs/config.js" "$REPO_DIR"/docs/*.html); fi
  say "Filling in the API address${api_base:+: $api_base}"
  if [[ -n "$api_base" ]]; then
    changed=()
    for f in "${files[@]}"; do
      [[ -f "$f" ]] && grep -q "$API_PLACEHOLDER" "$f" || continue
      # Only the one assignment line in each config.js, and only CSP lines in
      # the HTML pages. Any other mention of the placeholder is left alone.
      node -e '
        const fs = require("fs"); const [f, from, to] = process.argv.slice(1);
        const wanted = /(DEFAULT_API_BASE|window\.GRAYOUT_API_BASE)\s*=|connect-src/;
        const text = fs.readFileSync(f, "utf8");
        const next = text.split("\n").map(l => wanted.test(l) ? l.split(from).join(to) : l).join("\n");
        if (next !== text) { fs.writeFileSync(f, next); process.exit(0); } else process.exit(3);
      ' "$f" "$API_PLACEHOLDER" "$api_base" && changed+=("${f#"$REPO_DIR"/}") || true
    done
    if (( ${#changed[@]} )); then
      echo "    filled it into: ${changed[*]}"
      if (( FILL_SITE )); then
        todo "Commit and push ${changed[*]} (they now point at $api_base), then publish the site and rebuild the app."
      else
        todo "Commit ${changed[*]} (it now points at $api_base) and rebuild the app."
      fi
    else
      echo "    no file still had the placeholder"
    fi
  elif [[ "${DRY_RUN:-}" == "1" ]]; then
    echo "    (dry run) would fill the Worker's address into src/config.js"
    if (( FILL_SITE )); then
      echo "    (dry run) would also fill it into docs/config.js and the connect-src lines of docs/*.html"
    fi
  else
    todo "Find your API address (Cloudflare → Workers & Pages → grayout-api) and put it in src/config.js in place of $API_PLACEHOLDER, then run: node scripts/check-csp.js ../docs <address>"
  fi
  if (( ! FILL_SITE )); then
    echo "    left docs/config.js alone: the site gets the address only after a 2.x release is the GitHub \"latest\" release"
    todo "Once a 2.x release is the GitHub \"latest\" release (not before), run: bash scripts/deploy.sh live --fill-site  (it gives docs/config.js the address; see ORDER MATTERS there)."
  fi

  # Whatever form the pages use (the placeholder, the exact address, or
  # https://*.workers.dev), the result must let the site reach the API.
  # Without --fill-site the site makes no calls yet, so a problem is a to-do
  # for before --fill-site; with it, the deploy stops.
  csp_address="${api_base:-https://grayout-api.example.workers.dev}"
  if [[ -n "$api_base" || "${DRY_RUN:-}" == "1" ]]; then
    say "Checking the site's CSP allows $csp_address"
    if check_csp "$csp_address"; then
      echo "    every page that calls the API allows it"
    elif (( FILL_SITE )) && [[ "${DRY_RUN:-}" != "1" ]]; then
      echo "STOP: the site pages above would block the API, so website buyers could not get their key." >&2
      echo "Fix each page's connect-src (docs/*.html), then run this script again." >&2
      exit 1
    else
      todo "Fix each site page's connect-src listed above (docs/*.html) before running deploy.sh live --fill-site: those pages would block the API."
    fi
  fi
fi

# ---------------------------------------------------------------- 6. what is still missing
say "Checking which secrets are set (names only, never values)"
if [[ "${DRY_RUN:-}" == "1" ]]; then
  missing=("${SECRETS[@]}")
else
  present="$(npx wrangler secret list ${ENV_ARGS[@]+"${ENV_ARGS[@]}"} 2>/dev/null || echo '[]')"
  missing=()
  for name in "${SECRETS[@]}"; do
    grep -q "\"$name\"" <<<"$present" || missing+=("$name")
  done
fi
for name in ${missing[@]+"${missing[@]}"}; do
  todo "Set the secret: cd server && npx wrangler secret put $name ${ENV_ARGS[*]+"${ENV_ARGS[*]}"}  (README steps 5 to 7 say what goes in it)"
done

if [[ -n "$api_base" ]]; then
  say "Health check"
  curl -fsS "$api_base/v1/health" || echo "    (the health check did not answer yet; try again in a minute)"
  echo
fi

# This Worker's own settings: the top-level vars for live, env.sandbox.vars
# for the sandbox. One Worker's value never counts for the other.
var_of() { node "$SERVER_DIR/scripts/wrangler-var.js" "$TARGET" "$1"; }
if [[ "$TARGET" == "live" ]]; then vars_where="the top-level \"vars\""; else vars_where="\"env\" → \"sandbox\" → \"vars\""; fi
if [[ -z "$(var_of SUPPORT_EMAIL)" ]]; then
  todo "Put your support email in SUPPORT_EMAIL in $vars_where of server/wrangler.jsonc (the $TARGET Worker's own copy), then run this script again."
fi
if [[ "$TARGET" == "live" ]] && [[ -z "$(var_of STRIPE_PRODUCT)" || -z "$(var_of STRIPE_PRICE_MONTHLY)" || -z "$(var_of STRIPE_PRICE_YEARLY)" ]]; then
  todo "Put the LIVE prod_… and both live price_… ids in the top-level vars of server/wrangler.jsonc (until then the live Worker sells nothing)."
fi

# ---------------------------------------------------------------- 7. the list
cat <<EOF

==> Done with everything that needs no secret.

What is left for you (README.md, "Deploying it, from nothing", has the details):
EOF
i=1
for item in ${TODO[@]+"${TODO[@]}"}; do printf '  %d. %s\n' "$i" "$item"; i=$((i + 1)); done
cat <<EOF
  $i. In Stripe (sandbox first, then live), if not done yet:
     - Settings → Managed Payments: activate it.
     - Radar: turn on free-trial abuse protection (docs.stripe.com/radar/free-trial-abuse), if Managed Payments offers it.
     - Developers → Webhooks → Add endpoint: ${api_base:-https://<this Worker>.<subdomain>.workers.dev}/v1/stripe/webhook
       API version 2026-08-26.dahlia, and exactly these 13 events:
       checkout.session.completed, checkout.session.async_payment_succeeded,
       checkout.session.async_payment_failed, customer.subscription.created,
       customer.subscription.updated, customer.subscription.deleted,
       customer.subscription.paused, customer.subscription.resumed,
       invoice.paid, invoice.payment_failed, charge.refunded, charge.dispute.created,
       radar.early_fraud_warning.created
       Then: npx wrangler secret put STRIPE_WEBHOOK_SECRET ${ENV_ARGS[*]+"${ENV_ARGS[*]}"}  (the whsec_… it shows)
     - A restricted key (README lists its permissions): npx wrangler secret put STRIPE_SECRET_KEY ${ENV_ARGS[*]+"${ENV_ARGS[*]}"}
       (sandbox Worker: an rk_test_ key; live Worker: an rk_live_ key)
  $((i + 1)). Open ${api_base:-<your API address>}/v1/health: every "configured" flag must say true.
EOF
