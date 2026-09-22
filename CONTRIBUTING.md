# Contributing to Grayout

Thanks for looking. Grayout is a small project with one maintainer, so the bar is: does it make a stranger's first ten minutes fail less, or does it fix something that is wrong. Both are welcome.

Grayout is a paid product built in the open. The app is MIT, the service in `server/` is MIT, and self-hosting on your own API key is a supported path that will not be removed. None of that is in tension with charging for the hosted version, and pull requests are read the same way whether or not you pay for it.

## The two halves

- **`src/`, `ui/`, `main.js`** — the Electron app that runs on someone's Mac. It holds a Grayout license key and talks to the service. It never holds a model key unless someone is self-hosting.
- **`server/`** — the Cloudflare Worker behind `api.grayout.app`. It holds the model key, owns the prompt, checks licenses, counts checks, and talks to Stripe.

[`docs/API-CONTRACT.md`](docs/API-CONTRACT.md) is binding for both, and for the site. Endpoints, payloads, error codes, storage keys, pricing, and the security rules are settled there. A pull request that changes any of them changes that file first, in the same PR, or it does not land.

## Setup

Node 22 (see `.nvmrc`) and the Xcode Command Line Tools for `clang`.

```bash
git clone https://github.com/aarushkandukoori/grayout && cd grayout
npm ci
npm run helper
npm start
```

Running from source uses the same data folder as the packaged app, `~/Library/Application Support/Grayout/`. If you would rather not touch your real settings, point it somewhere else:

```bash
GRAYOUT_USER_DATA=/tmp/grayout-dev npm start
```

Two more environment variables work unpackaged and are ignored by the packaged app: `GRAYOUT_API_BASE` points the app at a service other than production, and `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` supplies a key for the self-hosting path (`provider` set to `anthropic` or `openai`).

The service is its own package:

```bash
npm --prefix server test
npm --prefix server run dev      # wrangler, against your own KV and your own secrets
```

You will need your own Cloudflare account, your own model key, and Stripe test-mode keys to run it. There are no shared credentials and none will be handed out; the production secrets exist only in the Worker secret store.

## Before you open a pull request

```bash
npm test
npm run check
npm --prefix server test
```

`npm test` runs `node --test 'tests/**/*.test.js'` under plain Node, without Electron. Tests must not require `electron` at the top level; go through `src/paths.js`, which resolves the data directory from `GRAYOUT_USER_DATA` when Electron is absent. Every test file sets that variable to a fresh temp directory before requiring any module, and cleans it up.

`npm run check` runs `node --check` on every JavaScript file. CI runs the app's checks and tests plus a packaging smoke test on macOS; run the service's tests yourself before opening a PR that touches `server/`.

Nothing in a test may make a real network call, charge a real card, or touch a real display.

## What a good pull request looks like

- One change per PR, with the reason in the description. Link the issue if there is one.
- New behavior in `src/` or `server/` comes with a test. The loop, analyzer, config, stats, and updates modules are pure and mockable on purpose; keep the Worker's handlers that way too.
- Copy follows the house style: plain, second person, no exclamation marks, "gray" not "grey", no marketing language in the repository. Commands go in fenced `bash` blocks. Never claim a number the project cannot show you the measurement for.
- Product copy talks about Grayout and the subscription. Copy that names Anthropic and OpenAI belongs to the self-hosting sections; do not reintroduce bring-your-own-key framing into the first run.
- Renderer pages keep the rules in `ui/preload/*.js`: no inline scripts, no `require`, no remote resources, a strict CSP, and untrusted strings rendered with `textContent`.
- Anything that changes what leaves the user's Mac, or what the service stores, updates **both** `PRIVACY.md` and `docs/privacy.html` in the same PR, and they stay identical in content.
- Anything that changes the threat model updates `SECURITY.md`.
- Add a line under `[Unreleased]` in `CHANGELOG.md`.

## Never loosen the prompt for engagement

The prompt errs toward "on task" everywhere, and that is the product. A change that makes Grayout fire more often, flag ambiguous screens, or treat a lecture as leisure will not be merged, even if it feels more effective. The cost of a false gray is high and the cost of a missed one is low. If you think the prompt is wrong about a specific category, open an issue with the verdict line and the case for it.

The prompt now lives on the service, which means it can change without anyone installing anything. That makes this rule more important, not less.

## Never let money reach the screen

Billing state and display state are separate systems, and a pull request that couples them will not be merged. An expired trial, a lapsed subscription, an exhausted free taste, a revoked license, a rate limit, and an unreachable service all stop checks and reset the strike counter. None of them may start an alert, hold an existing one, or slow down a restore. "Subscribe to get your color back" is not a growth tactic, it is a hostage situation.

Every escape hatch stays enabled in every billing state, including Restore color now.

## Secrets

No key, token, price id, webhook secret, or license key belongs in this repository, in a test fixture, in a commit message, or in an issue. The model key exists only in the Worker secret store. If you think you have leaked one, say so immediately in a private security report; rotating a key is a five-minute job and hiding one is not.

## Things that will not be merged

- Telemetry, crash reporting, or any call home beyond what `PRIVACY.md` already lists.
- Team, parent, or employer features. Grayout reports to nobody but the person using it.
- A locked or unbypassable mode. Quit stays one click away.
- Weakening any escape hatch, the watchdog, or the fail-closed handling of errors and billing states.
- Anything that makes self-hosting harder, slower, or less documented, including quietly letting it rot.
- Storing images, prompt text, activity phrases, or anything else about what a person was doing, anywhere in the service.
- Fingerprinting a machine to protect the free taste. It is a taste, not a security boundary.
- Dark patterns around cancellation. The billing portal link stays where it is.

## Reporting bugs

Use the issue templates. For a wrong call, paste the verdict line from the dashboard's Copy button and do not attach screenshots. For a stuck gray screen, say which escape hatch worked. For anything about money, use the billing template.

**Never paste a license key, a card number, or an API key into an issue.** A license key posted publicly is treated as compromised and revoked. Nothing needed to diagnose a problem is secret: the request id from a failed call identifies the request without identifying you.

## License

By contributing you agree that your contribution is licensed under the MIT license in `LICENSE`.
