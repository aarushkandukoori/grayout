// Fakes for everything outside the Worker: the rate-limit bindings and Stripe.
// Nothing here touches the network.

/**
 * A Workers Rate Limiting binding: `limit({ key })` → `{ success }`. Counts
 * per key until `reset()`, which a test calls to stand for "a minute passed".
 */
export function fakeLimiter(max) {
  const counts = new Map();
  return {
    max,
    keys: [],
    async limit({ key }) {
      this.keys.push(key);
      const n = (counts.get(key) || 0) + 1;
      counts.set(key, n);
      return { success: n <= this.max };
    },
    reset() { counts.clear(); }
  };
}

/** The limiters of contract section 11, with their real limits. */
export function fakeLimiters() {
  return {
    RL_MINT: fakeLimiter(3),
    RL_IP: fakeLimiter(120),
    RL_STRIPE_IP: fakeLimiter(10),
    RL_FREE_IP: fakeLimiter(4),
    RL_DEVICE: fakeLimiter(40),
    RL_LICENSE: fakeLimiter(20),
    RL_CHECK_IP: fakeLimiter(60)
  };
}

function stripeError(message, code = 'resource_missing') {
  return Object.assign(new Error(message), { type: 'StripeInvalidRequestError', code, statusCode: 404 });
}

const clone = value => (value === undefined ? undefined : structuredClone(value));

/**
 * A small in-memory Stripe with only the methods the service calls. A test
 * changes "what Stripe says" with the helpers at the bottom, then delivers
 * events in whatever order it likes.
 */
export class FakeStripe {
  constructor({ now, prices, product, livemode = false }) {
    this.now = now;
    // Sessions say livemode: true when the harness runs as the live Worker.
    this.livemode = livemode;
    this.prices = prices; // { monthly: 'price_…', yearly: 'price_…' }
    this.product = product; // 'prod_…'
    this.paymentMethodMap = new Map();
    this.calls = [];
    this.failures = new Map();
    this.counter = 0;
    this.sessions = new Map();
    this.subs = new Map();
    this.invoiceMap = new Map();
    this.invoicePaymentsByIntent = new Map();
    this.chargeMap = new Map();
    this.refundList = [];

    const call = (name, fn) => async (...args) => this.record(name, args, fn);
    this.checkout = {
      sessions: {
        create: call('checkout.sessions.create', params => this.createSession(params)),
        retrieve: call('checkout.sessions.retrieve', id => this.getOr404(this.sessions, id)),
        expire: call('checkout.sessions.expire', id => this.expireOpenSession(id))
      }
    };
    this.subscriptions = {
      list: call('subscriptions.list', params => this.listSubscriptions(params)),
      retrieve: call('subscriptions.retrieve', id => this.getOr404(this.subs, id)),
      update: call('subscriptions.update', (id, params) => this.updateFromApi(id, params)),
      cancel: call('subscriptions.cancel', id => this.cancelSubscription(id))
    };
    this.paymentMethods = {
      retrieve: call('paymentMethods.retrieve', id => this.getOr404(this.paymentMethodMap, id))
    };
    this.invoicePayments = {
      list: call('invoicePayments.list', params => this.listInvoicePayments(params))
    };
    this.invoices = { retrieve: call('invoices.retrieve', id => this.getOr404(this.invoiceMap, id)) };
    this.charges = { retrieve: call('charges.retrieve', id => this.getOr404(this.chargeMap, id)) };
    this.refunds = { create: call('refunds.create', (params, options) => this.createRefund(params, options)) };
    this.billingPortal = {
      sessions: {
        create: call('billingPortal.sessions.create', params => ({
          id: `bps_${this.nextId()}`, url: `https://billing.stripe.com/p/session/test_${params.customer}`
        }))
      }
    };
  }

  async record(name, args, fn) {
    this.calls.push({ name, args: clone(args) });
    // Yield like a network call, so concurrent requests interleave.
    await new Promise(resolve => setImmediate(resolve));
    const failure = this.failures.get(name);
    if (failure) {
      if (failure.once) this.failures.delete(name);
      throw failure.error;
    }
    return clone(fn(...args));
  }

  nextId() {
    this.counter += 1;
    return `${this.counter}`.padStart(6, '0') + 'AbCdEfGh';
  }

  getOr404(map, id) {
    if (!map.has(id)) throw stripeError(`No such object: '${id}'`);
    return map.get(id);
  }

  callsTo(name) { return this.calls.filter(c => c.name === name); }

