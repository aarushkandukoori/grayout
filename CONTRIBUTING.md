# Contributing to Grayout

Thanks for looking. Grayout is a small project with one maintainer, so the bar is: does it make a stranger's first ten minutes fail less, or does it fix something that is wrong. Both are welcome.

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

A developer running from source may set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in the environment instead of saving a key.

## Before you open a pull request

```bash
npm test
npm run check
```

`npm test` runs `node --test 'tests/**/*.test.js'` under plain Node, without Electron. Tests must not require `electron` at the top level; go through `src/paths.js`, which resolves the data directory from `GRAYOUT_USER_DATA` when Electron is absent. Every test file sets that variable to a fresh temp directory before requiring any module, and cleans it up.

`npm run check` runs `node --check` on every JavaScript file. CI runs both plus a packaging smoke test on macOS.

## What a good pull request looks like

- One change per PR, with the reason in the description. Link the issue if there is one.
- New behavior in `src/` comes with a test in `tests/`. The loop, analyzer, config, stats, pricing, and updates modules are pure and mockable on purpose.
- Copy follows the house style: plain, second person, no exclamation marks, "gray" not "grey", no marketing language. Commands go in fenced `bash` blocks.
- Renderer pages keep the rules in `ui/preload/*.js`: no inline scripts, no `require`, no remote resources, untrusted strings rendered with `textContent`.
- Anything that changes what leaves the user's Mac updates `PRIVACY.md` and `docs/privacy.html` in the same PR. Copy that names a provider names both (Anthropic and OpenAI) or neither, unless the point is provider-specific.
- Add a line under `[Unreleased]` in `CHANGELOG.md`.

## Never loosen the prompt for engagement

The prompt in `src/analyzer.js` errs toward "on task" everywhere, and that is the product. A change that makes Grayout fire more often, flag ambiguous screens, or treat a lecture as leisure will not be merged, even if it feels more effective. The cost of a false gray is high and the cost of a missed one is low. If you think the prompt is wrong about a specific category, open an issue with the verdict line and the case for it.

## Things that will not be merged

- Telemetry, crash reporting, or any call home.
- Team, parent, or employer features. Grayout reports to nobody but the person using it.
- A locked or unbypassable mode. Quit stays one click away.
- Weakening any escape hatch, the watchdog, or the fail-closed handling of errors.
- A hosted price on the site. The hosted plan is a document in `docs/hosted-plan.md` until it exists.

## Reporting bugs

Use the issue templates. For a wrong call, paste the verdict line from the dashboard's Copy button and do not attach screenshots. For a stuck gray screen, say which escape hatch worked.

## License

By contributing you agree that your contribution is licensed under the MIT license in `LICENSE`.
