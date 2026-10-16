'use strict';
// The Claude CLI engine: binary lookup, the exact argv and env it runs with,
// stream-json parsing and error kinds, and real spawns of a fake `claude`
// (tests/fixtures/fake-claude.js) that records what it received on stdin.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const helpers = require('./helpers');

const dir = helpers.freshUserData('cli');
const claudecli = require('../src/claudecli');
const analyzer = require('../src/analyzer');
const { analyze, analyzeViaCli, readCliResult, classifyCliFailure, classifyApiError, buildPromptText } = analyzer;
const channel = require('../src/channel');

// The CLI engine exists only in the personal build (src/channel.js). Most of
// this file tests the engine itself, so it runs as that build. The public
// builds' refusal has describe blocks of its own at the end.
channel._setPersonalForTests(true);

after(() => helpers.cleanup(dir));

const FIXTURE = path.join(helpers.FIXTURES, 'fake-claude.js');
const HOUR = 3600000;

const recordPath = name => path.join(dir, `record-${name}.json`);
const readRecord = name => JSON.parse(fs.readFileSync(recordPath(name), 'utf8'));

/**
 * An executable `claude` (in a folder of its own) that runs the fake under
 * this node in `mode`, recording to record-<tag>.json. The mode is set in the
 * shim: Grayout does not pass the parent's env through to the child.
 */
function makeShim(mode = 'ok', tag = mode, name = 'claude') {
  const folder = path.join(dir, `bin-${tag}`);
  fs.mkdirSync(folder, { recursive: true });
  const p = path.join(folder, name);
  fs.writeFileSync(p, `#!/bin/sh\nFAKE_CLAUDE_MODE='${mode}' FAKE_CLAUDE_RECORD='${recordPath(tag)}' exec "${process.execPath}" "${FIXTURE}" "$@"\n`, { mode: 0o755 });
  return p;
}
const SHIM = makeShim('ok', 'resolve');

/** Set env vars for one test and put them back afterwards. */
function withEnv(t, vars) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
}

const ctxOf = (over = {}) => ({
  screenshotsB64: ['U0NSRUVOMA==', 'U0NSRUVOMQ=='], webcamB64: 'V0VCQ0FN', workDescription: 'writing a thesis',
  canvasTasks: [], fileTasks: [], frontApp: 'Code', apiKey: null, ...over
});
const cliCfg = (mode, tag = mode, name) => ({ engine: 'cli', cliPath: makeShim(mode, tag, name), model: 'claude-haiku-4-5' });

