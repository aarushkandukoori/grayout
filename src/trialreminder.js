'use strict';
// One reminder before a free trial turns into a charge.
//
// Why the app does this itself: under Stripe Managed Payments, Link sends the
// buyer a trial-start email, but a trial-ending reminder only "for all trials
// longer than 7 days", and the Dashboard's trial-email setting does not apply
// to those emails (Stripe docs, "How Managed Payments works"). Grayout's trial
// is exactly 7 days, so without this nobody would warn the buyer before the
// first $9.99 charge. A surprise charge turns into refund requests and
// disputes, and a dispute revokes the license (contract 7.4).
//
// The rules, all in reminderDue():
//   - only while the service says the plan is `trialing` and not set to cancel
//     (a trial set to cancel ends without a charge, so there is nothing to warn about);
//   - once the trial has 48 hours or less left;
//   - once per trial: the trial end it was shown for is saved in state.json.
// While trialing, the plan is read again from the service about once a day,
// so a trial that was canceled (or already converted) elsewhere is noticed.

const pricing = require('./pricing');

const REMIND_BEFORE_MS = 48 * 3600 * 1000;
const REFRESH_EVERY_MS = 24 * 3600 * 1000;
const CHECK_EVERY_MS = 60 * 60 * 1000;
// The first look waits a little, so the launch refresh in main.js has read the
// plan from the service first. A trial canceled since the last launch must
// not get a "you will be charged" reminder from a stale state.json.
const FIRST_CHECK_DELAY_MS = 2 * 60 * 1000;

/** "Nov 7" style date for the notification text. */
function shortDate(iso) {
  try { return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }); }
  catch { return String(iso).slice(0, 10); }
}

/** "$9.99 a month", from src/pricing.js, so the price lives in one place. */
function priceText(interval) {
  const plan = pricing.PLANS[interval === 'yearly' ? 'yearly' : 'monthly'];
  return plan ? `${plan.priceLabel} ${plan.periodLabel}` : 'the plan price';
}

/**
 * The notification to show now, or null.
 * snap: the account snapshot. shownFor: the trialEnd a reminder was last shown for.
 */
function reminderDue(snap, now, shownFor) {
  if (!snap || !snap.hasLicense || snap.status !== 'trialing' || snap.cancelAtPeriodEnd) return null;
  const end = Date.parse(snap.trialEnd || '');
  if (!Number.isFinite(end)) return null;
  const left = end - now;
  if (left <= 0 || left > REMIND_BEFORE_MS) return null;
  if (shownFor === snap.trialEnd) return null;
  return {
    title: 'Your Grayout trial ends soon',
    body: `Your free trial ends on ${shortDate(snap.trialEnd)}. After that you will be charged ${priceText(snap.interval)}, plus tax where it applies. To cancel, open Settings > Your plan, or go to link.com.`
  };
}

/**
 * deps: { account, state, notify(title, body), now, onRefreshed(result) }
 * Returns { tick, start, stop }. tick() is what the timer runs; tests call it.
 */
function createTrialReminder(deps) {
  const d = { now: () => Date.now(), onRefreshed: () => {}, ...deps };
  let timer = null;
  // The launch refresh in main.js has just read the plan, so the first daily
  // re-read is a day from now.
  let lastRefreshAt = d.now();

  function snapshot() {
    try { return d.account.snapshot(); } catch { return null; }
  }

  async function tick() {
    let snap = snapshot();
    if (!snap || snap.status !== 'trialing') return null;

    // Once a day while trialing, ask the service again: the trial may have
    // been canceled at link.com, or the trial end may have moved.
    if (d.now() - lastRefreshAt >= REFRESH_EVERY_MS) {
      lastRefreshAt = d.now();
      try {
        const r = await d.account.status({ force: true });
        try { d.onRefreshed(r); } catch {}
      } catch {}
      snap = snapshot();
    }

    let shownFor = null;
    try { shownFor = d.state.get().trialReminderFor || null; } catch {}
    const due = reminderDue(snap, d.now(), shownFor);
    if (!due) return null;
    // Saved before showing: a crash right after must not show it twice.
    try { d.state.update(s => { s.trialReminderFor = snap.trialEnd; }); } catch {}
    try { d.notify(due.title, due.body); } catch {}
    return due;
  }

  function start() {
    stop();
    timer = setTimeout(() => {
      tick().catch(() => {});
      timer = setInterval(() => { tick().catch(() => {}); }, CHECK_EVERY_MS);
      if (timer.unref) timer.unref();
    }, FIRST_CHECK_DELAY_MS);
    if (timer.unref) timer.unref();
  }

  function stop() { if (timer) { clearTimeout(timer); clearInterval(timer); timer = null; } }

  return { tick, start, stop };
}

module.exports = { createTrialReminder, reminderDue, REMIND_BEFORE_MS, REFRESH_EVERY_MS, CHECK_EVERY_MS, FIRST_CHECK_DELAY_MS };
