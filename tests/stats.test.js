'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const helpers = require('./helpers');

const dir = helpers.freshUserData('stats');
const paths = require('../src/paths');
const stats = require('../src/stats');
const { summarize, readAll, prune, clearHistory, dayKey, GAP_MIN } = stats;

after(() => helpers.cleanup(dir));

const FIXTURE = path.join(helpers.FIXTURES, 'verdicts.sample.jsonl');
const T0 = 1789905600000;                 // first row of the main day (12:00 UTC)
const OLD = T0 - 3 * 86400000;            // the older day's first row
const NOW = T0 + 4000 * 1000;             // "now" for the tests: still the same local day
const DAY = dayKey(T0);
const sec = n => T0 + n * 1000;

// Independent view of the fixture: everything below is recomputed from the raw
// rows with plain formulas, so a fixture edit and an implementation change are
// both caught.
const raw = fs.readFileSync(FIXTURE, 'utf8').split('\n').filter(l => l.trim());
const parsed = raw.flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
const mainVerdicts = parsed.filter(r => r.type !== 'dispute' && typeof r.ts === 'number' && dayKey(r.ts) === DAY).sort((a, b) => a.ts - b.ts);

describe('fixture sanity', () => {
  test('fixture has the expected shape', () => {
    assert.equal(raw.length, 23);
    assert.equal(parsed.length, 22, 'one partially-written line must fail to parse');
    assert.equal(mainVerdicts.length, 19);
    assert.equal(parsed.filter(r => r.type === 'dispute').length, 1);
    assert.equal(parsed.filter(r => r.type !== 'dispute' && dayKey(r.ts) === dayKey(OLD)).length, 2);
    // All main-day rows fall in the same local day in every timezone (12:00 UTC + < 1h05m).
    assert.ok(mainVerdicts.every(r => r.ts >= T0 && r.ts < T0 + 3900 * 1000));
    assert.equal(dayKey(NOW), DAY);
  });
});

describe('readAll', () => {
  test('parses every row with a numeric ts and skips the torn line', () => {
    const rows = readAll(FIXTURE);
    assert.equal(rows.length, 22);
    assert.ok(rows.some(r => r.type === 'dispute'));
    assert.equal(readAll(path.join(dir, 'missing.jsonl')).length, 0);
  });

  test('defaults to paths.VERDICT_LOG', () => {
    assert.equal(readAll().length, 0);
    fs.copyFileSync(FIXTURE, paths.VERDICT_LOG);
    assert.equal(readAll().length, 22);
    fs.unlinkSync(paths.VERDICT_LOG);
  });
});

