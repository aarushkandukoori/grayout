'use strict';
const fs = require('fs');
const paths = require('./paths');

const GAP_MIN = 5; // a break longer than this means "away", not "off task"
const ACTIVE_HOURS_PER_DAY = 4.2;
const WORKING_DAYS_PER_MONTH = 22;

function readAll(file = paths.VERDICT_LOG) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (typeof r.ts === 'number') rows.push(r);
    } catch { /* skip a partially-written line */ }
  }
  return rows;
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Summarize one day. Defaults to today, but falls back to the most recent day
 * that actually has data — an empty panel at 9am tells you nothing useful.
 */
function summarize(requestedDay, opts = {}) {
  const rows = readAll(opts.file);
  const intervalSec = opts.intervalSec || 45;
  const nowTs = opts.now || Date.now();
  const verdicts = rows.filter(r => r.type !== 'dispute');
  const disputes = rows.filter(r => r.type === 'dispute');
  const disputedRefs = new Set(disputes.map(x => x.ref).filter(Boolean));

  if (!verdicts.length) {
    return { empty: true, day: dayKey(nowTs), days: [], costToday: 0, checksToday: 0 };
  }

  const days = [...new Set(verdicts.map(r => dayKey(r.ts)))].sort();
  const today = dayKey(nowTs);
  let day = requestedDay || today;
  if (!days.includes(day)) day = days[days.length - 1];

  const list = verdicts.filter(r => dayKey(r.ts) === day).sort((a, b) => a.ts - b.ts);
  const on = list.filter(r => !r.off).length;
  const off = list.length - on;

  // Longest run of consecutive on-task checks.
  let best = 0, cur = 0, bestEnd = null;
  for (const r of list) {
    if (r.off) { cur = 0; continue; }
    cur++;
    if (cur > best) { best = cur; bestEnd = r.ts; }
  }

  // Current run, counting back from the most recent check.
  let streak = 0;
  for (let i = list.length - 1; i >= 0 && !list[i].off; i--) streak++;

  // Checks where the screen was actually red + grayscale (strikes reached = it fired).
  // The consequence is continuous between checks, not sampled, so measure the
  // elapsed span of each contiguous run and add one interval for the final
  // check — counting samples would under-report whenever checks run slow, and
  // summing only the gaps between them would report zero for a single check.
  const strikesNeeded = opts.strikes || 2;
  const TAIL_MS = intervalSec * 1000;
  const punished = list.filter(r => (r.strikes || 0) >= strikesNeeded);
  let punishedMs = 0;
  for (let i = 0; i < punished.length; i++) {
    const start = punished[i];
    while (i + 1 < punished.length &&
           punished[i + 1].ts - punished[i].ts < GAP_MIN * 60000) i++;
    punishedMs += (punished[i].ts - start.ts) + TAIL_MS;
  }
  const punishedMin = punished.length ? Math.max(1, Math.round(punishedMs / 60000)) : 0;

  // Cells for the strip, with explicit gaps where we weren't watching.
  const cells = [];
  let prev = null;
  for (const r of list) {
    if (prev) {
      const gapMs = r.ts - prev.ts;
      if (gapMs > GAP_MIN * 60000) cells.push({ gap: Math.round(gapMs / 60000) });
    }
    cells.push({
      ts: r.ts, off: !!r.off, fired: (r.strikes || 0) >= strikesNeeded,
      activity: r.activity || '', conf: r.conf || '', disputed: disputedRefs.has(r.ts)
    });
    prev = r;
  }

  const cost = list.reduce((a, r) => a + (typeof r.cost === 'number' ? r.cost : 0), 0);
  const priced = list.filter(r => typeof r.cost === 'number').length;
  const spanHours = list.length > 1 ? (list[list.length - 1].ts - list[0].ts) / 3600000 : 0;
  // Month projection: today's spend rate over the hours observed, scaled to a
  // typical active day and a working month. Null until there's an hour of data.
  const spentMonthProjection = (spanHours >= 1 && cost > 0)
    ? (cost / spanHours) * ACTIVE_HOURS_PER_DAY * WORKING_DAYS_PER_MONTH
    : null;
  const maxDisplays = list.reduce((m, r) => Math.max(m, r.displays || 1), 1);

  return {
    empty: list.length === 0,
    day, days,
    isToday: day === today,
    checks: list.length,
    on, off,
    focusPct: list.length ? Math.round((on / list.length) * 100) : null,
    longestStreak: best,
    longestStreakEnd: bestEnd,
    currentStreak: streak,
    firedChecks: punished.length,
    punishedMin,
    observedMin: Math.round(list.length * intervalSec / 60),
    firstTs: list.length ? list[0].ts : null,
    lastTs: list.length ? list[list.length - 1].ts : null,
    cells,
    flags: list.filter(r => r.off).map(r => ({
      ts: r.ts, activity: r.activity || '', conf: r.conf || '',
      fired: (r.strikes || 0) >= strikesNeeded, disputed: disputedRefs.has(r.ts), app: r.app || null
    })),
    costToday: Number(cost.toFixed(4)),
    checksToday: list.length,
    pricedChecks: priced,
    spentMonthProjection: spentMonthProjection === null ? null : Number(spentMonthProjection.toFixed(2)),
    maxDisplays,
    disputes: disputes.filter(x => dayKey(x.ts) === day).length
  };
}

/** Drop lines older than `days`. Returns the number of lines removed. */
function prune(days, file = paths.VERDICT_LOG, nowTs = Date.now()) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return 0; }
  const cutoff = nowTs - days * 86400000;
  const lines = text.split('\n').filter(l => l.trim());
  const keep = lines.filter(l => {
    try { const r = JSON.parse(l); return typeof r.ts !== 'number' || r.ts >= cutoff; } catch { return false; }
  });
  if (keep.length === lines.length) return 0;
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, keep.length ? keep.join('\n') + '\n' : '', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return lines.length - keep.length;
}

function clearHistory(file = paths.VERDICT_LOG) {
  try { fs.writeFileSync(file, '', { mode: 0o600 }); } catch {}
}

module.exports = { summarize, readAll, prune, clearHistory, dayKey, GAP_MIN };