describe('binary resolution', () => {
  test('candidates: ~/.local/bin, then Homebrew, then /usr/local', () => {
    assert.deepEqual(claudecli.candidates('/Users/x'), ['/Users/x/.local/bin/claude', '/opt/homebrew/bin/claude', '/usr/local/bin/claude']);
  });

  test('isExecutableFile: absolute, a regular file, executable', () => {
    const plain = path.join(dir, 'not-executable');
    fs.writeFileSync(plain, 'x', { mode: 0o644 });
    assert.equal(claudecli.isExecutableFile(SHIM), true);
    assert.equal(claudecli.isExecutableFile(plain), false, 'no x bit');
    assert.equal(claudecli.isExecutableFile(dir), false, 'a directory');
    assert.equal(claudecli.isExecutableFile('claude'), false, 'relative');
    assert.equal(claudecli.isExecutableFile(path.relative(process.cwd(), SHIM)), false, 'relative, even if it exists');
    assert.equal(claudecli.isExecutableFile(path.join(dir, 'missing')), false);
    assert.equal(claudecli.isExecutableFile(`${SHIM}\0`), false);
    for (const bad of ['', null, undefined, 42, {}, []]) assert.equal(claudecli.isExecutableFile(bad), false, String(bad));
  });

  test('resolveBinary: cliPath wins; otherwise the first candidate that exists', () => {
    const missing = path.join(dir, 'nope', 'claude');
    const second = makeShim('ok', 'second');
    assert.equal(claudecli.resolveBinary({ cliPath: SHIM }, [second]), SHIM);
    assert.equal(claudecli.resolveBinary({ cliPath: ` ${SHIM} ` }, [second]), SHIM, 'trimmed');
    assert.equal(claudecli.resolveBinary({ cliPath: '' }, [missing, second, SHIM]), second);
    assert.equal(claudecli.resolveBinary({}, [missing, SHIM]), SHIM);
  });

  test('resolveBinary: nothing found → cli_missing with an actionable message', () => {
    const missing = path.join(dir, 'nope', 'claude');
    assert.throws(() => claudecli.resolveBinary({ cliPath: '' }, [missing]), e =>
      e.kind === 'cli_missing' && /Claude CLI not found/.test(e.message) && /claude auth login/.test(e.message) && /cliPath/.test(e.message));
    assert.throws(() => claudecli.resolveBinary({ cliPath: missing }, [SHIM]), e =>
      e.kind === 'cli_missing' && e.message.includes(missing), 'a set cliPath that vanished is an error, not a silent switch');
    assert.equal(classifyApiError(Object.assign(new Error('x'), { kind: 'cli_missing' })).kind, 'cli_missing');
  });

  test('resolveBinary: a ~/ cliPath is expanded; a relative one is an error naming it', () => {
    const home = path.dirname(path.dirname(SHIM)); // SHIM is <home>/bin-resolve/claude
    assert.equal(claudecli.resolveBinary({ cliPath: '~/bin-resolve/claude' }, [], home), SHIM);
    assert.equal(claudecli.expandHome('~/x/claude', '/Users/x'), '/Users/x/x/claude');
    assert.equal(claudecli.expandHome(' /opt/claude ', '/Users/x'), '/opt/claude');
    assert.equal(claudecli.expandHome('~other/claude', '/Users/x'), '~other/claude', 'only the current user\'s ~/');
    assert.throws(() => claudecli.resolveBinary({ cliPath: '~/nope/claude' }, [SHIM], home), e => e.kind === 'cli_missing' && e.message.includes('~/nope/claude'));
    for (const rel of ['claude', './claude', 'bin/claude', '~other/claude']) {
      assert.throws(() => claudecli.resolveBinary({ cliPath: rel }, [SHIM], home), e => e.kind === 'cli_missing' && e.message.includes(rel) && /full path/.test(e.message), rel);
    }
  });

  test('loginHelp: claude auth login for a plain claude; a wrapper gets its own advice', () => {
    assert.deepEqual(claudecli.loginHelp('/opt/homebrew/bin/claude'), { command: 'claude auth login', text: 'run claude auth login in Terminal' });
    assert.deepEqual(claudecli.loginHelp(undefined), claudecli.loginHelp('/x/claude'));
    const fo = claudecli.loginHelp('/Users/x/Projects/claude-failover/bin/claude-failover');
    assert.equal(fo.command, 'claude-accounts status');
    assert.match(fo.text, /claude-accounts login <account>/);
    assert.doesNotMatch(fo.text, /claude auth login/, '`auth` through the wrapper logs in its default account, maybe not the one checks use');
    assert.deepEqual(claudecli.loginHelp('/usr/local/bin/my-claude'), { command: null, text: "log my-claude's account back in" });
  });

  test('workDir: an empty folder of Grayout\'s own under the given root', () => {
    const w = claudecli.workDir(dir);
    assert.equal(w, path.join(dir, 'grayout-claude-cwd'));
    assert.equal(fs.statSync(w).isDirectory(), true);
    assert.equal(helpers.fileMode(w), 0o700);
    assert.equal(claudecli.workDir(dir), w, 'reused');
    const file = path.join(dir, 'not-a-dir');
    fs.writeFileSync(file, 'x');
    assert.equal(claudecli.workDir(file), file, 'falls back to the root when it cannot be made');
  });

  test('cliModel: config.model when it is a claude-* model, else Haiku', () => {
    assert.equal(claudecli.cliModel({ model: 'claude-sonnet-4-6' }), 'claude-sonnet-4-6');
    assert.equal(claudecli.cliModel({ model: 'gpt-5-mini' }), 'claude-haiku-4-5');
    assert.equal(claudecli.cliModel({}), 'claude-haiku-4-5');
    assert.equal(claudecli.cliModel(null), 'claude-haiku-4-5');
  });
});

describe('argv (security-critical)', () => {
  const argv = claudecli.args('claude-haiku-4-5');
  const after = flag => { const i = argv.indexOf(flag); assert.notEqual(i, -1, `${flag} present`); return argv[i + 1]; };

  test('no tools, no MCP, no slash commands, no settings files, no saved session', () => {
    assert.equal(after('--tools'), '', '--tools ""');
    assert.ok(argv.includes('--strict-mcp-config'), 'without it the account\'s claude.ai connectors load');
    assert.ok(argv.includes('--no-session-persistence'), 'a transcript would keep every screenshot');
    assert.ok(argv.includes('--disable-slash-commands'));
    assert.equal(after('--setting-sources'), '', '--setting-sources ""');
    const settings = JSON.parse(after('--settings'));
    assert.deepEqual(settings, { disableAllHooks: true, alwaysThinkingEnabled: false, autoMemoryEnabled: false },
      'autoMemoryEnabled: --setting-sources "" alone still loads a MEMORY.md for the cwd');
  });

  test('print mode, stream-json both ways, the model and a short system prompt', () => {
    assert.equal(argv[0], '-p');
    assert.equal(after('--input-format'), 'stream-json');
    assert.equal(after('--output-format'), 'stream-json');
    assert.ok(argv.includes('--verbose'), 'stream-json output requires --verbose under -p');
    assert.equal(after('--model'), 'claude-haiku-4-5');
    assert.equal(after('--system-prompt'), claudecli.SYSTEM_PROMPT);
    assert.ok(claudecli.SYSTEM_PROMPT.length < 300);
    assert.equal(argv.some(a => /Read/.test(a)), false, 'nothing asks for a Read tool');
  });

  test('exact argv, so any change to it is deliberate', () => {
    assert.deepEqual(argv, [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
      '--model', 'claude-haiku-4-5', '--tools', '', '--strict-mcp-config', '--disable-slash-commands',
      '--setting-sources', '', '--settings', '{"disableAllHooks":true,"alwaysThinkingEnabled":false,"autoMemoryEnabled":false}',
      '--system-prompt', claudecli.SYSTEM_PROMPT
    ]);
  });
});