  /** Make the next call to `name` (or every call, with once: false) throw. */
  failOn(name, { once = true, error = Object.assign(new Error('Stripe is down'), { type: 'StripeAPIError' }) } = {}) {
    this.failures.set(name, { once, error });
  }

  // ------------------------------------------------------------ resources

  createSession(params) {
    const id = `cs_test_${this.nextId()}`;
    const session = {
      id,
      object: 'checkout.session',
      url: `https://checkout.stripe.com/c/pay/${id}`,
      livemode: this.livemode,
      mode: params.mode,
      status: 'open',
      payment_status: 'unpaid',
      customer: params.customer || null,
      customer_details: null,
      subscription: null,
      invoice: null,
      expires_at: params.expires_at,
      client_reference_id: params.client_reference_id || null,
      params
    };
    this.sessions.set(id, session);
    return session;
  }

  listSubscriptions({ customer, limit = 10 }) {
    const data = [...this.subs.values()]
      .filter(s => s.customer === customer)
      .sort((a, b) => b.created - a.created)
      .slice(0, limit);
    return { object: 'list', data, has_more: false };
  }

  /** Stripe's expire: only an open session can be expired. */
  expireOpenSession(id) {
    const session = this.getOr404(this.sessions, id);
    if (session.status !== 'open') {
      throw Object.assign(new Error('Only open sessions can be expired.'), { type: 'StripeInvalidRequestError', statusCode: 400 });
    }
    session.status = 'expired';
    return session;
  }

  /** subscriptions.update. Only trial_end: 'now' is used: the trial ends and the first period is paid. */
  updateFromApi(id, params) {
    const sub = this.getOr404(this.subs, id);
    if (params.trial_end === 'now') {
      if (sub.status !== 'trialing') throw Object.assign(new Error('Not in a trial.'), { type: 'StripeInvalidRequestError' });
      const now = this.now();
      sub.status = 'active';
      sub.trial_end = now;
      sub.items.data[0].current_period_start = now;
      sub.items.data[0].current_period_end = now + 30 * 86400;
    }
    return sub;
  }

  cancelSubscription(id) {
    const sub = this.getOr404(this.subs, id);
    sub.status = 'canceled';
    sub.canceled_at = this.now();
    return sub;
  }

  listInvoicePayments({ payment, invoice, status, starting_after: after }) {
    const source = invoice
      ? [...this.invoicePaymentsByIntent.values()].flat().filter(p => p.invoice === invoice)
      : (this.invoicePaymentsByIntent.get(payment.payment_intent) || []);
    let all = source.filter(p => !status || p.status === status);
    if (after) all = all.slice(all.findIndex(p => p.id === after) + 1);
    // Two per page, so the pagination path is exercised.
    return { object: 'list', data: all.slice(0, 2), has_more: all.length > 2 };
  }

  /**
   * refunds.create for a PaymentIntent. Like Stripe: the same idempotency key
   * returns the same refund, and a charge that is already fully refunded
   * cannot be refunded again.
   */
  createRefund({ payment_intent: paymentIntent }, { idempotencyKey } = {}) {
    const known = idempotencyKey && this.refundList.find(r => r.idempotencyKey === idempotencyKey);
    if (known) return known;
    const charge = [...this.chargeMap.values()].find(c => c.payment_intent === paymentIntent);
    if (!charge) throw stripeError(`No such payment_intent: '${paymentIntent}'`);
    if (charge.refunded) {
      throw Object.assign(new Error('Charge has already been refunded.'), { type: 'StripeInvalidRequestError', code: 'charge_already_refunded' });
    }
    charge.refunded = true;
    const refund = { id: `re_${this.nextId()}`, object: 'refund', payment_intent: paymentIntent, status: 'succeeded', idempotencyKey };
    this.refundList.push(refund);
    return refund;
  }

  // ------------------------------------------------------------ test helpers

  /** A subscription for a customer, with dahlia field paths. */
  addSubscription({ customer, interval = 'month', status = 'active', created = this.now(), periodStart = created, periodEnd, trialEnd = null, cancelAtPeriodEnd = false, price, product = this.product, card }) {
    const id = `sub_${this.nextId()}`;
    // The card it is paid with. Each subscription gets its own card unless a test names one.
    const paymentMethod = `pm_${this.nextId()}`;
    this.paymentMethodMap.set(paymentMethod, {
      id: paymentMethod, object: 'payment_method', type: 'card', card: { fingerprint: card || `fp_${this.nextId()}` }
    });
    const length = interval === 'year' ? 365 * 86400 : 30 * 86400;
    const sub = {
      id,
      object: 'subscription',
      customer,
      status,
      created,
      trial_end: trialEnd,
      cancel_at_period_end: cancelAtPeriodEnd,
      cancel_at: null,
      default_payment_method: paymentMethod,
      items: {
        object: 'list',
        data: [{
          id: `si_${this.nextId()}`,
          current_period_start: periodStart,
          current_period_end: periodEnd === undefined ? periodStart + length : periodEnd,
          price: {
            id: price || (interval === 'year' ? this.prices.yearly : this.prices.monthly),
            product,
            recurring: { interval }
          }
        }]
      }
    };
    this.subs.set(id, sub);
    return sub;
  }

