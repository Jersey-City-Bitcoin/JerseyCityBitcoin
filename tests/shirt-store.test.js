const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  SHOP_URL,
  POLL_MS,
  POLL_CAP_MS,
  STORAGE_KEY,
  viewForState,
  isFinalState,
  formatSats,
  formatCountdown,
  lightningUri,
  qrSvg,
  setNotice,
  renderSizes,
  createShop,
} = require('../src/assets/js/shirt-store');
const qrcode = require('../src/assets/js/vendor/qrcode-generator-2.0.4.js');

const STOCK = {
  priceUsd: 40,
  sizes: { S: 6, M: 0, L: 9, XL: 4, '2XL': 2 },
  nextPickup: { date: 'Thursday, November 19, 2026, 7:00 PM', venue: 'Test venue' },
};
const TOKEN = 'abcdefghijklmnopqrstuv';
const LN_ORDER = {
  order: 'JCB-0042', state: 'awaiting_payment', size: 'L', invoice: 'lnbc1test', lightning: 'lightning:lnbc1test',
  sats: 38650, expiresAt: '2026-10-14T12:15:00.000Z', token: TOKEN, priceUsd: 40,
};
const CASH_ORDER = {
  order: 'JCB-0043', token: TOKEN, state: 'unpaid_cash', size: 'L', priceUsd: 40,
  pickup: { date: 'Thursday, November 19, 2026, 7:00 PM', venue: 'Test venue', endsAt: '2026-11-20T02:00:00.000Z' },
};

function reply(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return Promise.resolve({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(text) });
}

function fakeClock(start) {
  let t = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => t,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    pending: () => timers.size,
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        let due = null;
        for (const [id, timer] of timers) {
          if (timer.at <= end && (!due || timer.at < due[1].at)) due = [id, timer];
        }
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
        await flush();
      }
      t = end;
    },
  };
}

async function flush() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
  };
}

function setup(routes, opts = {}) {
  const clock = fakeClock(Date.parse('2026-10-14T12:00:00Z'));
  const calls = [];
  const views = [];
  const fetch = (url, init = {}) => {
    const method = init.method || 'GET';
    const p = url.slice(SHOP_URL.length).split('?')[0];
    calls.push({ method, path: p, url, body: init.body ? JSON.parse(init.body) : null });
    const handler = routes[`${method} ${p}`];
    if (!handler) return reply(404, { error: 'not_found' });
    return handler(calls.length);
  };
  const shop = createShop({
    fetch,
    render: (view, data) => views.push({ view, data }),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
    storage: opts.storage || memoryStorage(),
  });
  return { shop, clock, calls, views, last: () => views[views.length - 1] };
}

const BASE_ROUTES = {
  'GET /health': () => reply(200, 'ok'),
  'GET /stock': () => reply(200, STOCK),
};

test('the service base URL is one constant', () => {
  assert.equal(SHOP_URL, '/shop');
  assert.equal(POLL_MS, 2500);
  assert.equal(POLL_CAP_MS, 20 * 60 * 1000);
});

test('each service state maps to the right view', () => {
  const expected = {
    awaiting_payment: 'lightning',
    paid: 'paid',
    overpaid: 'overpaid',
    double_paid: 'double_paid',
    oversold: 'oversold',
    expired: 'expired',
    unpaid_cash: 'cash',
    paid_cash: 'picked_up',
    picked_up: 'picked_up',
  };
  for (const [state, view] of Object.entries(expected)) assert.equal(viewForState(state), view, state);
  assert.equal(viewForState('something_new'), null);
  assert.equal(isFinalState('awaiting_payment'), false);
  assert.equal(isFinalState('something_new'), false);
  for (const state of Object.keys(expected).filter((s) => s !== 'awaiting_payment')) {
    assert.equal(isFinalState(state), true, state);
  }
});