describe('summarize on the fixture', () => {
  const opts = { file: FIXTURE, intervalSec: 45, strikes: 2, now: NOW };
  let s;
  before(() => { s = summarize(undefined, opts); });

  test('picks today when it has data', () => {
    assert.equal(s.empty, false);
    assert.equal(s.day, DAY);
    assert.equal(s.isToday, true);
    assert.deepEqual(s.days, [dayKey(OLD), DAY]);
    assert.equal(s.checks, 19);
    assert.equal(s.checksToday, 19);
  });

  test('focusPct = on / checks', () => {
    const on = mainVerdicts.filter(r => !r.off).length;
    assert.equal(on, 13);
    assert.equal(s.on, 13);
    assert.equal(s.off, 6);
    assert.equal(s.focusPct, Math.round(13 / 19 * 100));
    assert.equal(s.focusPct, 68);
  });

  test('longestStreak is the longest run of on-task checks; currentStreak counts back from the end', () => {
    assert.equal(s.longestStreak, 5);
    assert.equal(s.longestStreakEnd, sec(1140));
    assert.equal(s.currentStreak, 4);
  });

  test('gaps longer than GAP_MIN produce gap cells', () => {
    assert.equal(GAP_MIN, 5);
    const gaps = s.cells.filter(c => c.gap !== undefined);
    assert.deepEqual(gaps, [{ gap: 11 }, { gap: 40 }]);
    assert.equal(s.cells.length, 19 + 2);
    // gap cells sit between the rows they separate
    const i1 = s.cells.findIndex(c => c.gap === 11);
    assert.equal(s.cells[i1 - 1].ts, sec(360));
    assert.equal(s.cells[i1 + 1].ts, sec(1005));
    const i2 = s.cells.findIndex(c => c.gap === 40);
    assert.equal(s.cells[i2 - 1].ts, sec(1275));
    assert.equal(s.cells[i2 + 1].ts, sec(3675));
    // a 45 s cadence never yields a gap cell
    const consecutive = s.cells.filter(c => c.ts).map(c => c.ts);
    for (let i = 1; i < consecutive.length; i++) {
      if (consecutive[i] - consecutive[i - 1] <= GAP_MIN * 60000) assert.notEqual(s.cells[s.cells.indexOf(s.cells.find(c => c.ts === consecutive[i])) - 1].gap !== undefined, true);
    }
  });

  test('punishedMin = span of each contiguous fired run + one interval tail', () => {
    // fired rows: 270 s, 315 s (one run: 45 s span + 45 s tail) and 1230 s (0 span + 45 s tail)
    assert.equal(s.firedChecks, 3);
    assert.equal(s.punishedMin, Math.round((45 + 45 + 0 + 45) / 60));
    assert.equal(s.punishedMin, 2);
    // A single fired check still counts as at least one minute.
    const one = path.join(dir, 'one.jsonl');
    fs.writeFileSync(one, JSON.stringify({ ts: T0, off: true, conf: 'high', strikes: 2, cost: 0.002468 }) + '\n');
    assert.equal(summarize(undefined, { file: one, now: NOW, intervalSec: 45 }).punishedMin, 1);
    // No fired checks → 0.
    fs.writeFileSync(one, JSON.stringify({ ts: T0, off: true, conf: 'high', strikes: 1 }) + '\n');
    assert.equal(summarize(undefined, { file: one, now: NOW }).punishedMin, 0);
  });

  test('strikes option controls what counts as fired', () => {
    const s3 = summarize(undefined, { ...opts, strikes: 3 });
    assert.equal(s3.firedChecks, 1);
    assert.equal(s3.flags.filter(f => f.fired).length, 1);
  });

  test('flags list every off-task check with fired/disputed from the dispute line', () => {
    assert.equal(s.flags.length, 6);
    assert.deepEqual(s.flags.map(f => f.ts), [135, 225, 270, 315, 1185, 1230].map(sec));
    const byTs = Object.fromEntries(s.flags.map(f => [f.ts, f]));
    assert.deepEqual(byTs[sec(315)], { ts: sec(315), activity: 'short video feed', conf: 'high', fired: true, disputed: true, app: 'Safari' });
    assert.equal(byTs[sec(270)].disputed, false);
    assert.equal(byTs[sec(270)].fired, true);
    assert.equal(byTs[sec(135)].fired, false);
    assert.equal(byTs[sec(135)].conf, 'medium');
    assert.equal(byTs[sec(1185)].fired, false);
    assert.equal(byTs[sec(1230)].fired, true);
    assert.equal(s.disputes, 1);
    const cell = s.cells.find(c => c.ts === sec(315));
    assert.equal(cell.disputed, true);
    assert.equal(cell.fired, true);
    assert.equal(cell.off, true);
    assert.equal(s.cells.find(c => c.ts === sec(0)).disputed, false);
  });

  test('costToday sums cost; pricedChecks ignores unpriced rows', () => {
    const cost = mainVerdicts.reduce((a, r) => a + (typeof r.cost === 'number' ? r.cost : 0), 0);
    assert.equal(mainVerdicts.filter(r => typeof r.cost === 'number').length, 18);
    assert.equal(s.pricedChecks, 18);
    assert.equal(s.costToday, Number(cost.toFixed(4)));
    assert.equal(s.costToday, 0.046);
  });

  test('month projection = (cost / observed hours) × 4.2 h × 22 days', () => {
    const cost = mainVerdicts.reduce((a, r) => a + (typeof r.cost === 'number' ? r.cost : 0), 0);
    const spanHours = (sec(3765) - sec(0)) / 3600000;
    assert.ok(spanHours >= 1);
    assert.equal(s.spentMonthProjection, Number(((cost / spanHours) * 4.2 * 22).toFixed(2)));
    assert.equal(s.spentMonthProjection, 4.06);
  });

  test('projection is null with under an hour of data', () => {
    const short = path.join(dir, 'short.jsonl');
    const rows = [0, 45, 90].map(n => JSON.stringify({ ts: sec(n), off: false, conf: 'high', strikes: 0, cost: 0.002468 }));
    fs.writeFileSync(short, rows.join('\n') + '\n');
    const r = summarize(undefined, { file: short, now: NOW });
    assert.equal(r.spentMonthProjection, null);
    assert.equal(r.costToday, Number((3 * 0.002468).toFixed(4)));
  });

  test('other fields', () => {
    assert.equal(s.observedMin, Math.round(19 * 45 / 60));
    assert.equal(s.firstTs, sec(0));
    assert.equal(s.lastTs, sec(3765));
    assert.equal(s.maxDisplays, 2);
  });

  test('day selection: a requested day without data falls back to the newest day', () => {
    const r = summarize('1999-01-01', opts);
    assert.equal(r.day, DAY);
    const old = summarize(dayKey(OLD), opts);
    assert.equal(old.day, dayKey(OLD));
    assert.equal(old.checks, 2);
    assert.equal(old.isToday, false);
    assert.equal(old.disputes, 0);
    assert.equal(old.focusPct, 50);
  });

  test('an empty today falls back to the most recent day with data', () => {
    const r = summarize(undefined, { ...opts, now: NOW + 10 * 86400000 });
    assert.equal(r.day, DAY);
    assert.equal(r.isToday, false);
    assert.equal(r.checks, 19);
  });

  test('no data at all → empty summary', () => {
    const r = summarize(undefined, { file: path.join(dir, 'nope.jsonl'), now: NOW });
    assert.deepEqual(r, { empty: true, day: DAY, days: [], costToday: 0, checksToday: 0 });
  });
});