  /** Change what Stripe says about a subscription. */
  updateSubscription(id, patch) {
    const sub = this.subs.get(id);
    const { periodStart, periodEnd, ...rest } = patch;
    Object.assign(sub, rest);
    if (periodStart !== undefined) sub.items.data[0].current_period_start = periodStart;
    if (periodEnd !== undefined) sub.items.data[0].current_period_end = periodEnd;
    return sub;
  }

  /**
   * The buyer finishes checkout. Creates the customer (unless the session
   * named one) and the subscription, the way Stripe does after payment.
   */
  completeSession(sessionId, { paymentStatus, email, card } = {}) {
    const session = this.sessions.get(sessionId);
    const params = session.params;
    const trial = !!(params.subscription_data && params.subscription_data.trial_period_days);
    const interval = params.line_items[0].price === this.prices.yearly ? 'year' : 'month';
    const customer = session.customer || `cus_${this.nextId()}`;
    const now = this.now();
    const status = paymentStatus || (trial ? 'no_payment_required' : 'paid');
    const sub = this.addSubscription({
      customer,
      interval,
      price: params.line_items[0].price,
      status: trial ? 'trialing' : (status === 'unpaid' ? 'incomplete' : 'active'),
      created: now,
      periodStart: now,
      periodEnd: trial ? now + 7 * 86400 : undefined,
      trialEnd: trial ? now + 7 * 86400 : null,
      card
    });
    // A paid session has a paid first invoice, with its PaymentIntent and Charge.
    const invoice = status === 'paid' ? this.addPaidInvoice(sub.id).invoice : null;
    if (invoice) sub.latest_invoice = invoice;
    // Each buyer has their own email unless a test names one.
    const customerDetails = { email: email || `buyer${this.nextId()}@example.test` };
    Object.assign(session, { status: 'complete', payment_status: status, customer, customer_details: customerDetails, subscription: sub.id, invoice });
    return { session: clone(session), subscription: clone(sub) };
  }

  /** A delayed payment cleared (or failed) after checkout completed. */
  settleSession(sessionId, ok) {
    const session = this.sessions.get(sessionId);
    session.payment_status = ok ? 'paid' : 'unpaid';
    this.updateSubscription(session.subscription, { status: ok ? 'active' : 'incomplete_expired' });
    return clone(session);
  }

  expireSession(sessionId) {
    const session = this.sessions.get(sessionId);
    session.status = 'expired';
    return clone(session);
  }

  /**
   * A paid invoice for a subscription, with its PaymentIntent and Charge.
   * `extraInvoices` adds more invoice payments to the same PaymentIntent so the
   * pagination path runs.
   */
  addPaidInvoice(subscriptionId, { extraInvoices = 0 } = {}) {
    const sub = this.subs.get(subscriptionId);
    const paymentIntent = `pi_${this.nextId()}`;
    const charge = `ch_${this.nextId()}`;
    const payments = [];
    let first = null;
    for (let i = 0; i <= extraInvoices; i++) {
      const invoice = `in_${this.nextId()}`;
      this.invoiceMap.set(invoice, {
        id: invoice,
        object: 'invoice',
        customer: sub.customer,
        parent: i === 0
          ? { type: 'subscription_details', subscription_details: { subscription: subscriptionId } }
          : { type: 'quote_details', quote_details: { quote: 'qt_1' }, subscription_details: null }
      });
      payments.push({ id: `inpay_${this.nextId()}`, object: 'invoice_payment', invoice, status: 'paid', payment: { type: 'payment_intent', payment_intent: paymentIntent } });
      first = first || invoice;
    }
    // The subscription's invoice comes last, so it is on a later page.
    payments.reverse();
    this.invoicePaymentsByIntent.set(paymentIntent, payments);
    this.chargeMap.set(charge, { id: charge, object: 'charge', payment_intent: paymentIntent, customer: sub.customer, refunded: false });
    return { paymentIntent, charge, invoice: first };
  }
}