test('the form gets stock and pickup from the service', async () => {
  const s = setup(BASE_ROUTES);
  await s.shop.load();
  assert.deepEqual(s.calls.map((c) => c.path).sort(), ['/health', '/stock']);
  assert.equal(s.last().view, 'form');
  assert.deepEqual(s.last().data.stock, STOCK);
});

for (const [name, routes] of Object.entries({
  'health answers 503': { ...BASE_ROUTES, 'GET /health': () => reply(503, 'down') },
  'health fetch rejects': { ...BASE_ROUTES, 'GET /health': () => Promise.reject(new TypeError('Failed to fetch')) },
  'stock answers 500': { ...BASE_ROUTES, 'GET /stock': () => reply(500, { error: 'x' }) },
  'stock fetch rejects': { ...BASE_ROUTES, 'GET /stock': () => Promise.reject(new TypeError('Failed to fetch')) },
  'stock body is not stock': { ...BASE_ROUTES, 'GET /stock': () => reply(200, 'hello') },
})) {
  test(`shows the offline state when ${name}`, async () => {
    const s = setup(routes);
    await s.shop.load();
    assert.equal(s.last().view, 'offline');
    assert.equal(s.views.some((v) => v.view === 'form'), false);
  });
}

test('an order call that fails or answers offline shows the offline state', async () => {
  for (const handler of [() => Promise.reject(new TypeError('Failed to fetch')), () => reply(503, { error: 'offline' })]) {
    const s = setup({ ...BASE_ROUTES, 'POST /order': handler });
    await s.shop.load();
    await s.shop.placeOrder({ size: 'L', phone: '2015550142', email: 'a@b.co', rail: 'ln' });
    assert.equal(s.last().view, 'offline');
    assert.equal(s.clock.pending(), 0);
  }
});

test('the Lightning path polls every 2.5 s and stops at a final state', async () => {
  let polls = 0;
  const s = setup({
    ...BASE_ROUTES,
    'POST /order': () => reply(201, LN_ORDER),
    'GET /order/JCB-0042': () => {
      polls += 1;
      return reply(200, { order: 'JCB-0042', state: polls < 3 ? 'awaiting_payment' : 'paid', size: 'L', expiresAt: LN_ORDER.expiresAt });
    },
  });
  await s.shop.load();
  await s.shop.placeOrder({ size: 'L', phone: '2015550142', email: 'a@b.co', rail: 'ln' });
  assert.deepEqual(s.calls[2].body, { size: 'L', phone: '2015550142', email: 'a@b.co', rail: 'ln' });
  assert.equal(s.last().view, 'lightning');
  assert.equal(s.last().data.order.sats, 38650);

  await s.clock.advance(POLL_MS - 1);
  assert.equal(polls, 0);
  await s.clock.advance(1);
  assert.equal(polls, 1);
  assert.match(s.calls[3].url, /\/order\/JCB-0042\?t=abcdefghijklmnopqrstuv$/);

  await s.clock.advance(POLL_MS * 2);
  assert.equal(polls, 3);
  assert.equal(s.last().view, 'paid');
  assert.equal(s.shop.isPolling(), false);
  assert.equal(s.clock.pending(), 0);

  await s.clock.advance(POLL_MS * 20);
  assert.equal(polls, 3);
});

for (const state of ['paid', 'overpaid', 'double_paid', 'oversold', 'expired', 'picked_up']) {
  test(`polling stops at ${state} and shows its view`, async () => {
    const s = setup({
      ...BASE_ROUTES,
      'POST /order': () => reply(201, LN_ORDER),
      'GET /order/JCB-0042': () => reply(200, { order: 'JCB-0042', state, size: 'L', expiresAt: LN_ORDER.expiresAt }),
    });
    await s.shop.load();
    await s.shop.placeOrder({ size: 'L', phone: '2015550142', email: 'a@b.co', rail: 'ln' });
    await s.clock.advance(POLL_MS * 10);
    assert.equal(s.calls.filter((c) => c.path === '/order/JCB-0042').length, 1);
    assert.equal(s.last().view, viewForState(state));
    assert.equal(s.clock.pending(), 0);
  });
}

