'use strict';
// Dashboard + Settings renderer. Runs sandboxed: the only door to the app is
// window.grayout (ui/preload/dashboard.js). Every dynamic string is set with
// textContent; titles go through setAttribute. No innerHTML anywhere.
(() => {
  const api = window.grayout || null;
  const $ = id => document.getElementById(id);

  let day = null;            // selected day key or null for "latest with data"
  let lastData = null;       // last dash:get payload
  let lastLive = null;
  let settings = null;       // last settings:get payload (baseline for diffs)
  let chips = { alwaysAllowedApps: [], neverCaptureApps: [] };
  let refreshTimer = null;
  let settingsLoading = null;

  /* ---------------- tiny DOM helpers ---------------- */

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = String(v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'disabled' || k === 'checked' || k === 'selected') el[k] = !!v;
        else if (k === 'value') el.value = v;
        else el.setAttribute(k, String(v));
      }
    }
    for (const c of children) {
      if (c === undefined || c === null || c === false) continue;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return el;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function replace(el, ...children) {
    clear(el);
    for (const c of children) {
      if (c === undefined || c === null || c === false || c === '') continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
  }
  function show(el, on) { el.classList.toggle('hidden', !on); }

  const hhmm = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const dur = m => m < 90 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
  const money = (v, digits = 2) => (typeof v === 'number' && Number.isFinite(v)) ? `$${v.toFixed(digits)}` : 'n/a';
  const spent = v => (typeof v !== 'number' || !Number.isFinite(v)) ? 'n/a'
    : (v > 0 && v < 0.01) ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;

  function flash(el, text, ms = 2000, cls = '') {
    el.textContent = text;
    el.className = 'status ' + (cls === 'err' ? 'status-bad' : 'status-good');
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.textContent = ''; el.className = 'status'; }, ms);
  }

  /* ---------------- header + banners ---------------- */

  function pillState(live) {
    if (!live) return { cls: '', text: 'starting' };
    if (live.needsScreenPermission) return { cls: 'pill-bad', text: 'blocked' };
    if (live.configInvalid) return { cls: 'pill-bad', text: 'config error' };
    if (live.needsSubscription) return { cls: 'pill-warn', text: 'subscription' };
    if (live.needsKey) return { cls: 'pill-warn', text: 'key needed' };
    if (live.errorKind === 'cli_auth') return { cls: 'pill-warn', text: 'CLI logged out' };
    if (live.errorKind === 'cli_missing') return { cls: 'pill-bad', text: 'CLI not found' };
    if (live.paused) {
      return { cls: '', text: live.pausedUntil ? `paused until ${hhmm(live.pausedUntil)}` : 'paused' };
    }
    if (live.locked) return { cls: '', text: 'paused' };
    if (live.alerting) return { cls: 'pill-bad', text: 'off task' };
    if (live.capHit) return { cls: 'pill-warn', text: 'daily cap' };
    if (/^idle /.test(live.lastLine || '')) return { cls: '', text: 'idle' };
    return { cls: 'pill-good', text: 'watching' };
  }

  function renderHeader(live) {
    lastLive = live;
    const p = pillState(live);
    $('pill').className = 'pill ' + p.cls;
    $('pill-text').textContent = p.text;
    $('pill').setAttribute('title', (live && live.lastLine) || '');
    $('status-line').textContent = (live && live.lastLine) || '';

    const paused = !!(live && live.paused);
    show($('btn-resume'), paused);
    show($('pause-menu'), !paused);
    $('btn-check').disabled = paused;
    show($('btn-working'), !!(live && live.alerting));
  }

  const BILLING_URL = {
    anthropic: 'https://console.anthropic.com/settings/billing',
    openai: 'https://platform.openai.com/settings/organization/billing'
  };
  function providerOf(cfg) {
    const c = cfg || {};
    return {
      id: c.provider === 'grayout' ? 'grayout' : c.provider === 'openai' ? 'openai' : 'anthropic',
      label: (typeof c.providerLabel === 'string' && c.providerLabel) || 'The provider',
      model: typeof c.model === 'string' ? c.model : '',
      // engine "cli" in config.json: the local Claude CLI on its own login.
      cli: c.engine === 'cli'
    };
  }

  function renderBanners(d) {
    const slot = $('banner-slot');
    const live = d.live || {};
    const who = providerOf(d.config);
    const out = [];

    if (live.needsScreenPermission) {
      out.push(h('div', { class: 'banner banner-bad' },
        h('span', { class: 'grow' }, "Grayout can't see your screen, so nothing is being checked and nothing is being spent. Allow Screen Recording for Grayout, then recheck. If recheck does not clear this, quit and reopen Grayout: macOS applies the permission only on a fresh launch."),
        h('button', { class: 'btn', type: 'button', onclick: () => api.openScreenSettings() }, 'Open Screen Recording settings'),
        h('button', { class: 'btn', type: 'button', onclick: () => { api.recheck(); scheduleRefresh(600); } }, 'Recheck')));
    }
    if (live.needsSubscription && !live.needsScreenPermission) {
      // The loop's own sentence says which of the plan states this is, and it is
      // the only place that knows. Never invent a second wording for it here.
      out.push(h('div', { class: 'banner banner-warn' },
        h('span', { class: 'grow' }, live.lastLine || 'Grayout needs an active subscription to keep checking.'),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => goToAccount() }, 'Open plan')));
    }
    if (live.needsKey && !live.needsSubscription && !live.needsScreenPermission && !live.configInvalid) {
      const rejected = live.errorKind === 'key_rejected';
      out.push(h('div', { class: 'banner banner-warn' },
        h('span', { class: 'grow' }, rejected
          ? `${who.label} rejected the saved model key. Checks are paused until you replace it.`
          : 'No model key for the self-hosted provider. Checks are paused until you add one.'),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => goToSettings(true) }, 'Add key')));
    }
    if (live.configInvalid) {
      out.push(h('div', { class: 'banner banner-bad' },
        h('span', { class: 'grow' }, "config.json has a JSON error, so checks are paused and settings can't be saved. Fix the file; Grayout reloads it on its own."),
        h('button', { class: 'btn', type: 'button', onclick: () => api.openConfigFile() }, 'Open config.json')));
    }
    if (live.errorKind === 'cli_auth' && !live.needsScreenPermission) {
      // How to log back in depends on the binary: a wrapper has its own way.
      const login = live.cliLogin && typeof live.cliLogin.text === 'string' ? live.cliLogin : { command: 'claude auth login', text: 'run claude auth login in Terminal' };
      const fix = login.text.charAt(0).toUpperCase() + login.text.slice(1);
      out.push(h('div', { class: 'banner banner-warn' },
        h('span', { class: 'grow' }, `The Claude CLI is not logged in, so checks are paused. ${fix}, then press Check now.`),
        ...(login.command ? [h('button', { class: 'btn', type: 'button', onclick: () => api.copyText(login.command) }, 'Copy command')] : [])));
    }
    if (live.errorKind === 'cli_missing' && !live.needsScreenPermission) {
      out.push(h('div', { class: 'banner banner-bad' },
        h('span', { class: 'grow' }, "Grayout can't find the Claude CLI, so checks are paused. Install Claude Code, or set cliPath in config.json to the full path of claude."),
        h('button', { class: 'btn', type: 'button', onclick: () => api.openConfigFile() }, 'Open config.json')));
    }
    if (live.errorKind === 'no_credit') {
      out.push(h('div', { class: 'banner banner-bad' },
        h('span', { class: 'grow' }, `Your ${who.label} account has no credit, so checks are paused.`),
        h('button', { class: 'btn', type: 'button', onclick: () => api.openExternal(BILLING_URL[who.id]) }, `Open ${who.label} billing`)));
    }
    if (live.errorKind === 'bad_model') {
      out.push(h('div', { class: 'banner banner-bad' },
        h('span', { class: 'grow' }, who.cli
          ? `Your Claude account can't use ${who.model || 'the configured model'} through the CLI. Set model in config.json.`
          : `This ${who.label} account can't use ${who.model || 'the configured model'}. Try a different key or set model in config.json.`),
        h('button', { class: 'btn', type: 'button', onclick: () => api.openConfigFile() }, 'Open config.json')));
    }
    if (d.update && d.update.url) {
      const v = d.update.version || d.update.tag || '';
      out.push(h('div', { class: 'banner' },
        h('span', { class: 'grow' }, `Grayout ${v ? 'v' + String(v).replace(/^v/, '') : 'update'} is available.`),
        h('button', { class: 'btn', type: 'button', onclick: () => api.openExternal(d.update.url) }, 'Download')));
    }
    replace(slot, ...out);
  }

  /* ---------------- day picker ---------------- */

  function renderDays(days, active) {
    const wrap = $('days');
    replace(wrap, ...days.slice(-7).map(dk => {
      const label = new Date(dk + 'T12:00:00').toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
      return h('button', {
        type: 'button', class: 'btn' + (dk === active ? ' on' : ''), 'data-day': dk,
        onclick: () => { day = dk; refresh(); }
      }, label);
    }));
  }

  /* ---------------- strip ---------------- */

  // Bucket consecutive checks so the whole day fits the strip's width.
  function bucketCells(cells, width) {
    const MIN_CELL = 3, GAP_PX = 2, MARK_PX = 13;
    const gaps = cells.filter(c => c.gap).length;
    const checks = cells.length - gaps;
    const budget = Math.max(60, width - gaps * MARK_PX - Math.max(0, gaps) * GAP_PX);
    const fit = Math.max(1, Math.floor((budget + GAP_PX) / (MIN_CELL + GAP_PX)));
    const k = Math.max(1, Math.ceil(checks / fit));
    if (k === 1) return cells;
    const out = [];
    let run = [];
    const flush = () => {
      for (let i = 0; i < run.length; i += k) {
        const grp = run.slice(i, i + k);
        const offs = grp.filter(c => c.off);
        const last = grp[grp.length - 1];
        out.push({
          ts: grp[0].ts, tsEnd: last.ts, n: grp.length,
          off: offs.length > 0, fired: grp.some(c => c.fired), disputed: grp.some(c => c.disputed),
          activity: (offs.length ? offs[offs.length - 1] : last).activity || ''
        });
      }
      run = [];
    };
    for (const c of cells) {
      if (c.gap) { flush(); out.push(c); } else run.push(c);
    }
    flush();
    return out;
  }

  function renderStrip(cells) {
    const strip = $('strip');
    const width = strip.clientWidth || 800;
    const items = bucketCells(cells || [], width);
    replace(strip, ...items.map(c => {
      if (c.gap) {
        return h('span', { class: 'gap', title: `away for ${dur(c.gap)}: no checks, nothing spent` });
      }
      const cls = 'cell' + (c.off ? ' off' : '') + (c.fired ? ' fired' : '');
      const when = c.n > 1 ? `${hhmm(c.ts)}-${hhmm(c.tsEnd)} · ${c.n} checks` : hhmm(c.ts);
      const what = (c.off ? 'OFF TASK' : 'working') + (c.activity ? ` · ${c.activity}` : '') + (c.disputed ? ' · disputed' : '');
      return h('span', { class: cls, title: `${when} · ${what}` });
    }));
  }

  /* ---------------- flags ---------------- */

  function renderFlags(flags) {
    const box = $('flags');
    if (!flags || !flags.length) {
      replace(box, h('div', { class: 'empty' }, 'Nothing flagged. Clean run.'));
      return;
    }
    const rows = flags.map(f => {
      const result = h('td', { class: 'r' },
        f.fired ? h('span', { class: 'tag hit' }, 'screen red') : h('span', { class: 'tag warn' }, '1st strike'),
        f.disputed ? h('span', { class: 'tag disputed' }, 'disputed') : null);
      const copyBtn = h('button', { type: 'button', class: 'link link-small', title: 'Copy this verdict line for a bug report' }, 'Copy');
      copyBtn.addEventListener('click', async () => {
        let ok = false;
        try { ok = await api.copyVerdictLine(f.ts); } catch {}
        copyBtn.textContent = ok ? 'Copied' : 'Not found';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
      });
      const actions = h('td', { class: 'a' },
        f.disputed ? null : h('button', {
          type: 'button', class: 'btn btn-sm', title: 'Marks this check as a wrong call in the log and backs off for a few minutes',
          onclick: async ev => {
            ev.currentTarget.disabled = true;
            try { await api.dispute(f.ts); } catch {}
            scheduleRefresh(150);
          }
        }, 'Wrong call?'),
        copyBtn);
      const what = h('td', null, f.activity || '(no description)');
      if (f.app) what.appendChild(h('span', { class: 'app' }, f.app));
      return h('tr', null, h('td', { class: 't' }, hhmm(f.ts)), what, result, actions);
    });
    replace(box, h('div', { class: 'tablewrap' },
      h('table', null,
        h('thead', null, h('tr', null,
          h('th', null, 'Time'), h('th', null, 'What it saw'), h('th', { class: 'r' }, 'Result'), h('th', { class: 'a' }, ''))),
        h('tbody', null, ...rows))));
  }

  /* ---------------- stats + cost ---------------- */

  function renderStats(s) {
    const tiles = [
      ['Checks', s.checks, ''],
      ['On task', s.on, ''],
      ['Flagged', s.off, ''],
      ['Screen punished', s.punishedMin, ' min'],
      ['Longest streak', s.longestStreak, ' checks'],
      ['Displays', s.maxDisplays || 1, ''],
      // On the subscription the price is the subscription, so a dollar figure
      // here would be a number nobody is billed. Show the allowance instead.
      selfHosted() ? ['Spent', spent(s.costToday), ''] : ['Checks this month', monthChecksLabel(), '']
    ];
    replace($('stats'), ...tiles.map(([k, v, u]) =>
      h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, String(v), h('small', null, u)))));
  }

  /** true while checks run through the Claude CLI (engine "cli" in config.json). */
  function usesCli() {
    if (lastData && lastData.config && typeof lastData.config.engine === 'string') return lastData.config.engine === 'cli';
    return !!(settings && settings.estimates && settings.estimates.engine === 'cli');
  }

  /** true while checks do not go through the hosted service: a self-hosted key, or the Claude CLI. */
  function selfHosted() {
    if (lastData && typeof lastData.selfHosted === 'boolean') return lastData.selfHosted;
    if (settings && typeof settings.selfHosted === 'boolean') return settings.selfHosted;
    return false;
  }

  function accountOf() {
    return (lastData && lastData.account) || (settings && settings.account) || null;
  }

  /** The paid monthly allowance, from src/pricing.js by way of the main process. */
  function includedChecks() {
    for (const src of [lastData, settings]) {
      if (src && Number.isFinite(src.includedChecks)) return src.includedChecks;
    }
    return null;
  }

  function monthChecksLabel() {
    const a = accountOf();
    const u = a && a.usage;
    if (!u || !Number.isFinite(u.checksUsed)) return '–';
    return Number.isFinite(u.checksIncluded)
      ? `${u.checksUsed.toLocaleString('en-US')} / ${u.checksIncluded.toLocaleString('en-US')}`
      : u.checksUsed.toLocaleString('en-US');
  }

  function renderCost(s) {
    if (!selfHosted()) {
      // A subscriber's meaningful number is checks against the allowance.
      const a = accountOf();
      const u = a && a.usage;
      $('cost').textContent = (!s.checks || !u || !Number.isFinite(u.checksUsed))
        ? ''
        : a.hasLicense
          ? `${u.checksUsed.toLocaleString('en-US')} of ${Number.isFinite(u.checksIncluded) ? u.checksIncluded.toLocaleString('en-US') : '?'} checks used this month.`
          : `${u.checksUsed.toLocaleString('en-US')} of ${Number.isFinite(u.checksIncluded) ? u.checksIncluded.toLocaleString('en-US') : '?'} free checks used.`;
      return;
    }
    const when = s.isToday ? 'today' : 'that day';
    let line;
    if (!s.checks) line = '';
    // On a Claude subscription a check costs nothing extra; only paid overage is priced.
    else if (usesCli() && !s.costToday) line = `${s.checksToday} check${s.checksToday === 1 ? '' : 's'} ${when} through the Claude CLI on your Claude subscription, with no per-check charge.`;
    else if (!s.pricedChecks) line = `Spent ${when}: n/a. No price is known for this model, so nothing was counted.`;
    else {
      line = `Spent ${when}: ${spent(s.costToday)} over ${s.checksToday} check${s.checksToday === 1 ? '' : 's'}`;
      if (typeof s.spentMonthProjection === 'number') {
        const m = s.spentMonthProjection;
        line += ` · about ${m >= 1 ? '$' + Math.round(m) : money(m)}/month at this pace`;
      } else {
        line += ' · not enough data yet for a monthly estimate';
      }
    }
    $('cost').textContent = line;
  }

  /* ---------------- main render ---------------- */

  function render(d) {
    lastData = d;
    const s = d.stats || {};
    renderHeader(d.live);
    renderBanners(d);
    renderDays(s.days || [], s.day);

    const cfg = d.config || {};
    $('flags-note').textContent = cfg.strikes === 1
      ? 'One clearly-off-task flag turns the screen red.'
      : `${cfg.strikes || 2} flags in a row turn the screen red. One on its own is forgiven.`;

    if (d.dataDir) $('footer-path').textContent = `${d.dataDir}/verdicts.jsonl`;
    $('footer-kept').textContent = cfg.historyDays ? `(kept ${cfg.historyDays} days).` : '';
    if (d.version) $('version-line').textContent = `Grayout ${d.version}`;
    renderAccount(d);
    if (!keyEditing()) renderKeyCurrent(d.hasKey, d.keyMasked, d.config);

    if (s.empty || !s.checks) {
      $('pct').textContent = '–';
      $('headline').textContent = d.live && d.live.needsSubscription
        ? 'No checks yet. Sort out the plan below to start.'
        : d.live && d.live.needsKey
          ? 'No checks yet. Add a model key below to start.'
          : 'No checks recorded for this day yet.';
      $('cost').textContent = '';
      clear($('strip')); $('ax-a').textContent = ''; $('ax-b').textContent = '';
      replace($('flags'), h('div', { class: 'empty' }, 'Nothing yet.'));
      clear($('stats'));
      return;
    }

    replace($('pct'), document.createTextNode(String(s.focusPct)), h('span', null, '%'));
    const when = s.isToday ? 'so far today' : 'that day';
    const head = $('headline');
    if (s.off === 0) {
      replace(head, h('strong', null, 'Clean.'), ` ${s.checks} checks ${when} and it never once caught you off task.`);
    } else {
      const tail = s.firedChecks > 0
        ? ` The screen went red and grayscale for about ${s.punishedMin} minute${s.punishedMin === 1 ? '' : 's'}.`
        : ' Never twice in a row, so the screen never actually turned.';
      replace(head, h('strong', null, `It caught you ${s.off === 1 ? 'once' : s.off + ' times'}.`), tail);
    }
    renderCost(s);
    renderStrip(s.cells);
    $('ax-a').textContent = hhmm(s.firstTs);
    $('ax-b').textContent = hhmm(s.lastTs);
    renderFlags(s.flags);
    renderStats(s);
  }

  async function refresh() {
    if (!api) return;
    try { render(await api.get(day)); }
    catch (e) { console.error(e); }
  }
  function scheduleRefresh(ms) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, ms);
  }

  /* ---------------- header actions ---------------- */

  function minutesUntilSix() {
    const now = new Date();
    const t = new Date(now);
    t.setHours(6, 0, 0, 0);
    if (t <= now) t.setDate(t.getDate() + 1);
    return Math.max(1, Math.ceil((t - now) / 60000));
  }

  function wireHeader() {
    $('btn-check').addEventListener('click', async () => { try { await api.checkNow(); } catch {} scheduleRefresh(400); });
    $('btn-resume').addEventListener('click', async () => { try { await api.resume(); } catch {} scheduleRefresh(150); });
    $('btn-working').addEventListener('click', async () => { try { await api.dispute(null); } catch {} scheduleRefresh(150); });
    $('btn-restore').addEventListener('click', async () => { try { await api.restoreColor(); } catch {} scheduleRefresh(150); });
    const menu = $('pause-menu');
    for (const b of menu.querySelectorAll('button[data-pause]')) {
      b.addEventListener('click', async () => {
        menu.open = false;
        const v = b.getAttribute('data-pause');
        try {
          if (v === 'indefinite') await api.pause();
          else if (v === 'tomorrow') await api.pauseFor(minutesUntilSix());
          else await api.pauseFor(Number(v));
        } catch {}
        scheduleRefresh(150);
      });
    }
    document.addEventListener('click', ev => { if (menu.open && !menu.contains(ev.target)) menu.open = false; });
    document.addEventListener('keydown', ev => {
      // Escape only closes the pause menu. It never submits, saves, or clears anything.
      if (ev.key === 'Escape') { if (menu.open) menu.open = false; }
    });
  }

  /* ---------------- settings ---------------- */

  const BOOL_KEYS = ['grayscale', 'redFlash', 'camera', 'startAtLogin', 'checkForUpdates', 'pauseWhenLocked'];
  const INTERVALS = [30, 45, 60, 90, 120];

  function renderIntervalRadios(cfg, estimates) {
    const box = $('interval-radios');
    const by = (estimates && estimates.byInterval) || {};
    const current = Number(cfg.checkIntervalSec) || 45;
    const list = INTERVALS.slice();
    if (!list.includes(current)) list.push(current);
    list.sort((a, b) => a - b);
    const hosted = !selfHosted();
    const cli = !!(estimates && estimates.engine === 'cli');
    replace(box, ...list.map(s => {
      const row = by[s];
      const est = cli
        ? 'no per-check charge'
        : hosted
          ? (row && Number.isFinite(row.checks) ? `about ${row.checks.toLocaleString('en-US')} checks a day` : '')
          : (row && typeof row.daily === 'number' ? `about ${money(row.daily)} a day` : (INTERVALS.includes(s) ? 'price unknown for this model' : 'set in config.json'));
      const input = h('input', { type: 'radio', name: 'interval', value: String(s), checked: s === current });
      return h('label', { class: 'radio-row' }, input,
        h('span', { class: 'radio-text' }, `Every ${s} seconds`),
        h('span', { class: 'radio-aside' }, est));
    }));
    if (hosted) {
      // The allowance to quote is the PLAN's, from src/pricing.js — never
      // account.usage.checksIncluded, which on the free taste is the 100-check
      // taste and is not a monthly allowance at all.
      const acct = accountOf();
      const included = includedChecks();
      const tail = !included ? ''
        : acct && acct.hasLicense ? ` Your plan includes ${commas(included)} checks a month.`
        : ` A paid plan includes ${commas(included)} checks a month.`;
      $('interval-note').textContent = `An upper bound: change-gating skips the check when nothing on screen moved, so the real count is usually about half of this.${tail}`;
      return;
    }
    const who = providerOf(estimates);
    if (cli) {
      $('interval-note').textContent = `Checks run through the Claude CLI (${who.model || cfg.model}) on your Claude subscription, so there is no per-check charge. Each check counts toward the plan's usage limits.`;
      return;
    }
    const pd = estimates && estimates.priceDate ? `, at prices on ${estimates.priceDate}` : '';
    $('interval-note').textContent = `Estimates for ${who.label} ${who.model || cfg.model || 'the configured model'} on one display${pd}. A second display roughly doubles it; the webcam adds about 15%.`;
  }

  function renderChips(key) {
    const box = $(key === 'alwaysAllowedApps' ? 'chips-allowed' : 'chips-never');
    const list = chips[key];
    replace(box, ...list.map((name, i) =>
      h('span', { class: 'chip', title: name }, h('span', null, name),
        h('button', { type: 'button', title: `Remove ${name}`, 'aria-label': `Remove ${name}`, onclick: () => { list.splice(i, 1); renderChips(key); } }, '×'))));
    if (!list.length) box.appendChild(h('span', { class: 'muted', style: 'font-size:12.5px' }, 'None.'));
  }

  function addChip(key, inputId) {
    const input = $(inputId);
    const v = input.value.trim().slice(0, 80);
    if (!v) return;
    if (!chips[key].some(x => x.toLowerCase() === v.toLowerCase())) chips[key].push(v);
    input.value = '';
    renderChips(key);
  }

  function loginText(li) {
    if (!li) return '';
    if (li.inApplications === false) return 'Move Grayout to your Applications folder to start it at login.';
    switch (li.status) {
      case 'enabled': return 'Enabled.';
      case 'requires-approval': return 'macOS wants you to approve this: ';
      case 'not-registered': return 'Not registered yet. Turn it on and save.';
      case 'not-found': return 'macOS could not find the app to register. Turn it on and save to retry.';
      case 'not-in-applications': return 'Move Grayout to your Applications folder to start it at login.';
      default: return '';
    }
  }

  function renderLogin(li) {
    const note = $('login-note');
    const t = $('f-startAtLogin');
    const blocked = !li || li.inApplications === false || li.status === 'not-in-applications';
    t.disabled = blocked;
    if (blocked) t.checked = false;
    replace(note, document.createTextNode(loginText(li)),
      li && li.status === 'requires-approval'
        ? h('button', { type: 'button', class: 'link', onclick: () => api.openLoginItems() }, 'Open Login Items settings')
        : null);
  }

  function permLabel(kind, v) {
    if (kind === 'screen') {
      return { granted: 'Allowed', denied: 'Not allowed', stale: 'Allowed, but stale', 'not-determined': 'Not asked yet', restricted: 'Restricted' }[v] || String(v || 'unknown');
    }
    if (kind === 'camera') {
      return { granted: 'Allowed', denied: 'Not allowed', 'not-determined': 'Not asked yet', restricted: 'Restricted' }[v] || String(v || 'unknown');
    }
    return { enabled: 'Enabled', 'requires-approval': 'Needs approval', 'not-registered': 'Not registered', 'not-found': 'Not found', 'not-in-applications': 'Not in Applications' }[v] || String(v || 'unknown');
  }
  function permClass(kind, v) {
    if (v === 'granted' || v === 'enabled') return 'pill pill-good';
    if (v === 'denied' || v === 'restricted' || (kind === 'screen' && v === 'stale')) return 'pill pill-bad';
    if (v === 'requires-approval') return 'pill pill-warn';
    return 'pill';
  }

  function renderPermissions(p, li, tcc) {
    if (p) {
      $('perm-screen').textContent = permLabel('screen', p.screen);
      $('perm-screen').className = permClass('screen', p.screen);
      $('perm-camera').textContent = permLabel('camera', p.camera);
      $('perm-camera').className = permClass('camera', p.camera);
      renderCameraNote(p.camera);
    }
    if (li) {
      $('perm-login').textContent = permLabel('login', li.status);
      $('perm-login').className = permClass('login', li.status);
    }
    if (tcc) $('tcc-cmd').textContent = tcc;
  }

  function renderCameraNote(status) {
    const n = $('camera-note');
    n.className = 'hint';
    if (status === 'denied' || status === 'restricted') {
      n.className = 'hint warn';
      replace(n, document.createTextNode('macOS is not allowing Grayout to use the camera. '),
        h('button', { type: 'button', class: 'link', onclick: () => api.openCameraSettings() }, 'Open Camera settings'));
    } else if (status === 'granted') {
      n.textContent = 'Camera access is allowed.';
    } else {
      n.textContent = '';
    }
  }

  function keyEditing() { return document.activeElement === $('f-key') || $('f-key').value.length > 0; }

  // `active` is either dash:get's config or settings:get's estimates; both
  // carry provider, providerLabel and model for the saved key.
  function renderKeyCurrent(hasKey, masked, active) {
    const who = providerOf(active);
    if (who.cli) {
      $('key-current').textContent = 'Checks run through the Claude CLI on your Claude subscription (engine "cli" in config.json), so no model key is used.' +
        (hasKey ? ` The saved key (${masked || 'saved'}) stays unused unless engine goes back to "api".` : '');
      show($('btn-key-remove'), !!hasKey);
      return;
    }
    const using = active && active.providerLabel ? ` Using ${who.label}${who.model ? `, ${who.model}` : ''}.` : '';
    $('key-current').textContent = hasKey
      ? `Current key: ${masked || 'saved'}.${using} Paste a new one to replace it.`
      : 'No model key saved. Checks are paused until you add one. Anthropic keys start with sk-ant-, OpenAI keys with sk-proj- or sk-.';
    show($('btn-key-remove'), !!hasKey);
  }

  function fillForm(st) {
    const cfg = st.config || {};
    renderIntervalRadios(cfg, st.estimates);
    const strikes = $('f-strikes');
    const cur = Number(cfg.strikes) || 2;
    if (![...strikes.options].some(o => Number(o.value) === cur)) strikes.appendChild(h('option', { value: String(cur) }, String(cur)));
    strikes.value = String(cur);
    $('f-work').value = cfg.workDescription || '';
    updateCounter();
    for (const k of BOOL_KEYS) $('f-' + k).checked = !!cfg[k];
    chips = {
      alwaysAllowedApps: Array.isArray(cfg.alwaysAllowedApps) ? cfg.alwaysAllowedApps.slice() : [],
      neverCaptureApps: Array.isArray(cfg.neverCaptureApps) ? cfg.neverCaptureApps.slice() : []
    };
    renderChips('alwaysAllowedApps');
    renderChips('neverCaptureApps');
    renderLogin(st.loginItem);
    renderPermissions(st.permissions, st.loginItem, st.tccResetCmd);
    renderAccount(st);
    show($('key-panel'), st.selfHosted !== false);
    renderKeyCurrent(st.hasKey, st.keyMasked, st.estimates);
    $('consequence-note').textContent = (!cfg.grayscale && !cfg.redFlash)
      ? 'Both off: Grayout will only log what it sees.' : '';
    if (st.secureStorage === false) {
      setMsg('key-msg', 'Secure storage is not available on this Mac, so a key cannot be saved here.', 'err');
      $('btn-key-save').disabled = true;
    }
    if (st.version) $('version-line').textContent = `Grayout ${st.version}${st.isPackaged === false ? ' (running from source)' : ''}`;
  }

  function readForm() {
    const out = {};
    const r = document.querySelector('input[name="interval"]:checked');
    out.checkIntervalSec = r ? Number(r.value) : 45;
    out.strikes = Number($('f-strikes').value) || 2;
    out.workDescription = $('f-work').value.slice(0, 500);
    for (const k of BOOL_KEYS) out[k] = $('f-' + k).checked;
    out.alwaysAllowedApps = chips.alwaysAllowedApps.slice();
    out.neverCaptureApps = chips.neverCaptureApps.slice();
    return out;
  }

  function sameList(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
  }

  // Only the keys that differ from the loaded config are sent.
  function diffForm() {
    const base = (settings && settings.config) || {};
    const now = readForm();
    const partial = {};
    for (const [k, v] of Object.entries(now)) {
      if (Array.isArray(v)) { if (!sameList(v, base[k])) partial[k] = v; }
      else if (v !== base[k]) partial[k] = v;
    }
    return partial;
  }

  function updateCounter() {
    const n = $('f-work').value.length;
    $('work-counter').textContent = `${n} / 500`;
  }

  function setMsg(id, text, cls) {
    const el = $(id);
    el.textContent = text || '';
    el.className = 'status' + (cls === 'ok' ? ' status-good' : cls === 'err' ? ' status-bad' : '');
  }

  async function loadSettings(force) {
    if (!api) return;
    if (settingsLoading) return settingsLoading;
    if (settings && !force && Object.keys(diffForm()).length) return; // don't clobber unsaved edits
    settingsLoading = (async () => {
      try {
        const st = await api.getSettings();
        settings = st;
        fillForm(st);
      } catch (e) { console.error(e); }
      finally { settingsLoading = null; }
    })();
    return settingsLoading;
  }

  async function saveSettings(ev) {
    if (ev) ev.preventDefault();
    if (!api) return;
    const partial = diffForm();
    const statuses = [$('save-status'), $('save-status-2')];
    if (!Object.keys(partial).length) { statuses.forEach(s => flash(s, 'No changes')); return; }
    $('btn-save').disabled = true;
    try {
      const r = await api.saveSettings(partial);
      if (r && r.config) {
        settings = { ...settings, config: r.config, loginItem: r.loginItem || settings.loginItem, estimates: r.estimates || settings.estimates };
        // Re-fill from what the app actually kept (bounds, login item refusals).
        const keepKeyMsg = $('key-msg').textContent;
        const keepKeyCls = $('key-msg').className.includes('status-bad') ? 'err' : ($('key-msg').className.includes('status-good') ? 'ok' : '');
        fillForm(settings);
        setMsg('key-msg', keepKeyMsg, keepKeyCls);
        if (partial.startAtLogin !== undefined && r.loginItem) renderLogin(r.loginItem);
        if (partial.startAtLogin && r.loginItem && r.loginItem.status === 'not-in-applications') {
          statuses.forEach(s => flash(s, 'Saved, except start at login', 3000, 'err'));
        } else {
          statuses.forEach(s => flash(s, 'Saved'));
        }
      } else {
        statuses.forEach(s => flash(s, (r && typeof r.error === 'string' && r.error) || 'Could not save', 6000, 'err'));
      }
    } catch (e) {
      console.error(e);
      statuses.forEach(s => flash(s, 'Could not save', 3000, 'err'));
    } finally {
      $('btn-save').disabled = false;
      scheduleRefresh(200);
    }
  }

  async function onCameraToggle(ev) {
    const t = ev.currentTarget;
    if (!t.checked) return;
    t.disabled = true;
    try {
      const r = await api.requestCamera();
      if (r && r.granted) {
        renderCameraNote(r.status || 'granted');
        $('perm-camera').textContent = permLabel('camera', r.status || 'granted');
        $('perm-camera').className = permClass('camera', r.status || 'granted');
      } else {
        t.checked = false;
        renderCameraNote((r && r.status) || 'denied');
        if (r && r.status === 'not-determined') $('camera-note').textContent = 'Camera access was not granted.';
      }
    } catch { t.checked = false; }
    finally { t.disabled = false; }
  }

  /* ---------------- API key ---------------- */

  // Same synthetic frame as onboarding: a fake code editor, so the exact
  // production code path is exercised without sending a real screenshot.
  function syntheticFrameB64() {
    const W = 1366, H = 768;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#1e1e1e'; g.fillRect(0, 0, W, H);
    // tab bar
    g.fillStyle = '#252526'; g.fillRect(0, 0, W, 36);
    g.fillStyle = '#1e1e1e'; g.fillRect(0, 0, 150, 36);
    g.fillStyle = '#d4d4d4'; g.font = '13px Menlo, monospace'; g.textBaseline = 'middle';
    g.fillText('loop.js', 16, 18);
    g.fillStyle = '#8b8b8b'; g.fillText('stats.js', 166, 18); g.fillText('README.md', 240, 18);
    // gutter + code
    g.fillStyle = '#1e1e1e'; g.fillRect(0, 36, W, H - 36);
    const lines = [
      ["'use strict';", '#ce9178'],
      ["const fs = require('fs');", '#9cdcfe'],
      ["const path = require('path');", '#9cdcfe'],
      ['', ''],
      ['function summarize(rows, opts = {}) {', '#dcdcaa'],
      ['  const intervalSec = opts.intervalSec || 45;', '#9cdcfe'],
      ['  const list = rows.filter(r => r.type !== "dispute");', '#9cdcfe'],
      ['  let best = 0, cur = 0;', '#9cdcfe'],
      ['  for (const r of list) {', '#c586c0'],
      ['    if (r.off) { cur = 0; continue; }', '#c586c0'],
      ['    cur++;', '#9cdcfe'],
      ['    if (cur > best) best = cur;', '#c586c0'],
      ['  }', '#d4d4d4'],
      ['  return { checks: list.length, longestStreak: best };', '#c586c0'],
      ['}', '#d4d4d4'],
      ['', ''],
      ['module.exports = { summarize };', '#9cdcfe']
    ];
    g.font = '15px Menlo, monospace';
    let y = 62;
    for (let i = 0; i < 30; i++) {
      g.fillStyle = '#5a5a5a'; g.textAlign = 'right'; g.fillText(String(i + 1), 52, y);
      g.textAlign = 'left';
      const l = lines[i];
      if (l && l[0]) { g.fillStyle = l[1]; g.fillText(l[0], 76, y); }
      y += 22;
    }
    // terminal pane
    g.fillStyle = '#181818'; g.fillRect(0, H - 150, W, 150);
    g.fillStyle = '#3c3c3c'; g.fillRect(0, H - 150, W, 1);
    g.fillStyle = '#9cdcfe'; g.font = '13px Menlo, monospace';
    g.fillText('TERMINAL', 16, H - 130);
    g.fillStyle = '#d4d4d4';
    g.fillText('$ npm test', 16, H - 100);
    g.fillText('# tests 12', 16, H - 78);
    g.fillText('# pass 12', 16, H - 56);
    g.fillText('$ ', 16, H - 30);
    const url = c.toDataURL('image/jpeg', 0.7);
    return url.slice(url.indexOf(',') + 1);
  }

  function keyTestMessage(r) {
    if (!r) return ['Something went wrong. Try again.', 'err'];
    const who = (typeof r.providerLabel === 'string' && r.providerLabel) || 'The provider';
    if (r.ok) {
      const which = r.model ? `${who}, ${r.model}` : who;
      const cost = typeof r.costUsd === 'number' ? ` That check cost ${r.costUsd < 0.01 ? '$' + r.costUsd.toFixed(4) : money(r.costUsd)}` : '';
      const saw = r.verdict && r.verdict.activity ? ` and the model saw: ${r.verdict.activity}.` : (cost ? '.' : '');
      return [`Key works (${which}).${cost}${saw}`, 'ok'];
    }
    const est = settings && settings.estimates;
    const model = (est && est.provider === r.provider && est.model) || 'the configured model';
    switch (r.kind) {
      case 'key_rejected': return [`${who} rejected this key. Check for missing characters or make a new one.`, 'err'];
      case 'no_credit': return [`This ${who} account has no credit. Add $5 in its billing settings, then test again.`, 'err'];
      case 'network': return [`Couldn't reach ${who}. Check your connection and try again.`, 'err'];
      case 'bad_model': return [`This account can't use ${model}. Try a different key or set model in config.json.`, 'err'];
      case 'rate_limited': case 'overloaded': return [`${who} is busy right now. Try again in a minute.`, 'err'];
      case 'no_key': return ['Paste a key first.', 'err'];
      default: return [r.message || 'The test failed.', 'err'];
    }
  }

  /* ---------------- the plan ----------------
     Every price and count here comes from the main process (src/pricing.js), so
     nothing on this panel can drift from what the service charges. A failure in
     any of it changes wording only: nothing here can gray or un-gray a Mac.
     Payments are Stripe Managed Payments: Stripe, selling through Link, is the
     seller, so a purchase can always be managed at link.com as well. */

  let claiming = false;   // a browser checkout is open and /v1/claim is polling
  let acctBusy = false;

  const commas = n => (Number.isFinite(n) ? n.toLocaleString('en-US') : '–');
  const MANAGE = 'You can also manage it at link.com, where this purchase is listed as Sold through Link.';

  function planLabel(d, id) {
    const p = d && d.plans && d.plans[id];
    return p && p.priceLabel ? `${p.priceLabel} ${p.periodLabel}` : null;
  }

  /** The one sentence at the top of the panel. Always the service's word on access. */
  function accountSentence(d) {
    const a = d.account || {};
    const u = a.usage || {};
    if (a.configured === false) {
      return 'This build of Grayout is not connected to the Grayout service yet, so subscriptions are not available in it.';
    }
    // The key may well be on this Mac, locked in the Keychain. Buying again
    // could mean a second subscription, so this says how to unlock it.
    if (a.secretsLocked) {
      return 'Grayout could not unlock its saved keys in the macOS Keychain, so it cannot tell which plan this Mac has. Quit and reopen Grayout, and choose Always Allow if macOS asks about "Grayout Safe Storage". Or paste your license key below.';
    }
    // No key on this Mac, but the service has said why it will not serve it.
    // Neither of these is the free taste, and neither may say "subscribe".
    if (!a.hasLicense && a.problem === 'license_revoked') {
      return 'The subscription on file for this Mac was refunded or disputed, so it no longer works. Write to the support address on the Grayout site to start again.';
    }
    if (!a.hasLicense && a.problem === 'no_license') {
      return 'This Mac has a subscription on file, but its key is missing. Press Restore my key, or paste the key below.';
    }
    if (!a.hasLicense) {
      const used = commas(u.checksUsed);
      const included = commas(u.checksIncluded);
      const m = planLabel(d, 'monthly');
      const y = planLabel(d, 'yearly');
      const prices = m && y ? ` Grayout is ${m} or ${y}, plus tax where it applies.` : '';
      if (a.problem === 'free_exhausted' && a.problemReason === 'daily_budget') {
        return `Free checks are paused for today because of demand. They come back after midnight UTC, or subscribe to keep going.${prices}`;
      }
      return `Free taste: ${used} of ${included} checks used. No card, no account.${prices}`;
    }
    const masked = a.licenseMasked ? ` (${a.licenseMasked})` : '';
    const plan = a.interval === 'yearly' ? 'yearly' : a.interval === 'monthly' ? 'monthly' : '';
    const ends = a.periodEnd ? dayLabel(a.periodEnd) : '';
    if (a.problem === 'license_revoked') return `This subscription was refunded or disputed${masked}, so it no longer works. Write to the support address on the Grayout site to start again.`;
    if (a.problem === 'license_invalid') return `The saved license key${masked} is not one Grayout issued. Paste the right key below.`;
    switch (a.status) {
      case 'trialing': {
        const until = a.trialEnd ? dayLabel(a.trialEnd) : ends;
        if (a.cancelAtPeriodEnd) return `On the free trial${masked}. It is set to cancel, so it ends${until ? ` on ${until}` : ''} without a charge.`;
        return `On the free trial${masked}${until ? ` until ${until}` : ''}. It then becomes the ${plan || 'paid'} plan unless you cancel. Grayout reminds you about two days before the first charge.`;
      }
      case 'active':
        if (a.cancelAtPeriodEnd) return `Subscribed${plan ? `, ${plan}` : ''}${masked}. It is set to cancel and stops${ends ? ` on ${ends}` : ' at the end of this period'}.`;
        return `Subscribed${plan ? `, ${plan}` : ''}${masked}.${ends ? ` Renews ${ends}.` : ''}`;
      case 'past_due':
        return a.service === false
          ? `The last payment did not go through${masked}, so checks are paused. Update your card in Manage subscription or at link.com.`
          : `The last payment did not go through${masked}. Update your card in Manage subscription or at link.com to keep Grayout watching.`;
      case 'canceled':
        return `This subscription has ended${masked}. Subscribe again to keep Grayout watching.`;
      case 'free':
        return `A license is saved${masked}, but the service has not confirmed a plan for it yet.`;
      default:
        return `A license is saved${masked}. Checking with the service.`;
    }
  }

  function renderAccount(d) {
    if (!d) return;
    const self = d.selfHosted === true;
    show($('account-panel'), !self);
    if (self) return;

    const a = d.account || {};
    const u = a.usage || {};
    const connected = a.configured !== false;
    $('account-line').textContent = accountSentence(d);
    const revoked = a.problem === 'license_revoked';
    // The meter resets at 00:00 UTC on the 1st, so print that date in UTC:
    // in a US evening it would otherwise read as the last day of the month.
    $('account-usage').textContent = connected && a.hasLicense && !revoked && Number.isFinite(u.checksUsed)
      ? `${commas(u.checksUsed)} of ${commas(u.checksIncluded)} checks used this month${u.resetsAt ? `; the count resets ${dayLabel(u.resetsAt, true)}` : ''}.`
      : '';

    // Subscribe is the way out of every state except one the service is
    // serving (`service` is the service's own answer; never worked out here)
    // and a payment to fix: a past-due subscriber updates the card in Manage
    // subscription instead of starting a second subscription.
    const serving = a.hasLicense && a.service !== false && (a.status === 'active' || a.status === 'trialing');
    const pastDue = a.hasLicense && a.status === 'past_due';
    // The service has a subscription on file for this Mac but the key is not
    // here: the way out is Restore my key, never a second purchase.
    const keyMissing = !a.hasLicense && a.problem === 'no_license';
    const canSubscribe = connected && !serving && !pastDue && !revoked && !keyMissing && !a.secretsLocked;
    show($('btn-subscribe'), canSubscribe);
    show($('plan-pick'), canSubscribe);
    show($('buy-note'), canSubscribe && !a.hasLicense);
    renderPlanChoices(d);
    // A refunded or disputed key has nothing left to manage.
    show($('btn-manage'), connected && !!a.hasLicense && !revoked);
    // The account panel's own button. The header's "Restore color" is a
    // different button (#btn-restore) and is never hidden or disabled here.
    show($('btn-restore-key'), connected && !a.hasLicense && !revoked);
    show($('license-row'), connected && (!a.hasLicense || !serving));
    show($('btn-link'), connected);
    show($('billing-note'), connected);
    // The website buys with a browser device that is never attached to this
    // Mac, so for anyone who already has a key here, or a subscription on
    // file, it is the wrong way back: both plans are on this panel instead.
    show($('btn-plans'), canSubscribe && !a.hasLicense);
    if (!claiming && !acctBusy) syncAccountButtons();
  }

  /** The price and trial next to each plan choice, read from src/pricing.js (never typed here). */
  function renderPlanChoices(d) {
    const m = d && d.plans && d.plans.monthly;
    const y = d && d.plans && d.plans.yearly;
    if (m && m.priceLabel) {
      // The trial is the service's call (contract 6.5): only a first subscription gets one.
      const trial = m.trialDays ? ` A first subscription starts with a ${m.trialDays}-day free trial.` : '';
      $('dash-price-monthly').textContent = `${m.priceLabel} ${m.periodLabel}, plus tax where it applies.${trial}`;
    }
    if (y && y.priceLabel) {
      const per = y.perMonthLabel ? ` (${y.perMonthLabel} a month)` : '';
      $('dash-price-yearly').textContent = `${y.priceLabel} ${y.periodLabel}${per}, plus tax where it applies.`;
    }
  }

  /** The plan picked on the panel: monthly unless Yearly is checked. */
  function chosenPlan() {
    const picked = document.querySelector('input[name="dash-plan"]:checked');
    return picked && picked.value === 'yearly' ? 'yearly' : 'monthly';
  }

  /** "Nov 7, 2026". `utc` for dates the service fixes at 00:00 UTC (the meter reset). */
  function dayLabel(iso, utc) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return String(iso).slice(0, 10);
    const opts = { month: 'short', day: 'numeric', year: 'numeric', ...(utc ? { timeZone: 'UTC' } : {}) };
    try { return new Date(t).toLocaleDateString([], opts); }
    catch { return String(iso).slice(0, 10); }
  }

  function syncAccountButtons() {
    const locked = claiming || acctBusy;
    $('btn-subscribe').disabled = locked;
    $('btn-manage').disabled = locked;
    $('btn-restore-key').disabled = locked;
    for (const r of document.querySelectorAll('input[name="dash-plan"]')) r.disabled = locked;
    $('btn-license-save').disabled = locked || !$('f-license').value.trim();
    show($('btn-cancel-claim'), claiming);
    $('btn-subscribe').textContent = claiming ? 'Waiting for checkout…' : 'Subscribe';
  }

  function acctMsg(text, cls) { setMsg('account-msg', text, cls); }

  function acctDetail(r) {
    return r && typeof r.message === 'string' ? r.message.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  }

  // Messages for the failures every call on this panel can hit.
  function commonMessage(r) {
    const kind = r && r.kind;
    if (kind === 'network') return 'Could not reach the Grayout service. Check your connection and try again.';
    if (kind === 'not_connected') return 'This build of Grayout is not connected to the Grayout service yet.';
    if (kind === 'device_unverified') return 'Grayout could not register this Mac with the service. Try again later.';
    if (kind === 'secrets_locked') return acctDetail(r) || 'Grayout could not unlock its saved keys in the macOS Keychain. Quit and reopen Grayout, and choose Always Allow.';
    if (kind === 'not_configured' || kind === 'overloaded') return 'The Grayout service is not ready right now. Try again in a few minutes.';
    if (kind === 'rate_limited') return 'Too many tries just now. Wait a minute and try again.';
    // The service's own sentence names the support address to write to.
    if (kind === 'license_revoked') return acctDetail(r) || 'This subscription was refunded or disputed.';
    return '';
  }

  function claimMessage(c) {
    const kind = c && c.kind;
    // Never tell somebody who may have paid to pay again. A checkout page left
    // open in the browser can still be paid after Grayout stops waiting, so a
    // new one is only started after the old tab is closed: two open checkouts
    // could both be paid.
    if (kind === 'timeout') return 'Grayout stopped waiting for the checkout. If you finished paying, your key arrives by itself the next time Grayout opens or you open Settings. If not, close that checkout tab first, then press Subscribe to start again, so you are only charged once.';
    if (kind === 'code_expired') return 'That checkout link has expired. If you finished paying, press Restore my key. If not, press Subscribe to start again.';
    if (kind === 'payment_failed') return 'The payment did not go through, so nothing was charged. Press Subscribe to try again.';
    if (kind === 'checkout_expired') return 'That checkout expired before it was finished. Press Subscribe to start again.';
    if (kind === 'network') return 'Grayout lost its connection while waiting. If you finished paying, press Restore my key once you are back online.';
    return commonMessage(c) || acctDetail(c) || 'Checkout did not finish. Press Subscribe to try again.';
  }

  // "Already subscribed" is good news, not an error: nothing was charged.
  function alreadySubscribedMessage(r) {
    return [
      acctDetail(r) || 'This Mac already has a Grayout subscription, so nothing new was charged.',
      r.restored ? 'Its license key is back on this Mac.' : '',
      r.opened ? 'The billing page is open in your browser if you want to change or cancel it.' : '',
      r.manageNote || MANAGE
    ].filter(Boolean).join(' ');
  }

  /** What to say while the browser checkout is open. */
  function waitingMessage(r) {
    const first = r.reused
      ? 'Your checkout is still open, so Grayout reopened that same page instead of starting a second one.'
      : 'Finish in your browser.';
    // `trial` is the service's answer for this checkout (contract 6.5), so a
    // returning buyer is told before paying that no new trial applies.
    const trial = r.plan === 'monthly'
      ? (r.trial ? ' This checkout starts with a free trial.' : ' This checkout has no free trial, because this Mac or its subscription already had one.')
      : '';
    return `${first}${trial} This panel updates itself the moment the payment goes through.`;
  }

  async function startCheckout(which) {
    if (claiming || acctBusy) return;
    acctBusy = true;
    syncAccountButtons();
    acctMsg('Opening checkout in your browser…');
    let r;
    try { r = await api.startCheckout(which); } catch (e) { r = { ok: false, kind: 'unknown', message: e && e.message }; }
    acctBusy = false;
    if (r && r.kind === 'already_subscribed') {
      syncAccountButtons();
      acctMsg(alreadySubscribedMessage(r), 'ok');
      loadSettings(true);
      scheduleRefresh(300);
      return;
    }
    if (!r || !r.ok) { syncAccountButtons(); acctMsg(commonMessage(r) || acctDetail(r) || 'Checkout did not start. Try again.', 'err'); return; }
    if (r.opened === false) {
      syncAccountButtons();
      acctMsg('Grayout could not open your browser. Subscribe on the Grayout site, then paste the license key here.', 'err');
      return;
    }
    claiming = true;
    syncAccountButtons();
    acctMsg(waitingMessage(r));
    let c;
    try { c = await api.pollClaim(r.deviceCode); } catch (e) { c = { ok: false, kind: 'unknown', message: e && e.message }; }
    claiming = false;
    syncAccountButtons();
    if (c && c.ok) {
      acctMsg(c.status === 'trialing' ? 'Your free trial has started.' : 'Subscribed.', 'ok');
      loadSettings(true);
      scheduleRefresh(300);
      return;
    }
    // Only the waiting stopped. The page in the browser can still be paid, and
    // pressing Subscribe again reopens it rather than starting a second one.
    if (c && c.kind === 'cancelled') { acctMsg('Stopped waiting. The checkout page is still open in your browser: press Subscribe to pick it up again rather than starting a new one.'); return; }
    acctMsg(claimMessage(c), 'err');
  }

  function wireAccount() {
    $('btn-subscribe').addEventListener('click', () => startCheckout(chosenPlan()));
    $('btn-cancel-claim').addEventListener('click', () => { api.cancelClaim().catch(() => {}); });
    $('btn-manage').addEventListener('click', async () => {
      if (acctBusy || claiming) return;
      acctBusy = true;
      syncAccountButtons();
      acctMsg('Opening the billing page…');
      let r;
      try { r = await api.openBillingPortal(); } catch (e) { r = { ok: false, message: e && e.message }; }
      acctBusy = false;
      syncAccountButtons();
      const note = (r && r.manageNote) || MANAGE;
      if (r && r.ok && r.opened !== false) {
        acctMsg(`The billing page is open in your browser. There you can update your card, see receipts or cancel. ${note}`, 'ok');
        return;
      }
      acctMsg(`${commonMessage(r) || acctDetail(r) || 'Could not open the billing page. Try again in a moment.'} ${note}`, 'err');
    });
    // "Restore my key" (contract 16.1). Its own id: #btn-restore is the
    // header's "Restore color", which must only ever restore the color.
    $('btn-restore-key').addEventListener('click', async () => {
      if (acctBusy || claiming) return;
      acctBusy = true;
      syncAccountButtons();
      acctMsg('Asking the service for this Mac’s key…');
      let r;
      try { r = await api.restoreLicense(); } catch (e) { r = { ok: false, kind: 'unknown', message: e && e.message }; }
      acctBusy = false;
      syncAccountButtons();
      if (r && r.ok && r.restored) {
        acctMsg('Your license key is back on this Mac.', 'ok');
        loadSettings(true);
        scheduleRefresh(300);
        return;
      }
      if (r && r.ok) {
        acctMsg('The service has no subscription on file for this Mac. If you bought Grayout on the website, paste the key from the purchase page below.', 'err');
        return;
      }
      acctMsg(commonMessage(r) || acctDetail(r) || 'Could not ask the service. Try again in a moment.', 'err');
    });
    $('f-license').addEventListener('input', syncAccountButtons);
    $('btn-license-save').addEventListener('click', async () => {
      const key = $('f-license').value.trim();
      if (!key || acctBusy || claiming) return;
      acctBusy = true;
      syncAccountButtons();
      acctMsg('Checking that key…');
      let r;
      try { r = await api.activateLicense(key); } catch (e) { r = { ok: false, kind: 'unknown', message: e && e.message }; }
      acctBusy = false;
      if (r && r.ok) {
        $('f-license').value = '';
        syncAccountButtons();
        // A canceled or lapsed key still activates; the service then says
        // service: false. Say so rather than pretending all is well.
        acctMsg(r.service === false
          ? 'That key is saved on this Mac, but its subscription is not active right now. Update the payment with Manage subscription or at link.com.'
          : 'That license is active on this Mac.', r.service === false ? 'err' : 'ok');
        loadSettings(true);
        scheduleRefresh(300);
        return;
      }
      syncAccountButtons();
      const kind = r && r.kind;
      acctMsg(kind === 'license_invalid'
        ? 'That license key is not one Grayout issued. Check it for missing characters.'
        : (commonMessage(r) || acctDetail(r) || 'That key could not be activated.'), 'err');
    });
    $('btn-link').addEventListener('click', () => api.openExternal('https://link.com'));
    $('btn-plans').addEventListener('click', () => api.openExternal('https://aarushkandukoori.github.io/grayout/pricing.html'));
  }

  function wireKey() {
    const field = $('f-key');
    const test = $('btn-key-test');
    const save = $('btn-key-save');
    field.addEventListener('input', () => {
      const has = field.value.trim().length > 0;
      save.disabled = !has || (settings && settings.secureStorage === false);
      if (!has) setMsg('key-msg', '');
    });
    test.addEventListener('click', async () => {
      const k = field.value.trim();
      if (!k) { setMsg('key-msg', 'Paste a key first.', 'err'); return; }
      test.disabled = true;
      setMsg('key-msg', 'Testing with a synthetic screenshot. This costs a fraction of a cent.');
      try {
        const r = await api.testApiKey(k, syntheticFrameB64());
        const [text, cls] = keyTestMessage(r);
        setMsg('key-msg', text, cls);
      } catch (e) {
        setMsg('key-msg', 'The test failed. Try again.', 'err');
      } finally { test.disabled = false; }
    });
    save.addEventListener('click', async () => {
      const k = field.value.trim();
      if (!k) return;
      save.disabled = true;
      try {
        const r = await api.setApiKey(k);
        if (r && r.ok) {
          field.value = '';
          setMsg('key-msg', 'Saved. macOS may ask once whether Grayout can use its Keychain item; click Always Allow.', 'ok');
          if (settings) { settings.hasKey = true; settings.keyMasked = r.keyMasked || ''; }
          renderKeyCurrent(true, r.keyMasked, null);
          // The provider changes with the key, so reload the estimates and the
          // interval prices from the main process.
          loadSettings(false);
          scheduleRefresh(300);
        } else {
          setMsg('key-msg', (r && r.message) || 'Could not save the key.', 'err');
          save.disabled = false;
        }
      } catch (e) {
        setMsg('key-msg', 'Could not save the key.', 'err');
        save.disabled = false;
      }
    });
    const remove = $('btn-key-remove');
    let armed = false;
    remove.addEventListener('click', async () => {
      if (!armed) { armed = true; remove.textContent = 'Really remove the key?'; setTimeout(() => { armed = false; remove.textContent = 'Remove key'; }, 4000); return; }
      armed = false; remove.textContent = 'Remove key';
      try { await api.clearApiKey(); } catch {}
      if (settings) { settings.hasKey = false; settings.keyMasked = ''; }
      renderKeyCurrent(false, '');
      setMsg('key-msg', 'Key removed. Checks are paused until you add one.', '');
      scheduleRefresh(300);
    });
    $('btn-key-get').addEventListener('click', () => api.openExternal('https://github.com/aarushkandukoori/grayout#self-hosting'));
  }

  /* ---------------- permissions + advanced ---------------- */

  function wireSettings() {
    $('settings-form').addEventListener('submit', saveSettings);
    $('btn-revert').addEventListener('click', () => { if (settings) fillForm(settings); flash($('save-status-2'), 'Reverted'); });
    $('f-work').addEventListener('input', updateCounter);
    $('f-camera').addEventListener('change', onCameraToggle);
    for (const k of ['grayscale', 'redFlash']) {
      $('f-' + k).addEventListener('change', () => {
        $('consequence-note').textContent = (!$('f-grayscale').checked && !$('f-redFlash').checked)
          ? 'Both off: Grayout will only log what it sees.' : '';
      });
    }
    $('btn-add-allowed').addEventListener('click', () => addChip('alwaysAllowedApps', 'add-allowed'));
    $('btn-add-never').addEventListener('click', () => addChip('neverCaptureApps', 'add-never'));
    $('add-allowed').addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); addChip('alwaysAllowedApps', 'add-allowed'); } });
    $('add-never').addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); addChip('neverCaptureApps', 'add-never'); } });

    $('btn-perm-screen').addEventListener('click', () => api.openScreenSettings());
    $('btn-perm-camera').addEventListener('click', () => api.openCameraSettings());
    $('btn-perm-login').addEventListener('click', () => api.openLoginItems());
    $('btn-perm-recheck').addEventListener('click', async () => {
      const b = $('btn-perm-recheck');
      b.disabled = true;
      try {
        const p = await api.getPermissions();
        renderPermissions({ screen: p.screen, camera: p.camera }, p.loginItem, p.tccResetCmd);
        if (settings) { settings.permissions = { screen: p.screen, camera: p.camera }; settings.loginItem = p.loginItem || settings.loginItem; renderLogin(settings.loginItem); }
        if (lastLive && lastLive.needsScreenPermission) { try { await api.recheck(); } catch {} }
        scheduleRefresh(500);
      } catch (e) { console.error(e); }
      finally { b.disabled = false; }
    });
    $('btn-tcc-copy').addEventListener('click', async () => {
      const cmd = $('tcc-cmd').textContent;
      if (!cmd) return;
      try { await api.copyText(cmd); } catch {}
      const b = $('btn-tcc-copy');
      b.textContent = 'Copied';
      setTimeout(() => { b.textContent = 'Copy'; }, 1500);
    });

    $('btn-open-config').addEventListener('click', () => api.openConfigFile());
    $('btn-reveal').addEventListener('click', () => api.revealData());
    $('btn-clear').addEventListener('click', async () => {
      const b = $('btn-clear');
      b.disabled = true;
      try {
        const r = await api.clearHistory();
        if (r && r.ok) { flash($('adv-status'), 'History deleted'); day = null; scheduleRefresh(100); }
      } catch {}
      finally { b.disabled = false; }
    });
  }

  /* ---------------- navigation ---------------- */

  function goToSettings(focusKey) {
    const target = focusKey ? $('key-panel') : $('settings');
    loadSettings(false).then(() => {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (focusKey) setTimeout(() => $('f-key').focus(), 400);
    });
  }

  function goToAccount() {
    loadSettings(false).then(() => {
      $('account-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  function onNavigate(section) {
    if (section === 'settings') goToSettings(false);
    else if (section === 'key') goToSettings(true);
    else if (section === 'account') goToAccount();
    else window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ---------------- boot ---------------- */

  function boot() {
    if (!api) {
      $('headline').textContent = 'Open this page from Grayout.';
      $('pill-text').textContent = 'not connected';
      return;
    }
    wireHeader();
    wireSettings();
    wireAccount();
    wireKey();
    refresh();
    loadSettings(true);
    setInterval(refresh, 5000);

    let liveTimer = null;
    api.onLive(live => {
      renderHeader(live);
      if (lastData) renderBanners({ ...lastData, live });
      clearTimeout(liveTimer);
      liveTimer = setTimeout(refresh, 250);
    });
    api.onNavigate(onNavigate);

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (lastData && lastData.stats && lastData.stats.cells) renderStrip(lastData.stats.cells); }, 120);
    });

    if (location.hash === '#settings') onNavigate('settings');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