// Everything that would change which account or endpoint answers, or bill per token.
const HOSTILE_ENV = {
  ANTHROPIC_API_KEY: 'sk-ant-nope', ANTHROPIC_AUTH_TOKEN: 'tok', OPENAI_API_KEY: 'sk-proj-nope',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_BEDROCK_BASE_URL: 'http://x', ANTHROPIC_VERTEX_PROJECT_ID: 'p',
  ANTHROPIC_MODEL: 'claude-opus-x', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_FOUNDRY: '1',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth', CLAUDE_CONFIG_DIR: '/tmp/other-account', CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
  CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_FAILOVER_ACCOUNT: 'someone', CLAUDE_FAILOVER_CONFIG: '/tmp/c.json',
  NODE_OPTIONS: '--require /tmp/evil.js', DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib', GRAYOUT_DEV_ENGINE: 'cli'
};

describe('child env', () => {
  test('an allowlist: account, endpoint and billing selectors never reach the CLI', () => {
    const base = {
      HOME: '/Users/x', USER: 'x', LOGNAME: 'x', SHELL: '/bin/zsh', PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: '/tmp/x',
      LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', __CF_USER_TEXT_ENCODING: '0x1F5:0:0', HTTPS_PROXY: 'http://proxy:3128', no_proxy: 'localhost',
      ...HOSTILE_ENV
    };
    const env = claudecli.env(base, '/Users/x');
    for (const k of Object.keys(HOSTILE_ENV)) assert.equal(k in env, false, k);
    assert.deepEqual(Object.keys(env).sort(), [
      'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CODE_MAX_RETRIES', 'CLAUDE_FAILOVER_ONESHOT_STDIN',
      'HOME', 'HTTPS_PROXY', 'LANG', 'LC_ALL', 'LOGNAME', 'PATH', 'SHELL', 'TMPDIR', 'USER', '__CF_USER_TEXT_ENCODING', 'no_proxy'
    ]);
    assert.equal(env.USER, 'x');
    assert.equal(env.TMPDIR, '/tmp/x');
    assert.equal(env.HTTPS_PROXY, 'http://proxy:3128');
    assert.equal(base.ANTHROPIC_API_KEY, 'sk-ant-nope', 'the caller\'s env is not mutated');
  });

  test('fixed settings: no telemetry, no auto-memory, few retries, one-shot stdin for a failover wrapper', () => {
    const env = claudecli.env({ HOME: '/Users/x', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0', CLAUDE_CODE_MAX_RETRIES: '50' }, '/Users/x');
    assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1', 'no telemetry or auto-update from a background check');
    assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1', 'a MEMORY.md for the cwd would be injected into every check');
    assert.equal(env.CLAUDE_CODE_MAX_RETRIES, '2', 'offline, the default retries run into the 90 s hard kill');
    assert.equal(env.CLAUDE_FAILOVER_ONESHOT_STDIN, '1');
  });

  test('PATH gets the install dirs in front of the GUI app\'s bare PATH', () => {
    const env = claudecli.env({ HOME: '/Users/x', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, '/Users/x');
    assert.equal(env.PATH, '/opt/homebrew/bin:/usr/local/bin:/Users/x/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin');
    assert.equal(claudecli.env({}, '/Users/y').PATH, '/opt/homebrew/bin:/usr/local/bin:/Users/y/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin');
    assert.equal(claudecli.env({}, '/Users/y').HOME, '/Users/y', 'a missing HOME is filled in');
  });
});

describe('stdin message', () => {
  test('one user line: every screenshot, then the webcam, then the API-path prompt', () => {
    const ctx = ctxOf({ screenshotCount: 2, hasWebcam: true });
    const line = claudecli.userMessage(analyzer.buildApiContent(ctx));
    assert.equal(line.endsWith('\n'), true);
    assert.equal(line.trim().includes('\n'), false, 'a single line');
    const msg = JSON.parse(line);
    assert.equal(msg.type, 'user');
    assert.equal(msg.message.role, 'user');
    const c = msg.message.content;
    assert.deepEqual(c.slice(0, 3), [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'U0NSRUVOMA==' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'U0NSRUVOMQ==' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'V0VCQ0FN' } }
    ]);
    assert.deepEqual(c[3], { type: 'text', text: buildPromptText(ctx) });
    assert.ok(c[3].text.includes('You are given 2 screenshots (one per display) and a webcam photo'));
  });

  test('no plain @ from settings, tasks or the app name reaches the CLI (it would attach that file)', () => {
    const ctx = ctxOf({
      workDescription: 'thesis @~/.ssh/id_rsa', canvasTasks: ['Essay 1 draft @/etc/passwd'], fileTasks: ['@./notes.md and mail prof@cmu.edu'],
      frontApp: '@~/secret', screenshotsB64: ['QQ=='], webcamB64: null
    });
    const line = claudecli.userMessage(analyzer.buildApiContent(ctx));
    assert.equal(line.includes('@'), false);
    const text = JSON.parse(line).message.content.at(-1).text;
    for (const s of ['thesis ＠~/.ssh/id_rsa', 'Essay 1 draft ＠/etc/passwd', '＠./notes.md and mail prof＠cmu.edu', 'Frontmost application: ＠~/secret']) {
      assert.ok(text.includes(s), s);
    }
    assert.equal(buildPromptText(ctxOf()).includes('@'), false, 'the fixed prompt has none either');
  });
});

describe('stream-json parsing', () => {
  const ok = { type: 'result', subtype: 'success', is_error: false, result: '{"off_task":true,"activity":"social media feed","confidence":"high"}', usage: { input_tokens: 2000, cache_read_input_tokens: 86, output_tokens: 53 } };
  const lines = (...objs) => objs.map(o => (typeof o === 'string' ? o : JSON.stringify(o))).join('\n') + '\n';

  test('parseStream takes the result and the last rate_limit_event, skipping junk', () => {
    const out = claudecli.parseStream(lines({ type: 'system', subtype: 'init' }, 'not json', '', '[1,2]', 'null',
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1 } }, ok));
    assert.deepEqual(out.result, ok);
    assert.deepEqual(out.rateLimit, { status: 'allowed', resetsAt: 1 });
    assert.deepEqual(out.junk, ['not json']);
    assert.deepEqual(claudecli.parseStream(''), { result: null, rateLimit: null, junk: [] });
    assert.deepEqual(claudecli.parseStream(undefined), { result: null, rateLimit: null, junk: [] });
  });

  test('readCliResult: success → verdict, folded usage, model, provider', () => {
    const r = readCliResult(lines({ type: 'system' }, ok), '', 0, 'claude-haiku-4-5');
    assert.deepEqual(r, {
      verdict: { off_task: true, activity: 'social media feed', confidence: 'high' },
      usage: { input_tokens: 2086, output_tokens: 53 }, model: 'claude-haiku-4-5', provider: 'claude-cli'
    });
  });

  test('readCliResult: a check billed as overage is marked, with when the plan limit resets', () => {
    const r = readCliResult(lines({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1792011600, overageStatus: 'allowed', isUsingOverage: true } }, ok), '', 0, 'claude-haiku-4-5');
    assert.equal(r.usage.overage, true);
    assert.deepEqual(r.overage, { resetsAt: 1792011600000 });
    assert.deepEqual(r.verdict, { off_task: true, activity: 'social media feed', confidence: 'high' }, 'the paid-for verdict is still used');
    const r2 = readCliResult(lines({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', overageInUse: true } }, ok), '', 0, 'm');
    assert.deepEqual(r2.overage, { resetsAt: null });
    const inPlan = readCliResult(lines({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', overageStatus: 'allowed', isUsingOverage: false, resetsAt: 1 } }, ok), '', 0, 'm');
    assert.equal('overage' in inPlan, false, 'overage merely allowed is not overage in use');
    assert.equal('overage' in inPlan.usage, false);
  });

  test('readCliResult: is_error → a classified throw, even with exit 0', () => {
    const err = { ...ok, is_error: true, result: "There's an issue with the selected model (claude-x). It may not exist or you may not have access to it." };
    assert.throws(() => readCliResult(lines(err), '', 0, 'claude-x'), e => e.kind === 'bad_model' && /selected model/.test(e.message));
  });

  test('readCliResult: missing result → throws with stderr or the exit code', () => {
    assert.throws(() => readCliResult(lines({ type: 'system' }), 'Error: boom\n', 2, 'm'), e => e.kind === 'unknown' && /boom/.test(e.message));
    assert.throws(() => readCliResult('', '', 1, 'm'), e => /exited \(code 1\) without a result/.test(e.message));
    assert.throws(() => readCliResult('plain text failure\n', '', 1, 'm'), e => /plain text failure/.test(e.message));
  });

  test('readCliResult: a result with no JSON verdict throws', () => {
    assert.throws(() => readCliResult(lines({ ...ok, result: 'I cannot tell.' }), '', 0, 'm'), /no JSON in model output/);
    assert.throws(() => readCliResult(lines({ ...ok, result: null }), '', 0, 'm'));
  });

  test('error_during_execution with an errors array', () => {
    const r = { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['API Error: 529 Overloaded'] };
    assert.throws(() => readCliResult(lines(r), '', 1, 'm'), e => e.kind === 'overloaded');
  });
});

describe('classifyCliFailure', () => {
  const NOW = new Date(2026, 9, 14, 13, 0, 0).getTime(); // Oct 14, 1:00 pm local

  test('usage limits → rate_limited with limit:true, resetsAt (epoch ms) and retryAfter (seconds) when readable', () => {
    const epoch = Math.floor(NOW / 1000) + 2 * 3600;
    const a = classifyCliFailure(`Claude AI usage limit reached|${epoch}`, { now: NOW });
    assert.equal(a.kind, 'rate_limited');
    assert.equal(a.limit, true);
    assert.equal(a.resetsAt, epoch * 1000);
    assert.equal(a.retryAfter, 2 * 3600, 'seconds from now: the unit the hosted service uses for retryAfter');

    const b = classifyCliFailure("You've hit your limit · resets 3pm (America/New_York)", { now: NOW });
    assert.equal(b.kind, 'rate_limited');
    assert.equal(b.limit, true);
    assert.equal(b.resetsAt, new Date(2026, 9, 14, 15, 0, 0).getTime());
    assert.equal(b.retryAfter, 2 * 3600);

    const c = classifyCliFailure('Session limit reached ∙ resets 11pm', { now: NOW });
    assert.equal(c.kind, 'rate_limited');
    assert.equal(c.limit, true);
    assert.equal(c.retryAfter, 10 * 3600);

    const d = classifyCliFailure('You’ve reached your weekly limit', { now: NOW });
    assert.equal(d.kind, 'rate_limited');
    assert.equal(d.resetsAt, null, 'no reset time in the text');
    assert.equal(d.retryAfter, null);

    const past = classifyCliFailure(`Claude AI usage limit reached|${Math.floor(NOW / 1000) - 60}`, { now: NOW });
    assert.equal(past.retryAfter, null, 'a reset already behind us is nothing to wait for');
  });

  test('a rejected rate_limit_event or api_error marks a limit even with odd text', () => {
    const at = Math.floor(NOW / 1000) + 600;
    const a = classifyCliFailure('something', { rateLimit: { status: 'rejected', resetsAt: at }, now: NOW });
    assert.deepEqual([a.kind, a.limit, a.resetsAt, a.retryAfter], ['rate_limited', true, at * 1000, 600]);
    const b = classifyCliFailure('', { apiError: 'usage_limit_reached' });
    assert.deepEqual([b.kind, b.limit], ['rate_limited', true]);
    const allowed = classifyCliFailure('API Error: 529 Overloaded', { rateLimit: { status: 'allowed', resetsAt: 1 } });
    assert.equal(allowed.kind, 'overloaded', 'an allowed event on a failed run is not a limit');
  });

  test('a server throttle is not our usage limit', () => {
    const e = classifyCliFailure('Server is temporarily limiting requests (not your usage limit) · Rate limited');
    assert.equal(e.kind, 'rate_limited');
    assert.equal(e.limit, undefined);
  });

  test('logged out → cli_auth, telling you to run claude auth login (never "API key invalid")', () => {
    for (const t of ['Invalid API key · Please run /login', 'Not logged in · Please run /login', 'OAuth token has expired. Please obtain a new token or refresh your existing token.', 'Failed to authenticate. API Error: 401', 'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}']) {
      const e = classifyCliFailure(t);
      assert.equal(e.kind, 'cli_auth', t);
      assert.match(e.message, /Run claude auth login in Terminal/);
      assert.equal(classifyApiError(e).kind, 'cli_auth', 'the loop sees the same kind');
    }
    assert.equal(classifyCliFailure('authentication_error somewhere mid-line').kind, 'cli_auth', 'key_rejected wording maps to cli_auth');
  });

  test('logged out through a wrapper: the advice names the wrapper\'s login, not claude auth login', () => {
    const e = classifyCliFailure('Not logged in · Please run /login', { bin: '/Users/x/Projects/claude-failover/bin/claude-failover' });
    assert.equal(e.kind, 'cli_auth');
    assert.doesNotMatch(e.message, /claude auth login/);
    assert.match(e.message, /claude-accounts login <account>/);
    assert.deepEqual(e.login, claudecli.loginHelp('/x/claude-failover'));
    assert.deepEqual(classifyCliFailure('Not logged in', { bin: '/opt/homebrew/bin/claude' }).login, { command: 'claude auth login', text: 'run claude auth login in Terminal' });
  });

  test('other failures reuse the API kinds', () => {
    assert.equal(classifyCliFailure('API Error: 529 {"type":"overloaded_error"}').kind, 'overloaded');
    assert.equal(classifyCliFailure('API Error: 500 Internal server error').kind, 'overloaded');
    assert.equal(classifyCliFailure('API Error: 429 rate_limit_error').kind, 'rate_limited');
    assert.equal(classifyCliFailure('API Error: Unable to connect to API (ECONNREFUSED)').kind, 'network');
    assert.equal(classifyCliFailure('Credit balance is too low').kind, 'no_credit');
    assert.equal(classifyCliFailure('something odd').kind, 'unknown');
    assert.match(classifyCliFailure('').message, /no message/);
  });

  test('parseResetTime reads local clock times, dates, weekdays and the epoch form', () => {
    const at = (h, m = 0, dayOffset = 0) => { const d = new Date(NOW); d.setDate(d.getDate() + dayOffset); d.setHours(h, m, 0, 0); return d.getTime(); };
    assert.equal(claudecli.parseResetTime("You've hit your limit · resets 3pm", NOW), at(15));
    assert.equal(claudecli.parseResetTime('resets 3:30pm (America/New_York)', NOW), at(15, 30));
    assert.equal(claudecli.parseResetTime('resets 12am', NOW), at(0, 0, 1), 'midnight already passed today → tomorrow');
    assert.equal(claudecli.parseResetTime('resets 9am', NOW), at(9, 0, 1), 'earlier today → tomorrow');
    assert.equal(claudecli.parseResetTime('resets 12:58pm', NOW), at(12, 58), 'a couple of minutes ago is still today');
    assert.equal(claudecli.parseResetTime('resets 23:15', NOW), at(23, 15));
    assert.equal(claudecli.parseResetTime('resets Oct 16, 3pm', NOW), at(15, 0, 2));
    assert.equal(claudecli.parseResetTime('resets on Oct 16 at 3pm', NOW), at(15, 0, 2));
    assert.equal(claudecli.parseResetTime('resets Fri 3pm', NOW), at(15, 0, 2), 'Oct 14 2026 is a Wednesday');
    assert.equal(claudecli.parseResetTime('Claude AI usage limit reached|1792011600', NOW), 1792011600000);
    assert.equal(claudecli.parseResetTime('resets Dec 25, 3pm', NOW), null, 'more than 8 days out is a misread');
    assert.equal(claudecli.parseResetTime('resets 25pm', NOW), null);
    assert.equal(claudecli.parseResetTime('resets soon', NOW), null);
    assert.equal(claudecli.parseResetTime('', NOW), null);
    assert.equal(claudecli.parseResetTime(null, NOW), null);
  });
});

describe('engine selection', () => {
  test('config.engine "cli" selects the CLI, packaged or not', t => {
    withEnv(t, { GRAYOUT_DEV_ENGINE: undefined });
    assert.equal(analyzer.resolveEngine({ engine: 'cli' }, true), 'cli', 'packaged');
    assert.equal(analyzer.resolveEngine({ engine: 'cli' }, false), 'cli', 'unpackaged');
    assert.equal(analyzer.resolveEngine({ engine: 'cli' }), 'cli', 'default: plain node is unpackaged');
  });

  test('other values keep the API engine', t => {
    withEnv(t, { GRAYOUT_DEV_ENGINE: undefined });
    for (const e of ['api', 'auto', undefined, 'CLI', 'foo']) {
      assert.equal(analyzer.resolveEngine({ engine: e }, true), 'api', String(e));
      assert.equal(analyzer.resolveEngine({ engine: e }, false), 'api', String(e));
    }
    assert.equal(analyzer.resolveEngine(null, true), 'api');
    assert.equal(analyzer.resolveEngine(undefined, false), 'api');
  });

  test('GRAYOUT_DEV_ENGINE=cli still works, unpackaged only', t => {
    withEnv(t, { GRAYOUT_DEV_ENGINE: 'cli' });
    assert.equal(analyzer.resolveEngine({ engine: 'api' }, false), 'cli');
    assert.equal(analyzer.resolveEngine({ engine: 'api' }, true), 'api', 'a packaged app ignores the env override');
  });
});

describe('spawning a fake claude', () => {
  test('end to end through analyze(): images on stdin, exact argv, allowlisted env, own empty cwd, no frames on disk', async t => {
    withEnv(t, HOSTILE_ENV);
    const before = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('grayout-cli-'));
    const ctx = ctxOf({ apiKey: 'sk-proj-a-key-that-must-not-be-used' });
    const r = await analyze(ctx, cliCfg('ok'));

    assert.deepEqual(r, {
      engine: 'cli', provider: 'claude-cli', model: 'claude-haiku-4-5',
      verdict: { off_task: false, activity: 'code editor (3 images)', confidence: 'high' },
      usage: { input_tokens: 2100, output_tokens: 53 }
    });

    const rec = readRecord('ok');
    assert.deepEqual(rec.argv, claudecli.args('claude-haiku-4-5'));
    const cwd = claudecli.workDir(os.tmpdir());
    assert.equal(fs.realpathSync(rec.cwd), fs.realpathSync(cwd));
    assert.deepEqual(fs.readdirSync(cwd), [], 'the cwd stays empty');
    for (const k of Object.keys(HOSTILE_ENV)) assert.equal(k in rec.env, false, k);
    // Whatever /bin/sh adds itself (PWD, SHLVL, _) is fine; nothing else beyond the allowlist.
    const allowed = new Set([...claudecli.ENV_ALLOW, ...Object.keys(claudecli.ENV_FIXED), 'PATH', 'PWD', 'OLDPWD', 'SHLVL', '_']);
    assert.deepEqual(Object.keys(rec.env).filter(k => !allowed.has(k) && !/^LC_/.test(k)), []);
    assert.equal(rec.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
    assert.equal(rec.env.CLAUDE_CODE_MAX_RETRIES, '2');
    assert.ok(rec.env.PATH.startsWith('/opt/homebrew/bin:/usr/local/bin:'));

    const stdinLines = rec.stdin.split('\n').filter(Boolean);
    assert.equal(stdinLines.length, 1, 'exactly one stream-json message, then EOF');
    const content = JSON.parse(stdinLines[0]).message.content;
    assert.deepEqual(content.map(b => b.type), ['image', 'image', 'image', 'text']);
    assert.deepEqual(content.slice(0, 3).map(b => b.source.data), ['U0NSRUVOMA==', 'U0NSRUVOMQ==', 'V0VCQ0FN']);
    assert.ok(content.slice(0, 3).every(b => b.source.type === 'base64' && b.source.media_type === 'image/jpeg'));
    assert.equal(content[3].text, buildPromptText(ctx));
    assert.equal(content[3].text.includes('Read tool'), false);
    assert.equal(rec.stdin.includes('sk-proj-a-key'), false, 'the API key is never sent to the CLI');

    const afterDirs = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('grayout-cli-'));
    assert.deepEqual(afterDirs, before, 'no frame staging dir');
  });

  test('a check with no webcam sends just the screenshots', async () => {
    const r = await analyze(ctxOf({ screenshotsB64: ['QQ=='], webcamB64: null }), cliCfg('ok', 'nocam'));
    assert.equal(r.verdict.activity, 'code editor (1 images)');
    const content = JSON.parse(readRecord('nocam').stdin).message.content;
    assert.deepEqual(content.map(b => b.type), ['image', 'text']);
    assert.ok(content[1].text.includes('You are given a screenshot of the screen.'));
  });

  test('usage limit: rejects rate_limited with the reset time from the event', async () => {
    await assert.rejects(analyze(ctxOf(), cliCfg('limit')), e => e.kind === 'rate_limited' && e.limit === true && e.resetsAt === 1792011600000 &&
      (e.retryAfter === null ? e.resetsAt <= Date.now() : Number.isInteger(e.retryAfter) && e.retryAfter > 0) && /hit your limit/.test(e.message));
  });

  test('engine "cli" never reaches the hosted service, whatever provider and account say', async t => {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('network must not be used'); });
    let asked = 0;
    const account = { configured: () => true, check: async () => { asked++; return { ok: true, data: { verdict: { off_task: true, activity: 'x', confidence: 'high' } } }; } };
    const r = await analyze(ctxOf({ account, apiKey: null }), { ...cliCfg('ok', 'hosted-cfg'), provider: 'grayout' });
    assert.equal(r.engine, 'cli');
    assert.equal(r.provider, 'claude-cli');
    assert.equal('service' in r, false, 'no plan facts come back from the CLI');
    assert.equal(asked, 0, 'the account client is never asked for a check');
    assert.equal(fetchMock.mock.callCount(), 0);
    await assert.rejects(analyze(ctxOf({ account }), { ...cliCfg('auth', 'hosted-auth'), provider: 'grayout' }), e => e.kind === 'cli_auth');
    assert.equal(asked, 0, 'nor after a CLI failure');
  });

  test('logged out: cli_auth, and never a fallback to the API key', async t => {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('network must not be used'); });
    await assert.rejects(analyze(ctxOf({ apiKey: 'sk-ant-api03-real-looking-key' }), cliCfg('auth')), e =>
      e.kind === 'cli_auth' && /claude auth login/.test(e.message) && e.login.command === 'claude auth login');
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  test('logged out through a wrapper named claude-failover: its own login advice', async () => {
    await assert.rejects(analyze(ctxOf(), cliCfg('auth', 'auth-wrapper', 'claude-failover')), e =>
      e.kind === 'cli_auth' && !/claude auth login/.test(e.message) && e.login.command === 'claude-accounts status');
  });

  test('no result and a nonzero exit: rejects with what the CLI printed', async () => {
    await assert.rejects(analyze(ctxOf(), cliCfg('garbage')), e => e.kind === 'unknown' && /something exploded/.test(e.message));
  });

  test('overage-billed check: flagged in usage, with the plan reset for the loop', async () => {
    const r = await analyze(ctxOf(), cliCfg('overage'));
    assert.equal(r.usage.overage, true);
    assert.deepEqual(r.overage, { resetsAt: 1792011600000 });
    assert.equal(r.verdict.off_task, false);
  });

  test('a missing binary rejects cli_missing before spawning anything', async () => {
    await assert.rejects(analyze(ctxOf(), { ...cliCfg('ok', 'gone-base'), cliPath: path.join(dir, 'gone', 'claude') }), e => e.kind === 'cli_missing');
  });

  test('flooded output: cut off at 10 MB with a kind the loop backs off on', async () => {
    await assert.rejects(analyzeViaCli(ctxOf(), cliCfg('flood'), { timeoutMs: 10000 }), e =>
      e.kind === 'overloaded' && /exceeded 10 MB/.test(e.message));
  });

  test('timeout: the whole process group is SIGKILLed and the check rejects as a network failure', async () => {
    const t0 = Date.now();
    await assert.rejects(analyzeViaCli(ctxOf(), cliCfg('hang'), { timeoutMs: 1500 }), e =>
      /claude CLI exceeded 2s — check abandoned/.test(e.message) && e.kind === 'network' && e.timeout === true &&
      classifyApiError(e).kind === 'network');
    assert.ok(Date.now() - t0 < 5000);
    const rec = readRecord('hang');
    const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) {
      gone = !alive(rec.pid) && !alive(rec.grandchildPid);
      if (!gone) await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(gone, true, 'the fake and its grandchild are both dead');
  });
});

describe('Mac App Store edition: no Claude CLI engine (2.5.2)', () => {
  after(() => { channel._setForTests(null); channel._setPersonalForTests(true); });

  test('resolveEngine is always "api", even for engine "cli" or GRAYOUT_DEV_ENGINE=cli, personal flag or not', t => {
    withEnv(t, { GRAYOUT_DEV_ENGINE: 'cli' });
    channel._setForTests('mas');
    for (const personal of [true, false]) {
      channel._setPersonalForTests(personal);
      assert.equal(analyzer.resolveEngine({ engine: 'cli' }, true), 'api', `personal ${personal}`);
      assert.equal(analyzer.resolveEngine({ engine: 'cli' }, false), 'api', `personal ${personal}`);
      assert.equal(analyzer.resolveEngine({ engine: 'api' }, false), 'api', `personal ${personal}`);
    }
    channel._setForTests(null);
    channel._setPersonalForTests(true);
    assert.equal(analyzer.resolveEngine({ engine: 'cli' }, true), 'cli', 'the personal direct build keeps the CLI');
  });

  test('analyzeViaCli refuses without spawning anything', async () => {
    channel._setForTests('mas');
    const tag = 'mas-refused';
    try { fs.unlinkSync(recordPath(tag)); } catch {}
    await assert.rejects(analyzeViaCli(ctxOf(), cliCfg('ok', tag)), e => e.kind === 'cli_missing' && /not available in this version of Grayout/.test(e.message));
    assert.equal(fs.existsSync(recordPath(tag)), false, 'the fake claude never ran');
  });
});

describe('public direct build: no Claude CLI engine (pay-only)', () => {
  after(() => { channel._setForTests(null); channel._setPersonalForTests(true); });
  const publicDirect = () => { channel._setForTests('direct'); channel._setPersonalForTests(false); };

  test('resolveEngine is always "api", even for engine "cli" or GRAYOUT_DEV_ENGINE=cli', t => {
    withEnv(t, { GRAYOUT_DEV_ENGINE: 'cli' });
    publicDirect();
    assert.equal(channel.features().cliEngine, false);
    assert.equal(analyzer.resolveEngine({ engine: 'cli' }, true), 'api', 'packaged');
    assert.equal(analyzer.resolveEngine({ engine: 'cli' }, false), 'api', 'unpackaged');
    assert.equal(analyzer.resolveEngine({ engine: 'api' }, false), 'api', 'GRAYOUT_DEV_ENGINE=cli alone does nothing');
  });

  test('running from source is the public build unless GRAYOUT_PERSONAL=1 (exactly)', t => {
    withEnv(t, { GRAYOUT_DEV_ENGINE: undefined, GRAYOUT_PERSONAL: undefined });
    channel._setForTests('direct');
    channel._setPersonalForTests(null); // the real answer: plain node is unpackaged
    assert.equal(analyzer.resolveEngine({ engine: 'cli' }), 'api');
    process.env.GRAYOUT_PERSONAL = 'true';
    assert.equal(analyzer.resolveEngine({ engine: 'cli' }), 'api', 'only the value 1 counts');
    process.env.GRAYOUT_PERSONAL = '1';
    assert.equal(analyzer.resolveEngine({ engine: 'cli' }), 'cli', 'the personal build, run from source');
  });

  test('config.json with engine "cli" and a cliPath cannot reach the CLI', () => {
    publicDirect();
    const { coerce } = require('../src/config');
    const cfg = coerce({ engine: 'cli', cliPath: SHIM, cliAllowOverage: true });
    assert.equal(cfg.engine, 'api');
    assert.equal(cfg.cliPath, '');
    assert.equal(cfg.cliAllowOverage, false);
    assert.equal(analyzer.resolveEngine(cfg, true), 'api');
  });

  test('analyzeViaCli refuses without spawning anything', async () => {
    publicDirect();
    const tag = 'public-refused';
    try { fs.unlinkSync(recordPath(tag)); } catch {}
    await assert.rejects(analyzeViaCli(ctxOf(), cliCfg('ok', tag)), e => e.kind === 'cli_missing' && /not available in this version of Grayout/.test(e.message));
    assert.equal(fs.existsSync(recordPath(tag)), false, 'the fake claude never ran');
  });

  test('analyze() with engine "cli" goes to the hosted service instead, never the binary', async () => {
    publicDirect();
    const tag = 'public-analyze';
    try { fs.unlinkSync(recordPath(tag)); } catch {}
    let checks = 0;
    const account = { check: async () => { checks++; return { ok: true, data: { verdict: { off_task: false, activity: 'writing', confidence: 'high' }, plan: 'free', service: true } }; } };
    const r = await analyze(ctxOf({ account, apiKey: 'sk-ant-a-saved-1x-key' }), { ...cliCfg('ok', tag), provider: 'anthropic' });
    assert.equal(r.engine, 'api');
    assert.equal(r.provider, 'grayout');
    assert.equal(checks, 1);
    assert.equal(fs.existsSync(recordPath(tag)), false, 'the fake claude never ran');
  });
});