test('a failed poll keeps polling', async () => {
  let polls = 0;
  const s = setup({
    ...BASE_ROUTES,
    'POST /order': () => reply(201, LN_ORDER),
    'GET /order/JCB-0042': () => {
      polls += 1;
      if (polls === 1) return Promise.reject(new TypeError('Failed to fetch'));
      if (polls === 2) return reply(429, { error: 'rate_limited' });
      return reply(200, { order: 'JCB-0042', state: 'paid', size: 'L' });
    },
  });
  await s.shop.load();
  await s.shop.placeOrder({ size: 'L', phone: '2015550142', email: 'a@b.co', rail: 'ln' });
  await s.clock.advance(POLL_MS * 3);
  assert.equal(polls, 3);
  assert.equal(s.last().view, 'paid');
});

test('a quote changed in another tab never pairs its expiry with the old invoice', async () => {
  for (const fullQuote of [false, true]) {
    const storage = memoryStorage();
    const changed = { state: 'awaiting_payment', expiresAt: '2026-10-14T12:30:00Z' };
    const s = setup({
      ...BASE_ROUTES,
      'POST /order': () => reply(201, LN_ORDER),
      'GET /order/JCB-0042': () => reply(200, fullQuote
        ? { ...changed, invoice: 'lnbc1fresh', sats: 39000 }
        : changed),
    }, { storage });
    await s.shop.load();
    await s.shop.placeOrder({ size: 'L', phone: '2015550142', email: 'a@b.co', rail: 'ln' });
    await s.clock.advance(POLL_MS);
    assert.equal(s.calls.filter((c) => c.path === '/order/JCB-0042').length, 2);
    assert.equal(s.last().view, fullQuote ? 'lightning' : 'checking');
    assert.equal(s.shop.current().invoice, fullQuote ? 'lnbc1fresh' : undefined);
    assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).invoice, fullQuote ? 'lnbc1fresh' : undefined);
    assert.equal(s.clock.pending(), fullQuote ? 1 : 0);
  }
});

test('after 20 minutes without a final state it shows still checking and stops', async () => {
  let polls = 0;
  const s = setup({
    ...BASE_ROUTES,
    'POST /order': () => reply(201, LN_ORDER),
    'GET /order/JCB-0042': () => {
      polls += 1;
      return reply(200, { order: 'JCB-0042', state: 'awaiting_payment', size: 'L' });
    },
  });
  await s.shop.load();
  await s.shop.placeOrder({ size: 'L', phone: '2015550142', email: 'a@b.co', rail: 'ln' });
  await s.clock.advance(POLL_CAP_MS - POLL_MS);
  assert.equal(s.last().view, 'lightning');
  const before = polls;
  await s.clock.advance(POLL_MS);
  assert.equal(polls, before);
  assert.equal(polls, POLL_CAP_MS / POLL_MS - 1);
  assert.equal(s.last().view, 'checking');
  assert.equal(s.last().data.order.order, 'JCB-0042');
  assert.equal(s.shop.isPolling(), false);
  assert.equal(s.clock.pending(), 0);
  await s.clock.advance(POLL_CAP_MS);
  assert.equal(polls, before);
});

test('the cash path shows reserved at once and never polls', async () => {
  const s = setup({
    ...BASE_ROUTES,
    'POST /order': () => reply(201, CASH_ORDER),
  });
  await s.shop.load();
  await s.shop.placeOrder({ size: 'L', phone: '2015550142', email: 'a@b.co', rail: 'cash' });
  assert.equal(s.calls[2].body.rail, 'cash');
  assert.equal(s.last().view, 'cash');
  assert.deepEqual(s.last().data.order.pickup, CASH_ORDER.pickup);
  assert.equal(s.clock.pending(), 0);
  await s.clock.advance(POLL_CAP_MS * 2);
  assert.equal(s.calls.length, 3);
  assert.equal(s.calls.some((c) => c.path.startsWith('/order/')), false);
  assert.equal(s.views.some((v) => v.view === 'lightning'), false);
});

