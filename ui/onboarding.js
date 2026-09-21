'use strict';
// Onboarding window logic. The only door to the main process is window.grayout
// (ui/preload/onboarding.js); the handlers live in src/ipc.js. Untrusted
// strings (activity phrases, error messages) are rendered with textContent.
(() => {
  const api = window.grayout;
  const $ = id => document.getElementById(id);
  const STEPS = 5;
  // The privacy and key-guide links live on the <a data-external> elements in
  // the HTML; these are attached to key-test failures, per provider. Both
  // hosts are on the main process's allowlist.
  const KEYS_URL = {
    anthropic: 'https://console.anthropic.com/settings/keys',
    openai: 'https://platform.openai.com/api-keys'
  };
  const BILLING_URL = {
    anthropic: 'https://console.anthropic.com/settings/billing',
    openai: 'https://platform.openai.com/settings/organization/billing'
  };
  const providerLabel = r => (r && typeof r.providerLabel === 'string' && r.providerLabel) || 'The provider';

  if (!api) {
    $('no-bridge').style.display = 'block';
    $('loading').hidden = true;
    $('screens').hidden = true;
    return;
  }

  let S = null;              // last onb:getState payload
  let step = 1;
  let screenTimer = null;    // screen 2 poll
  let screenState = 'not-determined';
  // null until the first getState() resolves; then true if macOS had already
  // granted Screen Recording to this process when it launched.
  let grantedAtBoot = null;
  let testedKey = '';        // the exact key that passed Test key
  let testing = false;
  let frameB64 = null;       // cached synthetic frame
  let loginNoticeShown = false;
  let finishing = false;

  const show = (el, on) => { el.hidden = !on; };
  const setText = (el, text) => { el.textContent = text == null ? '' : String(text); };
  const money = n => (typeof n === 'number' && Number.isFinite(n)) ? `$${n.toFixed(2)}` : null;
  const swallow = p => Promise.resolve(p).catch(() => undefined);

  /* ---------------- navigation ---------------- */

  function go(n, opts = {}) {
    const next = Math.min(STEPS, Math.max(1, Number(n) || 1));
    if (next !== 2) stopScreenPoll();
    step = next;
    for (const sec of document.querySelectorAll('.screen')) {
      sec.classList.toggle('on', Number(sec.dataset.step) === step);
    }
    setText($('progress'), `${step} of ${STEPS}`);
    if (!opts.silent) swallow(api.setStep(step));
    onEnter(step);
  }

  function onEnter(n) {
    if (n === 1) renderScreen1();
    if (n === 2) { renderScreenPill(S ? S.screen : screenState); startScreenPoll(); }
    if (n === 3) renderScreen3();
    if (n === 4) renderScreen4();
    if (n === 5) renderScreen5();
    focusPrimary(n);
  }

  function focusPrimary(n) {
    const target = {
      1: '#btn-1-continue', 2: '#btn-2-continue', 3: '#key', 4: '#work', 5: '#btn-preview'
    }[n];
    const el = target && document.querySelector(target);
    if (el && !el.disabled) setTimeout(() => el.focus({ preventScroll: true }), 0);
  }

  /* ---------------- screen 1 ---------------- */

  function renderScreen1() {
    // Running from source has no Applications concept; only a packaged build
    // that lives outside /Applications gets the bar.
    const needsMove = !!(S && S.isPackaged && !S.inApplications);
    show($('move-bar'), needsMove);
  }

  async function moveToApplications() {
    const btn = $('btn-move');
    btn.disabled = true;
    setText($('move-status'), '');
    let ok = false;
    try { ok = await api.moveToApplications(); } catch { ok = false; }
    if (!ok) {
      // On success the app relaunches from /Applications by itself.
      btn.disabled = false;
      setText($('move-status'), 'Grayout stayed where it is. Drag it to Applications in Finder, then open it again.');
    }
  }

  /* ---------------- screen 2 ---------------- */

  function renderScreenPill(status) {
    screenState = status || 'not-determined';
    const pill = $('screen-pill');
    const granted = screenState === 'granted';
    const stale = screenState === 'stale';
    pill.classList.remove('pill-good', 'pill-bad', 'pill-warn');
    pill.classList.add(granted ? 'pill-good' : stale ? 'pill-warn' : 'pill-bad');
    setText($('screen-pill-text'), granted ? 'Allowed' : stale ? 'Allowed, but stale' : 'Not allowed');

    // A grant that was already in place when this window opened is live in this
    // process: Continue is the way forward. A grant that arrived just now is not
    // applied until the app restarts, so Relaunch is the only primary and
    // Continue stays disabled rather than silently skipping the restart.
    const needsRelaunch = granted && grantedAtBoot === false;
    show($('btn-open-screen'), !granted);
    show($('btn-relaunch'), needsRelaunch);
    show($('relaunch-note'), needsRelaunch);
    show($('stale-box'), stale);
    $('btn-2-continue').disabled = !granted || needsRelaunch;
    $('btn-2-continue').classList.toggle('btn-primary', !needsRelaunch);
    $('btn-2-continue').classList.toggle('btn-secondary', needsRelaunch);
  }

  async function pollScreen() {
    try {
      const r = await api.recheckScreen();
      if (r && typeof r.screen === 'string') {
        if (r.tccResetCmd) setText($('tcc-cmd'), r.tccResetCmd);
        if (r.screen !== screenState) renderScreenPill(r.screen);
        if (S) S.screen = r.screen;
      }
    } catch { /* keep the last known state */ }
  }

  function startScreenPoll() {
    stopScreenPoll();
    pollScreen();
    screenTimer = setInterval(pollScreen, 2000);
  }

  function stopScreenPoll() {
    if (screenTimer) { clearInterval(screenTimer); screenTimer = null; }
  }

  async function copyTcc() {
    const btn = $('btn-copy-tcc');
    try { await api.copyText($('tcc-cmd').textContent); } catch { return; }
    setText(btn, 'Copied');
    setTimeout(() => setText(btn, 'Copy'), 1500);
  }

  function relaunch() {
    $('btn-relaunch').disabled = true;
    setText($('btn-relaunch'), 'Relaunching…');
    swallow(api.relaunch());
  }

  /* ---------------- screen 3 ---------------- */

  function renderScreen3() {
    const hasKey = !!(S && S.hasKey);
    setText($('key-existing'), hasKey && S.keyMasked
      ? `A key is already saved (${S.keyMasked}). Test a new one to replace it, or continue.`
      : '');
    show($('btn-session'), !!(S && S.secureStorage === false));
    show($('keychain-note'), !(S && S.secureStorage === false));
    updateKeyButtons();
  }

  function currentKey() { return $('key').value.trim(); }

  function updateKeyButtons() {
    const key = currentKey();
    const hasSaved = !!(S && S.hasKey);
    const passed = !!key && key === testedKey;
    $('btn-test').disabled = testing || !key;
    const save = $('btn-3-save');
    if (!key && hasSaved) {
      // Nothing new to save; the saved key stays.
      setText(save, 'Continue');
      save.disabled = false;
    } else {
      setText(save, 'Save and continue');
      save.disabled = !passed;
    }
    $('btn-session').disabled = !passed;
  }

  function toggleReveal() {
    const input = $('key');
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    setText($('btn-reveal'), reveal ? 'Hide' : 'Show');
    $('btn-reveal').setAttribute('aria-label', reveal ? 'Hide key' : 'Show key');
    input.focus();
  }

  function onKeyInput() {
    if (currentKey() !== testedKey) {
      setText($('test-result'), '');
      $('test-result').classList.remove('status-good', 'status-bad');
    }
    setText($('save-status'), '');
    updateKeyButtons();
  }

  function onKeyPaste(e) {
    // Paste detection: keys often arrive with a trailing newline or spaces.
    // Normalize, then run the test on the user's behalf if it looks like a key.
    let text = '';
    try { text = (e.clipboardData && e.clipboardData.getData('text')) || ''; } catch { text = ''; }
    const clean = text.replace(/\s+/g, '');
    if (!clean) return;
    e.preventDefault();
    const input = $('key');
    input.value = clean;
    onKeyInput();
    if (/^sk-/.test(clean) && clean.length > 20) setTimeout(testKey, 0);
  }

  function testedModel(r) {
    if (r && typeof r.model === 'string' && r.model) return r.model;
    // A failed test carries no model. The saved key's estimates resolve the
    // same model when they are for the same provider.
    const est = S && S.estimates;
    if (est && r && est.provider === r.provider && typeof est.model === 'string' && est.model) return est.model;
    return 'the configured model';
  }

  function resultMessage(r) {
    const who = providerLabel(r);
    if (r && r.ok) {
      const cost = typeof r.costUsd === 'number' && Number.isFinite(r.costUsd) ? `$${r.costUsd.toFixed(4)}` : null;
      const saw = r.verdict && r.verdict.activity ? r.verdict.activity : 'a code editor';
      const which = r.model ? `${who}, ${r.model}` : who;
      return cost
        ? `Key works (${which}). That check cost ${cost} and the model saw: ${saw}.`
        : `Key works (${which}). The model saw: ${saw}.`;
    }
    const kind = r && r.kind;
    if (kind === 'key_rejected') return `${who} rejected this key. Check for missing characters or make a new one.`;
    if (kind === 'no_credit') return `This ${who} account has no credit. Add $5 in its billing settings, then test again.`;
    if (kind === 'network') return `Couldn't reach ${who}. Check your connection and try again.`;
    if (kind === 'no_key') return 'Paste a key first.';
    if (kind === 'bad_model') return `This account can't use ${testedModel(r)}. Try a different key or set model in config.json.`;
    if (kind === 'rate_limited' || kind === 'overloaded') return `${who} is busy right now. Wait a moment and test again.`;
    const detail = r && typeof r.message === 'string' ? r.message.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
    return detail ? `The test didn't go through: ${detail}` : "The test didn't go through. Try again.";
  }

  async function testKey() {
    const key = currentKey();
    if (!key || testing) return;
    testing = true;
    const btn = $('btn-test');
    const out = $('test-result');
    out.classList.remove('status-good', 'status-bad');
    setText(out, 'Testing… this sends one synthetic frame under your key.');
    setText(btn, 'Testing…');
    setText($('save-status'), '');
    updateKeyButtons();
    let r;
    try {
      if (!frameB64) frameB64 = syntheticFrameB64();
      r = await api.testApiKey(key, frameB64);
    } catch (e) {
      r = { ok: false, kind: 'unknown', message: e && e.message ? e.message : 'unexpected error' };
    }
    testing = false;
    setText(btn, 'Test key');
    testedKey = r && r.ok ? key : '';
    out.classList.add(r && r.ok ? 'status-good' : 'status-bad');
    setText(out, resultMessage(r));
    if (r && !r.ok && (r.kind === 'key_rejected' || r.kind === 'no_credit')) {
      const provider = r.provider === 'openai' ? 'openai' : 'anthropic';
      const url = r.kind === 'no_credit' ? BILLING_URL[provider] : KEYS_URL[provider];
      const link = document.createElement('button');
      link.type = 'button'; link.className = 'link';
      link.textContent = r.kind === 'no_credit' ? `Open ${providerLabel(r)} billing` : `Open ${new URL(url).hostname}`;
      link.addEventListener('click', () => swallow(api.openExternal(url)));
      out.append(' ', link);
    }
    updateKeyButtons();
    if (r && r.ok) $('btn-3-save').focus();
  }

  async function saveKey() {
    const key = currentKey();
    const hasSaved = !!(S && S.hasKey);
    if (!key && hasSaved) { go(4); return; }
    if (!key || key !== testedKey) return;
    const btn = $('btn-3-save');
    btn.disabled = true;
    setText($('save-status'), '');
    let r;
    try { r = await api.saveApiKey(key); } catch (e) { r = { ok: false, secureStorage: true, message: e && e.message }; }
    if (r && r.ok) {
      if (S) { S.hasKey = true; S.keyMasked = r.keyMasked || S.keyMasked; }
      await refreshState();
      go(4);
      return;
    }
    btn.disabled = false;
    if (r && r.secureStorage === false) {
      show($('btn-session'), true);
      show($('keychain-note'), false);
      $('btn-session').disabled = false;
      setText($('save-status'), (r.message || 'Secure storage is not available on this Mac.') + ' You can still use the key until Grayout quits.');
    } else {
      setText($('save-status'), (r && r.message) ? `Couldn't save the key: ${r.message}` : "Couldn't save the key.");
    }
  }

  async function useSession() {
    const key = currentKey();
    if (!key || key !== testedKey) return;
    $('btn-session').disabled = true;
    let r;
    try { r = await api.useKeyForSession(key); } catch (e) { r = { ok: false, message: e && e.message }; }
    if (r && r.ok) { await refreshState(); go(4); return; }
    $('btn-session').disabled = false;
    setText($('save-status'), (r && r.message) ? `Couldn't use the key: ${r.message}` : "Couldn't use the key.");
  }

  // The estimates on screen 4 are computed for the provider of the saved key,
  // so re-read the state after a key is stored.
  async function refreshState() {
    let fresh = null;
    try { fresh = await api.getState(); } catch { fresh = null; }
    if (fresh && typeof fresh === 'object') {
      S = { ...(S || {}), ...fresh, hasKey: true };
      screenState = S.screen || screenState;
    }
  }

  async function skipKey() {
    $('btn-3-skip').disabled = true;
    await swallow(api.skipKey());
    $('btn-3-skip').disabled = false;
    go(4);
  }

  /* ---------------- synthetic editor frame ---------------- */

  const CODE_LINES = [
    "'use strict';",
    "// Bounded work queue: at most `limit` jobs run at once, the rest wait.",
    "const { EventEmitter } = require('events');",
    '',
    'class WorkQueue extends EventEmitter {',
    '  constructor(limit = 4) {',
    '    super();',
    '    this.limit = limit;',
    '    this.running = 0;',
    '    this.pending = [];',
    '  }',
    '',
    '  push(job, priority = 0) {',
    '    return new Promise((resolve, reject) => {',
    '      this.pending.push({ job, priority, resolve, reject });',
    '      this.pending.sort((a, b) => b.priority - a.priority);',
    '      this.drain();',
    '    });',
    '  }',
    '',
    '  async drain() {',
    '    while (this.running < this.limit && this.pending.length) {',
    '      const next = this.pending.shift();',
    '      this.running += 1;',
    '      try {',
    '        next.resolve(await next.job());',
    '      } catch (err) {',
    "        this.emit('error', err);",
    '        next.reject(err);',
    '      } finally {',
    '        this.running -= 1;',
    "        if (!this.pending.length && !this.running) this.emit('idle');",
    '      }',
    '    }',
    '  }',
    '}',
    '',
    'module.exports = { WorkQueue };'
  ];
  const KEYWORDS = new Set(['const', 'let', 'var', 'class', 'extends', 'return', 'new', 'async', 'await', 'while', 'if', 'try', 'catch', 'finally', 'this', 'super', 'require', 'module', 'true', 'false', 'null']);

  function tokenize(line) {
    // Tiny tokenizer, only for coloring: comment, string, number, word, other.
    const out = [];
    const re = /(\/\/.*$)|('(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|(\s+)|(.)/g;
    let m;
    while ((m = re.exec(line))) {
      if (m[1]) out.push(['comment', m[1]]);
      else if (m[2]) out.push(['string', m[2]]);
      else if (m[3]) out.push(['number', m[3]]);
      else if (m[4]) {
        const rest = line.slice(re.lastIndex);
        const kind = KEYWORDS.has(m[4]) ? 'keyword' : /^\s*\(/.test(rest) ? 'fn' : /^[A-Z]/.test(m[4]) ? 'type' : 'plain';
        out.push([kind, m[4]]);
      }
      else out.push(['plain', m[5] || m[6]]);
    }
    return out;
  }

  function syntheticFrameB64() {
    const W = 1366, H = 768;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const MONO = '13px Menlo, Monaco, "SF Mono", Consolas, monospace';
    const SANS = '12px -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif';
    const colors = { plain: '#d4d4d4', keyword: '#569cd6', string: '#ce9178', comment: '#6a9955', number: '#b5cea8', fn: '#dcdcaa', type: '#4ec9b0' };

    // Menu bar (macOS) and window chrome.
    g.fillStyle = '#2b2b2f'; g.fillRect(0, 0, W, 24);
    g.fillStyle = '#e6e6e6'; g.font = 'bold 13px -apple-system, Helvetica, Arial, sans-serif';
    g.fillText('Code', 40, 17);
    g.font = SANS;
    let mx = 84;
    for (const item of ['File', 'Edit', 'Selection', 'View', 'Go', 'Run', 'Terminal', 'Window', 'Help']) {
      g.fillText(item, mx, 17); mx += g.measureText(item).width + 18;
    }
    g.textAlign = 'right'; g.fillText('Mon 10:42 AM', W - 16, 17); g.textAlign = 'left';

    const top = 24;
    g.fillStyle = '#1e1e1e'; g.fillRect(0, top, W, H - top);

    // Activity bar + sidebar (file tree).
    const barW = 48, sideW = 200;
    g.fillStyle = '#333333'; g.fillRect(0, top, barW, H - top);
    g.fillStyle = '#252526'; g.fillRect(barW, top, sideW, H - top);
    for (let i = 0; i < 5; i++) {
      g.fillStyle = i === 0 ? '#ffffff' : '#858585';
      g.fillRect(14, top + 16 + i * 44, 20, 20);
      g.fillStyle = '#333333'; g.fillRect(17, top + 19 + i * 44, 14, 14);
    }
    g.fillStyle = '#bbbbbb'; g.font = 'bold 11px -apple-system, Helvetica, Arial, sans-serif';
    g.fillText('EXPLORER', barW + 16, top + 26);
    g.font = SANS;
    const tree = [
      ['v  PROJECT', 0, '#cccccc'], ['v  src', 1, '#cccccc'], ['index.js', 2, '#cccccc'], ['queue.js', 2, '#ffffff'],
      ['worker.js', 2, '#cccccc'], ['config.js', 2, '#cccccc'], ['v  tests', 1, '#cccccc'], ['queue.test.js', 2, '#cccccc'],
      ['worker.test.js', 2, '#cccccc'], ['>  node_modules', 1, '#8c8c8c'], ['.gitignore', 1, '#cccccc'], ['package.json', 1, '#cccccc'],
      ['README.md', 1, '#cccccc']
    ];
    tree.forEach(([name, depth, color], i) => {
      const y = top + 50 + i * 22;
      if (name === 'queue.js') { g.fillStyle = '#37373d'; g.fillRect(barW, y - 15, sideW, 22); }
      g.fillStyle = color; g.fillText(name, barW + 16 + depth * 14, y);
    });

    // Tabs.
    const ex = barW + sideW, tabH = 36;
    g.fillStyle = '#252526'; g.fillRect(ex, top, W - ex, tabH);
    let tx = ex;
    for (const [name, active] of [['queue.js', true], ['worker.js', false], ['package.json', false]]) {
      const w = 130;
      g.fillStyle = active ? '#1e1e1e' : '#2d2d2d'; g.fillRect(tx, top, w, tabH);
      g.fillStyle = active ? '#ffffff' : '#969696'; g.font = SANS;
      g.fillText(name, tx + 14, top + 22);
      if (active) { g.fillStyle = '#d4d4d4'; g.fillText('×', tx + w - 20, top + 22); }
      tx += w;
    }
    // Breadcrumb.
    g.fillStyle = '#a0a0a0'; g.font = SANS;
    g.fillText('src  >  queue.js  >  WorkQueue  >  drain', ex + 14, top + tabH + 17);

    // Editor: line numbers + code.
    const termH = 210, statusH = 22;
    const codeTop = top + tabH + 26, lineH = 19;
    const gutterW = 56;
    g.font = MONO;
    const maxLines = Math.floor((H - termH - statusH - codeTop) / lineH);
    const current = 22;
    for (let i = 0; i < Math.min(CODE_LINES.length, maxLines); i++) {
      const y = codeTop + 14 + i * lineH;
      if (i + 1 === current) { g.fillStyle = '#282828'; g.fillRect(ex, y - 14, W - ex, lineH); }
      g.fillStyle = i + 1 === current ? '#c6c6c6' : '#858585';
      g.textAlign = 'right'; g.fillText(String(i + 1), ex + gutterW - 16, y); g.textAlign = 'left';
      let x = ex + gutterW + 4;
      for (const [kind, text] of tokenize(CODE_LINES[i])) {
        g.fillStyle = colors[kind] || colors.plain;
        g.fillText(text, x, y);
        x += g.measureText(text).width;
      }
    }
    // Scrollbar + minimap hint.
    g.fillStyle = '#2a2a2a'; g.fillRect(W - 14, codeTop, 14, H - termH - statusH - codeTop);
    g.fillStyle = '#4a4a4a'; g.fillRect(W - 11, codeTop + 8, 8, 160);

    // Terminal pane.
    const ty = H - termH - statusH;
    g.fillStyle = '#181818'; g.fillRect(ex, ty, W - ex, termH);
    g.fillStyle = '#3c3c3c'; g.fillRect(ex, ty, W - ex, 1);
    g.font = 'bold 11px -apple-system, Helvetica, Arial, sans-serif';
    g.fillStyle = '#e7e7e7'; g.fillText('TERMINAL', ex + 16, ty + 22);
    g.fillStyle = '#8c8c8c'; g.fillText('PROBLEMS      OUTPUT      DEBUG CONSOLE', ex + 96, ty + 22);
    g.fillStyle = '#ffffff'; g.fillRect(ex + 16, ty + 28, 60, 1);
    g.font = MONO;
    const term = [
      ['$ node --test tests/', '#d4d4d4'],
      ['  queue.test.js', '#d4d4d4'],
      ['    ok 1 - runs at most `limit` jobs at once (18ms)', '#89d185'],
      ['    ok 2 - higher priority jobs run first (7ms)', '#89d185'],
      ["    ok 3 - emits 'idle' when the queue drains (4ms)", '#89d185'],
      ['  worker.test.js', '#d4d4d4'],
      ['    ok 4 - retries a failed job twice (41ms)', '#89d185'],
      ['', '#d4d4d4'],
      ['  4 passing (92ms)', '#d4d4d4'],
      ['$ ', '#d4d4d4']
    ];
    term.forEach(([text, color], i) => {
      g.fillStyle = color; g.fillText(text, ex + 16, ty + 52 + i * 17);
    });
    g.fillStyle = '#d4d4d4'; g.fillRect(ex + 16 + g.measureText('$ ').width, ty + 52 + (term.length - 1) * 17 - 12, 8, 15);

    // Status bar.
    g.fillStyle = '#007acc'; g.fillRect(0, H - statusH, W, statusH);
    g.fillStyle = '#ffffff'; g.font = SANS;
    g.fillText('main*      0 errors  0 warnings', 12, H - 7);
    g.textAlign = 'right';
    g.fillText('Ln 22, Col 27     Spaces: 2     UTF-8     LF     JavaScript', W - 16, H - 7);
    g.textAlign = 'left';

    return c.toDataURL('image/jpeg', 0.7).split(',')[1];
  }

  /* ---------------- screen 4 ---------------- */

  function renderScreen4() {
    const cfg = (S && S.config) || {};
    const est = (S && S.estimates && S.estimates.byInterval) || {};
    for (const sec of [30, 45, 90]) {
      const d = est[sec] && money(est[sec].daily);
      setText($(`est-${sec}`), d ? `about ${d} a day` : 'estimate unavailable');
    }
    const e = S && S.estimates;
    if (e && e.providerLabel && e.model) {
      const when = e.priceDate ? `, at prices on ${e.priceDate}` : '';
      setText($('est-note'), `Estimates for ${e.providerLabel} ${e.model} on one display${when}. A second display roughly doubles it.`);
    }
    if (!$('work').value && typeof cfg.workDescription === 'string') $('work').value = cfg.workDescription;
    const sel = [30, 45, 90].includes(cfg.checkIntervalSec) ? cfg.checkIntervalSec : 45;
    for (const r of document.querySelectorAll('input[name="interval"]')) r.checked = Number(r.value) === sel;
    $('camera').checked = !!cfg.camera && S && S.cameraStatus === 'granted';
    const inApps = !!(S && (S.inApplications || (S.loginItem && S.loginItem.inApplications)));
    show($('login-block'), inApps);
    $('login').checked = !!cfg.startAtLogin && !!(S && S.loginItem && S.loginItem.status === 'enabled');
    setText($('setup-status'), '');
  }

  async function onCameraToggle() {
    const box = $('camera');
    const out = $('camera-status');
    out.classList.remove('status-good', 'status-bad');
    if (!box.checked) { setText(out, ''); return; }
    box.disabled = true;
    setText(out, 'Asking macOS…');
    let r;
    try { r = await api.requestCamera(); } catch { r = { granted: false, status: 'unknown' }; }
    box.disabled = false;
    if (r && r.granted) {
      out.classList.add('status-good');
      setText(out, 'Camera allowed.');
      return;
    }
    box.checked = false;
    out.classList.add('status-bad');
    out.replaceChildren();
    out.append(r && r.status === 'denied'
      ? 'macOS has the camera turned off for Grayout. '
      : 'macOS did not allow the camera. ');
    const link = document.createElement('button');
    link.type = 'button'; link.className = 'link'; link.textContent = 'Open Camera settings';
    link.addEventListener('click', () => swallow(api.openCameraSettings()));
    out.append(link, ', turn on Grayout, then try again.');
  }

  function renderLoginStatus(li) {
    const out = $('login-status');
    out.classList.remove('status-good', 'status-bad');
    out.replaceChildren();
    const status = li && li.status;
    if (!$('login').checked) return;
    if (status === 'requires-approval') {
      loginNoticeShown = true;
      out.append('macOS wants you to approve this: ');
      const link = document.createElement('button');
      link.type = 'button'; link.className = 'link'; link.textContent = 'Open Login Items settings';
      link.addEventListener('click', () => swallow(api.openLoginItems()));
      out.append(link, '.');
    } else if (status === 'enabled') {
      out.classList.add('status-good');
      out.append('Grayout will start when you log in.');
    } else if (status === 'not-in-applications') {
      $('login').checked = false;
      out.classList.add('status-bad');
      out.append('Move Grayout to Applications first.');
    } else if (status) {
      out.classList.add('status-bad');
      out.append('macOS did not register the login item. You can try again in Settings.');
    }
  }

  async function onLoginToggle() {
    const box = $('login');
    box.disabled = true;
    setText($('login-status'), box.checked ? 'Registering…' : '');
    let r;
    try { r = await api.saveSetup({ startAtLogin: box.checked }); } catch { r = null; }
    box.disabled = false;
    if (r && r.loginItem) { if (S) S.loginItem = r.loginItem; renderLoginStatus(r.loginItem); }
    else if (box.checked) { setText($('login-status'), 'Could not change the login item right now.'); }
  }

  function setupPayload() {
    const sel = document.querySelector('input[name="interval"]:checked');
    return {
      workDescription: $('work').value.trim().slice(0, 500),
      checkIntervalSec: sel ? Number(sel.value) : 45,
      camera: $('camera').checked,
      startAtLogin: !$('login-block').hidden && $('login').checked
    };
  }

  async function saveSetup() {
    const btn = $('btn-4-continue');
    btn.disabled = true;
    setText($('setup-status'), '');
    let r;
    try { r = await api.saveSetup(setupPayload()); } catch (e) { r = null; }
    btn.disabled = false;
    if (!r) { setText($('setup-status'), "Couldn't save these settings. Try again."); return; }
    if (S) { if (r.config) S.config = { ...S.config, ...r.config }; if (r.loginItem) S.loginItem = r.loginItem; }
    if (r.loginItem && $('login').checked && r.loginItem.status === 'requires-approval' && !loginNoticeShown) {
      // Show the approval link once before moving on; the next Continue proceeds.
      renderLoginStatus(r.loginItem);
      return;
    }
    go(5);
  }

  /* ---------------- screen 5 ---------------- */

  function renderScreen5() {
    setText($('preview-status'), '');
    $('btn-finish').disabled = finishing;
  }

  async function preview() {
    const btn = $('btn-preview');
    const out = $('preview-status');
    if (btn.disabled) return;
    btn.disabled = true;
    setText(out, '');
    const release = new Promise(r => setTimeout(r, 3500));
    let ok = true;
    try { ok = await api.previewGray(); } catch { ok = null; }
    await release;
    btn.disabled = false;
    setText(btn, 'Again');
    if (ok === false || (S && S.grayscaleAvailable === false)) {
      setText(out, "Grayscale isn't available on this Mac; Grayout will use the red border only.");
    } else if (ok === null) {
      setText(out, "The preview didn't run. You can try it again.");
    }
  }

  async function finish() {
    if (finishing) return;
    finishing = true;
    const btn = $('btn-finish');
    btn.disabled = true;
    setText(btn, 'Starting…');
    try { await api.finish(); }
    catch {
      finishing = false;
      btn.disabled = false;
      setText(btn, 'Start watching');
    }
  }

  /* ---------------- wiring ---------------- */

  for (const a of document.querySelectorAll('[data-external]')) {
    a.addEventListener('click', e => { e.preventDefault(); swallow(api.openExternal(a.dataset.external)); });
  }

  $('btn-move').addEventListener('click', moveToApplications);
  $('btn-1-continue').addEventListener('click', () => go(2));

  $('btn-open-screen').addEventListener('click', () => swallow(api.openScreenSettings()));
  $('btn-relaunch').addEventListener('click', relaunch);
  $('btn-copy-tcc').addEventListener('click', copyTcc);
  $('btn-2-back').addEventListener('click', () => go(1));
  $('btn-2-skip').addEventListener('click', () => go(3));
  $('btn-2-continue').addEventListener('click', () => { if (!$('btn-2-continue').disabled) go(3); });

  $('key').addEventListener('input', onKeyInput);
  $('key').addEventListener('paste', onKeyPaste);
  $('btn-reveal').addEventListener('click', toggleReveal);
  $('btn-test').addEventListener('click', testKey);
  $('btn-3-save').addEventListener('click', saveKey);
  $('btn-session').addEventListener('click', useSession);
  $('btn-3-skip').addEventListener('click', skipKey);
  $('btn-3-back').addEventListener('click', () => go(2));

  $('camera').addEventListener('change', onCameraToggle);
  $('login').addEventListener('change', onLoginToggle);
  $('btn-4-continue').addEventListener('click', saveSetup);
  $('btn-4-back').addEventListener('click', () => go(3));

  $('btn-preview').addEventListener('click', preview);
  $('btn-finish').addEventListener('click', finish);
  $('btn-5-back').addEventListener('click', () => go(4));

  // Enter advances where sensible. Buttons and links keep their own Enter.
  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.isComposing || e.metaKey || e.altKey || e.ctrlKey) return;
    const t = e.target;
    const tag = t && t.tagName;
    if (tag === 'BUTTON' || tag === 'A' || tag === 'TEXTAREA') return;
    let handled = true;
    if (step === 1) go(2);
    else if (step === 2) { if (!$('btn-2-continue').disabled) go(3); else handled = false; }
    else if (step === 3) {
      const key = currentKey();
      if (key && key === testedKey) saveKey();
      else if (key && !testing) testKey();
      else if (!key && S && S.hasKey) go(4);
      else handled = false;
    }
    else if (step === 4) saveSetup();
    else if (step === 5) finish();
    if (handled) e.preventDefault();
  });

  window.addEventListener('beforeunload', stopScreenPoll);

  /* ---------------- boot ---------------- */

  // Nothing but a neutral line shows until the state is known. getState can
  // take a while (a locked Mac, a slow first probe), and the user may be
  // resuming on step 3 or 4, so screen 1 is never shown as a fallback. A call
  // that hangs past SLOW_MS, or rejects, is retried every RETRY_MS until the
  // deadline; the first answer wins.
  const SLOW_MS = 5000, RETRY_MS = 2000, DEADLINE_MS = 30000;

  function readState() {
    return new Promise(resolve => {
      const started = Date.now();
      let settled = false;
      let calls = 0;
      let timer = null;
      const finish = v => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); };
      const schedule = ms => { clearTimeout(timer); timer = setTimeout(fire, ms); };
      const fire = () => {
        if (settled) return;
        if (Date.now() - started >= DEADLINE_MS) { finish(null); return; }
        calls += 1;
        schedule(calls === 1 ? SLOW_MS : RETRY_MS);
        Promise.resolve().then(() => api.getState()).then(
          v => { if (v && typeof v === 'object') finish(v); else schedule(RETRY_MS); },
          () => schedule(RETRY_MS));
      };
      fire();
      setTimeout(() => finish(null), DEADLINE_MS);
    });
  }

  (async () => {
    const state = await readState();
    if (!state) {
      setText($('loading'), 'Grayout could not read its state. Quit and reopen the app.');
      return;
    }
    S = state;
    screenState = S.screen || 'not-determined';
    // Set once, before anything can change it: was the permission already ours
    // when this process started?
    grantedAtBoot = screenState === 'granted';
    if (S.tccResetCmd) setText($('tcc-cmd'), S.tccResetCmd);
    $('loading').hidden = true;
    $('screens').hidden = false;
    const resume = Number.isInteger(S.step) ? S.step : 1;
    go(resume, { silent: true });
  })();
})();
