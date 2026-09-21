## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## Why

<!-- What was wrong, or what fails less for a new user because of this. -->

## Checklist

- [ ] `npm test` and `npm run check` pass locally.
- [ ] New behavior in `src/` has a test in `tests/`, run under plain Node without Electron.
- [ ] Nothing here makes Grayout fire more often or treats an ambiguous screen as leisure (see "Never loosen the prompt for engagement" in CONTRIBUTING.md).
- [ ] Nothing here weakens an escape hatch, the watchdog, the daily cap, or the fail-closed handling of errors.
- [ ] If anything new leaves the user's Mac, `PRIVACY.md` and `docs/privacy.html` are updated in this PR.
- [ ] Copy follows the house style: plain, second person, no exclamation marks, "gray" not "grey"; commands in fenced `bash` blocks.
- [ ] Renderer changes keep the rules: no inline scripts, no `require`, no remote resources, untrusted strings via `textContent`.
- [ ] `CHANGELOG.md` has a line under `[Unreleased]`.

## How I tested it

<!-- Which of the manual gates in scripts/stranger-test.md apply, and what you ran. -->