test('a refresh checks saved Lightning and cash orders before showing their current states', async () => {
  const storage = memoryStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify({ ...LN_ORDER, rail: 'ln' }));
  const ln = setup({ 'GET /order/JCB-0042': () => reply(200, { order: 'JCB-0042', state: 'paid', size: 'L' }) }, { storage });
  await ln.shop.load();
  assert.equal(ln.views[0].view, 'checking');
  assert.equal(ln.last().view, 'paid');
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).state, 'paid');
  assert.equal(ln.clock.pending(), 0);

  const cashStorage = memoryStorage();
  cashStorage.setItem(STORAGE_KEY, JSON.stringify({ ...CASH_ORDER, rail: 'cash' }));
  const cash = setup({ 'GET /order/JCB-0043': () => reply(200, { state: 'picked_up' }) }, { storage: cashStorage });
  await cash.shop.load();
  await cash.clock.advance(POLL_CAP_MS);
  assert.equal(cash.views[0].view, 'checking');
  assert.equal(cash.last().view, 'picked_up');
  assert.equal(cash.calls.length, 1);
  assert.equal(cash.clock.pending(), 0);
});

test('a saved expired order can recover a late payment on refresh', async () => {
  const storage = memoryStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify({ ...LN_ORDER, rail: 'ln', state: 'expired' }));
  const s = setup({ 'GET /order/JCB-0042': () => reply(200, { state: 'paid' }) }, { storage });
  await s.shop.load();
  assert.deepEqual(s.views.map((v) => v.view), ['checking', 'paid']);
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).state, 'paid');
});

test('a matching saved Lightning quote keeps its invoice and resumes polling', async () => {
  const storage = memoryStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify({ ...LN_ORDER, rail: 'ln' }));
  let calls = 0;
  const s = setup({
    'GET /order/JCB-0042': () => reply(200, ++calls === 1
      ? { state: 'awaiting_payment', expiresAt: LN_ORDER.expiresAt }
      : { state: 'paid' }),
  }, { storage });
  await s.shop.load();
  assert.equal(s.last().view, 'lightning');
  assert.equal(s.last().data.order.invoice, LN_ORDER.invoice);
  assert.equal(s.clock.pending(), 1);
  await s.clock.advance(POLL_MS);
  assert.equal(s.last().view, 'paid');
});

test('a replacement quote without payment details never reuses a cached invoice', async () => {
  for (const savedState of ['awaiting_payment', 'expired']) {
    const storage = memoryStorage();
    storage.setItem(STORAGE_KEY, JSON.stringify({ ...LN_ORDER, rail: 'ln', state: savedState }));
    const s = setup({
      'GET /order/JCB-0042': () => reply(200, { state: 'awaiting_payment', expiresAt: '2026-10-14T12:30:00Z' }),
    }, { storage });
    await s.shop.load();
    assert.equal(s.last().view, 'checking');
    assert.equal(s.shop.current().invoice, undefined);
    assert.equal(s.shop.current().sats, undefined);
    assert.equal(s.clock.pending(), 0);
    assert.equal(s.views.some((v) => v.view === 'lightning'), false);
  }
});

test('a saved order recovers a full replacement invoice returned by the service', async () => {
  const storage = memoryStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify({ ...LN_ORDER, rail: 'ln', state: 'expired' }));
  const s = setup({
    'GET /order/JCB-0042': () => reply(200, {
      state: 'awaiting_payment', invoice: 'lnbc1new', sats: 39000, expiresAt: '2026-10-14T12:30:00Z',
    }),
  }, { storage });
  await s.shop.load();
  assert.equal(s.last().view, 'lightning');
  assert.equal(s.shop.current().invoice, 'lnbc1new');
  assert.equal(s.shop.current().lightning, undefined);
  assert.equal(s.shop.current().sats, 39000);
  assert.equal(s.shop.current().token, TOKEN);
  assert.equal(s.clock.pending(), 1);
});