describe('prune', () => {
  const file = path.join(dir, 'prune.jsonl');
  before(() => fs.copyFileSync(FIXTURE, file));

  test('drops rows older than historyDays and any unparseable line', () => {
    assert.equal(readAll(file).length, 22);
    const removed = prune(1, file, NOW);
    assert.equal(removed, 3, 'two older-day rows + the torn line');
    const rows = readAll(file);
    assert.equal(rows.length, 20);
    assert.ok(rows.every(r => r.ts >= NOW - 86400000));
    assert.ok(fs.readFileSync(file, 'utf8').endsWith('\n'));
    assert.equal(fs.existsSync(file + '.tmp'), false);
    assert.equal(helpers.fileMode(file), 0o600);
  });

  test('a second prune with nothing to drop is a no-op and does not rewrite', () => {
    const before = fs.statSync(file).mtimeMs;
    assert.equal(prune(1, file, NOW), 0);
    assert.equal(fs.statSync(file).mtimeMs, before);
  });

  test('pruning everything leaves an empty file; a missing file returns 0', () => {
    assert.equal(prune(1, file, NOW + 30 * 86400000), 20);
    assert.equal(fs.readFileSync(file, 'utf8'), '');
    assert.equal(prune(30, path.join(dir, 'absent.jsonl')), 0);
  });

  test('clearHistory empties the log', () => {
    fs.copyFileSync(FIXTURE, paths.VERDICT_LOG);
    clearHistory();
    assert.equal(fs.readFileSync(paths.VERDICT_LOG, 'utf8'), '');
    assert.equal(summarize(undefined, { now: NOW }).empty, true);
  });
});