test('failed saved-order checks preserve the reference without confirming cached payment or reservation', async () => {
  for (const saved of [{ ...LN_ORDER, rail: 'ln', state: 'paid' }, { ...CASH_ORDER, rail: 'cash' }]) {
    for (const handler of [
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => reply(503, { error: 'offline' }),
      () => reply(400, { error: 'bad_token' }),
      () => reply(200, { state: 'unexpected' }),
    ]) {
      const storage = memoryStorage();
      storage.setItem(STORAGE_KEY, JSON.stringify(saved));
      const s = setup({ [`GET /order/${saved.order}`]: handler }, { storage });
      await s.shop.load();
      assert.equal(s.last().view, 'checking');
      assert.equal(s.last().data.order.order, saved.order);
      assert.equal(s.views.every((v) => v.view === 'checking'), true);
      assert.equal(s.calls.length, 1);
      assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).token, TOKEN);
      assert.equal(s.clock.pending(), 0);
    }
  }
});

test('an explicitly missing saved order is cleared and current stock is loaded', async () => {
  const storage = memoryStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify({ ...LN_ORDER, rail: 'ln' }));
  const s = setup({ ...BASE_ROUTES, 'GET /order/JCB-0042': () => reply(404, { error: 'not_found' }) }, { storage });
  await s.shop.load();
  assert.equal(s.last().view, 'form');
  assert.equal(s.shop.current(), null);
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)), null);
  assert.deepEqual(s.calls.map((c) => c.path), ['/order/JCB-0042', '/health', '/stock']);
});

test('a sold-out answer reloads stock and shows the form with the size named', async () => {
  let stockCalls = 0;
  const s = setup({
    'GET /health': () => reply(200, 'ok'),
    'GET /stock': () => {
      stockCalls += 1;
      return reply(200, stockCalls === 1 ? STOCK : { ...STOCK, sizes: { ...STOCK.sizes, L: 0 } });
    },
    'POST /order': () => reply(409, { error: 'sold_out' }),
  });
  await s.shop.load();
  await s.shop.placeOrder({ size: 'L', phone: '2015550142', email: 'a@b.co', rail: 'ln' });
  assert.equal(stockCalls, 2);
  assert.equal(s.last().view, 'form');
  assert.equal(s.last().data.error, 'sold_out');
  assert.equal(s.last().data.size, 'L');
  assert.equal(s.last().data.stock.sizes.L, 0);
});

test('form errors from the service stay on the form', async () => {
  for (const code of ['bad_phone', 'bad_email', 'limit_email', 'no_pickup', 'rate_limited']) {
    const s = setup({ ...BASE_ROUTES, 'POST /order': () => reply(code === 'no_pickup' ? 409 : 400, { error: code }) });
    await s.shop.load();
    await s.shop.placeOrder({ size: 'L', phone: 'x', email: 'y', rail: 'cash' });
    assert.equal(s.last().view, 'form', code);
    assert.equal(s.last().data.error, code);
    assert.equal(s.clock.pending(), 0);
  }
});

test('a fresh quote after expiry shows the new invoice and polls again', async () => {
  let polls = 0;
  const s = setup({
    ...BASE_ROUTES,
    'POST /order': () => reply(201, LN_ORDER),
    'GET /order/JCB-0042': () => {
      polls += 1;
      return reply(200, { order: 'JCB-0042', state: polls === 1 ? 'expired' : 'paid', size: 'L' });
    },
    'POST /order/JCB-0042/requote': () => reply(200, { ...LN_ORDER, invoice: 'lnbc1new', lightning: 'lightning:lnbc1new', sats: 39000, token: undefined }),
  });
  await s.shop.load();
  await s.shop.placeOrder({ size: 'L', phone: '2015550142', email: 'a@b.co', rail: 'ln' });
  await s.clock.advance(POLL_MS);
  assert.equal(s.last().view, 'expired');
  await s.shop.requote();
  const requote = s.calls.find((c) => c.path === '/order/JCB-0042/requote');
  assert.deepEqual(requote.body, { t: TOKEN });
  assert.equal(s.last().view, 'lightning');
  assert.equal(s.last().data.order.invoice, 'lnbc1new');
  assert.equal(s.last().data.order.token, TOKEN);
  await s.clock.advance(POLL_MS);
  assert.equal(s.last().view, 'paid');
});

test('a refused fresh quote stays on the expired view with the reason', async () => {
  const s = setup({
    ...BASE_ROUTES,
    'POST /order': () => reply(201, LN_ORDER),
    'GET /order/JCB-0042': () => reply(200, { order: 'JCB-0042', state: 'expired', size: 'L' }),
    'POST /order/JCB-0042/requote': () => reply(409, { error: 'sold_out' }),
  });
  await s.shop.load();
  await s.shop.placeOrder({ size: 'L', phone: '2015550142', email: 'a@b.co', rail: 'ln' });
  await s.clock.advance(POLL_MS);
  await s.shop.requote();
  assert.equal(s.last().view, 'expired');
  assert.equal(s.last().data.error, 'sold_out');
  assert.equal(s.clock.pending(), 0);
});

test('a not_expired requote reconciles the order instead of asking for an ineffective refresh', async () => {
  const s = setup({
    ...BASE_ROUTES,
    'POST /order': () => reply(201, LN_ORDER),
    'GET /order/JCB-0042': () => reply(200, { state: 'paid' }),
    'POST /order/JCB-0042/requote': () => reply(409, { error: 'not_expired' }),
  });
  await s.shop.load();
  await s.shop.placeOrder({ size: 'L', phone: '2015550142', email: 'a@b.co', rail: 'ln' });
  await s.shop.requote();
  assert.equal(s.last().view, 'paid');
  assert.equal(s.calls.at(-1).path, '/order/JCB-0042');
  assert.equal(s.clock.pending(), 0);
});

test('a lost requote response recovers the replacement invoice from the existing order', async () => {
  const storage = memoryStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify({ ...LN_ORDER, rail: 'ln', state: 'expired' }));
  let requoted = false;
  const s = setup({
    'GET /order/JCB-0042': () => reply(200, requoted
      ? { state: 'awaiting_payment', invoice: 'lnbc1fresh', sats: 39000, expiresAt: '2026-10-14T12:30:00Z' }
      : { state: 'expired' }),
    'POST /order/JCB-0042/requote': () => {
      requoted = true;
      return Promise.reject(new TypeError('Failed to fetch'));
    },
  }, { storage });
  await s.shop.load();
  assert.equal(s.last().view, 'expired');
  await s.shop.requote();
  assert.equal(s.last().view, 'lightning');
  assert.equal(s.shop.current().invoice, 'lnbc1fresh');
  assert.equal(s.shop.current().token, TOKEN);
  assert.equal(s.clock.pending(), 1);
});

test('formatters', () => {
  assert.equal(formatSats(38650), '38,650 sats');
  assert.equal(formatSats(undefined), '');
  assert.equal(formatCountdown('2026-10-14T12:15:00Z', Date.parse('2026-10-14T12:00:39Z')), '14:21');
  assert.equal(formatCountdown('2026-10-14T12:15:00Z', Date.parse('2026-10-14T12:20:00Z')), '0:00');
  assert.equal(formatCountdown(null, 0), '');
});

test('wallet URIs are derived from mainnet invoices with a single case', () => {
  assert.equal(lightningUri('lnbc1test'), 'lightning:lnbc1test');
  assert.equal(lightningUri('LNBC10U1TEST'), 'lightning:LNBC10U1TEST');
  for (const invoice of [null, '', 'javascript:alert(1)', 'https://example.com', 'lnbc1test\n', 'lnbc1Test', 'lnbc1bad', 'lntb1test']) {
    assert.equal(lightningUri(invoice), '', String(invoice));
  }
});

test('malformed invoices never open a payment view for new or saved orders', async () => {
  for (const invoice of ['javascript:alert(1)', 'lnbc1bad', 'lnbc1Test']) {
    const malformed = { ...LN_ORDER, invoice, lightning: 'https://example.com' };
    const fresh = setup({ ...BASE_ROUTES, 'POST /order': () => reply(201, malformed) });
    await fresh.shop.load();
    await fresh.shop.placeOrder({ size: 'L', phone: '2015550142', email: 'a@b.co', rail: 'ln' });
    assert.equal(fresh.last().view, 'checking');
    assert.equal(fresh.last().data.order.order, LN_ORDER.order);
    assert.equal(fresh.clock.pending(), 0);
    assert.equal(fresh.views.some((v) => v.view === 'lightning'), false);

    const storage = memoryStorage();
    storage.setItem(STORAGE_KEY, JSON.stringify({ ...malformed, rail: 'ln' }));
    const saved = setup({ 'GET /order/JCB-0042': () => reply(200, malformed) }, { storage });
    await saved.shop.load();
    assert.equal(saved.last().view, 'checking');
    assert.equal(saved.clock.pending(), 0);
    assert.equal(saved.views.some((v) => v.view === 'lightning'), false);
  }
});

test('a malformed replacement invoice preserves the order reference without inviting payment', async () => {
  const storage = memoryStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify({ ...LN_ORDER, rail: 'ln', state: 'expired' }));
  const s = setup({
    'GET /order/JCB-0042': () => reply(200, { state: 'expired' }),
    'POST /order/JCB-0042/requote': () => reply(200, { ...LN_ORDER, invoice: 'https://example.com' }),
  }, { storage });
  await s.shop.load();
  await s.shop.requote();
  assert.equal(s.last().view, 'checking');
  assert.equal(s.shop.current().order, LN_ORDER.order);
  assert.equal(s.clock.pending(), 0);
  assert.equal(s.views.some((v) => v.view === 'lightning'), false);
});

test('the vendored QR library draws the invoice as SVG', () => {
  const svg = qrSvg('lightning:lnbc386500n1ptest0invoice', qrcode);
  assert.match(svg, /^<svg /);
  assert.match(svg, /<path d="M/);
  assert.equal(qrSvg('', qrcode), '');
  assert.equal(qrSvg('lightning:x', undefined), '');
});

test('the QR has a 4-module white quiet zone', () => {
  const text = 'lightning:lnbc386500n1ptest0invoice';
  const qr = qrcode(0, 'M');
  qr.addData(text.toUpperCase(), 'Alphanumeric');
  qr.make();
  const size = (qr.getModuleCount() + 8) * 4;
  const svg = qrSvg(text, qrcode);
  assert.match(svg, new RegExp(`viewBox="0 0 ${size} ${size}"`));
  assert.match(svg, /<rect width="100%" height="100%" fill="white"/);
  const coords = [...svg.matchAll(/M(\d+),(\d+)/g)].flatMap((m) => [Number(m[1]), Number(m[2])]);
  assert.equal(Math.min(...coords), 16);
  assert.equal(Math.max(...coords), size - 16 - 4);
});

test('the sold-out notice bolds its first sentence with DOM nodes', () => {
  const doc = {
    createElement: (tag) => ({ tag, textContent: '' }),
    createTextNode: (text) => ({ text }),
  };
  const el = {
    ownerDocument: doc,
    children: [],
    hidden: true,
    set textContent(v) { this.children = v ? [{ text: v }] : []; },
    set innerHTML(v) { throw new Error('innerHTML used'); },
    appendChild(node) { this.children.push(node); },
  };
  setNotice(el, 'The other sizes are still available.', 'Size M is sold out.');
  assert.deepEqual(el.children, [{ tag: 'strong', textContent: 'Size M is sold out.' }, { text: ' The other sizes are still available.' }]);
  assert.equal(el.hidden, false);
  setNotice(el, 'All sizes are sold out.');
  assert.deepEqual(el.children, [{ text: 'All sizes are sold out.' }]);
  setNotice(el, '');
  assert.deepEqual(el.children, []);
  assert.equal(el.hidden, true);
});

test('open size tiles show only the size and sold-out tiles say Sold out', () => {
  const node = (tag) => ({
    tag, textContent: '', children: [],
    appendChild(child) { this.children.push(child); },
  });
  const box = node('div');
  box.ownerDocument = { createElement: node };
  const view = { querySelector: (sel) => (sel === '[data-sizes]' ? box : null) };
  const open = renderSizes(view, { sizes: { S: 7, L: 0 } });
  assert.equal(open, 1);
  const face = (label) => label.children[1];
  const [s, l] = box.children;
  assert.deepEqual(face(s).children.map((c) => [c.tag, c.textContent]), [['b', 'S']]);
  assert.equal(s.children[0].disabled, false);
  assert.deepEqual(face(l).children.map((c) => [c.tag, c.textContent]), [['b', 'L'], ['small', 'Sold out']]);
  assert.equal(l.children[0].disabled, true);
});

test('buy another forgets a finished order and shows the size picker, also after a refresh', async () => {
  const storage = memoryStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify({ ...LN_ORDER, rail: 'ln', state: 'paid' }));
  const s = setup({ ...BASE_ROUTES, 'GET /order/JCB-0042': () => reply(200, { state: 'paid' }) }, { storage });
  await s.shop.load();
  assert.equal(s.last().view, 'paid');
  await s.shop.buyAnother();
  assert.equal(s.last().view, 'form');
  assert.equal(s.last().data.order, null);
  assert.deepEqual(s.last().data.stock, STOCK);
  assert.equal(s.shop.current(), null);
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)), null);

  const again = setup({ ...BASE_ROUTES }, { storage });
  await again.shop.load();
  assert.equal(again.calls.some((c) => c.path.startsWith('/order/')), false);
  assert.equal(again.last().view, 'form');
});

test('every final view has a Buy another shirt button', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/pages/shirt.html'), 'utf8');
  const finals = new Set(['paid', 'overpaid', 'double_paid', 'oversold', 'expired', 'unpaid_cash', 'paid_cash', 'picked_up']
    .filter(isFinalState).map(viewForState));
  assert.deepEqual([...finals].sort(), ['cash', 'double_paid', 'expired', 'overpaid', 'oversold', 'paid', 'picked_up']);
  for (const view of finals) {
    const block = html.split(`data-view="${view}"`)[1].split('data-view=')[0];
    assert.match(block, /<button class="Contact-submit Contact-submit--ghost" type="button" data-buy-another>Buy another shirt<\/button>/, view);
  }
  for (const view of ['form', 'lightning', 'checking', 'offline']) {
    const block = html.split(`data-view="${view}"`)[1].split('data-view=')[0];
    assert.doesNotMatch(block, /data-buy-another/, view);
  }
});

test('the overpaid and paid-twice views show no sats amount', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/pages/shirt.html'), 'utf8');
  for (const view of ['overpaid', 'double_paid']) {
    const block = html.split(`data-view="${view}"`)[1].split('data-view=')[0];
    assert.doesNotMatch(block, /data-fill="sats"/, view);
  }
});

test('the script never sets window.onload, which confetti.js owns', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/assets/js/shirt-store.js'), 'utf8');
  assert.doesNotMatch(source, /onload/);
});
