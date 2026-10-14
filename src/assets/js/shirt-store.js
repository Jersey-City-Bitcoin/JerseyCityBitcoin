(function (root, factory) {
  var api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  if (root && root.document) {
    var container = root.document.querySelector('[data-shirt-store]');
    if (container) api.mount(container, root);
  }
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var SHOP_URL = 'https://jinn-hp.taild4516d.ts.net/shop';
  var POLL_MS = 2500;
  var POLL_CAP_MS = 20 * 60 * 1000;
  var STORAGE_KEY = 'jcb-shirt-order';

  var VIEW_FOR_STATE = {
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

  var MESSAGES = {
    bad_size: 'Pick a size.',
    bad_phone: 'Enter a phone number with 10 to 15 digits.',
    bad_email: 'Enter a valid email address.',
    limit_email: 'This email already has an open order. Use that order, or wait until it expires.',
    limit_ip: 'Too many open orders from this connection. Try again later.',
    rate_limited: 'Too many tries. Wait a few minutes and try again.',
    no_pickup: 'Cash reservations are closed until the next meetup date is set.',
    not_expired: 'This order is no longer expired. Refresh this page.',
  };

  function viewForState(state) {
    return VIEW_FOR_STATE[state] || null;
  }

  function isFinalState(state) {
    return Boolean(VIEW_FOR_STATE[state]) && state !== 'awaiting_payment';
  }

  function messageFor(code, size) {
    if (code === 'sold_out') return 'Size ' + size + ' is sold out.';
    return MESSAGES[code] || 'Something went wrong. Try again.';
  }

  function formatSats(n) {
    return typeof n === 'number' && isFinite(n) ? n.toLocaleString('en-US') + ' sats' : '';
  }

  function formatUsd(n, cents) {
    if (typeof n !== 'number' || !isFinite(n)) return '';
    return '$' + (cents ? n.toFixed(2) : String(n));
  }

  function formatCountdown(expiresAt, nowMs) {
    var end = Date.parse(expiresAt);
    if (!isFinite(end)) return '';
    var total = Math.max(0, Math.ceil((end - nowMs) / 1000));
    var seconds = total % 60;
    return Math.floor(total / 60) + ':' + (seconds < 10 ? '0' : '') + seconds;
  }

  function lightningUri(invoice) {
    if (typeof invoice !== 'string' || !/^lnbc[0-9]*[munp]?1[02-9ac-hj-np-z]+$/i.test(invoice)) return '';
    if (invoice !== invoice.toLowerCase() && invoice !== invoice.toUpperCase()) return '';
    return 'lightning:' + invoice;
  }

  function qrSvg(text, qrcodeLib) {
    if (typeof qrcodeLib !== 'function' || !text) return '';
    try {
      var qr = qrcodeLib(0, 'M');
      var upper = text.toUpperCase();
      if (/^[0-9A-Z $%*+\-./:]*$/.test(upper)) qr.addData(upper, 'Alphanumeric');
      else qr.addData(text);
      qr.make();
      return qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
    } catch (err) {
      return '';
    }
  }

  function validStock(body) {
    return Boolean(body) && typeof body.priceUsd === 'number' && Boolean(body.sizes) && typeof body.sizes === 'object';
  }

  function createShop(options) {
    var fetchFn = options.fetch;
    var render = options.render;
    var setTimer = options.setTimeout || setTimeout;
    var clearTimer = options.clearTimeout || clearTimeout;
    var now = options.now || Date.now;
    var storage = options.storage || null;
    var baseUrl = options.baseUrl || SHOP_URL;
    var stock = null;
    var order = null;
    var polling = false;
    var pollTimer = null;
    var pollStarted = 0;

    function request(path, init) {
      return fetchFn(baseUrl + path, init).then(function (res) {
        return res.text().then(function (text) {
          var body = text;
          try { body = JSON.parse(text); } catch (err) { body = text; }
          return { ok: res.ok, status: res.status, body: body };
        });
      });
    }

    function postJson(path, body) {
      return request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    function save() {
      try {
        if (storage) storage.setItem(STORAGE_KEY, JSON.stringify(order));
      } catch (err) { /* storage can be off in private windows */ }
    }

    function loadSaved() {
      try {
        var saved = storage && JSON.parse(storage.getItem(STORAGE_KEY));
        return saved && typeof saved.order === 'string' && typeof saved.token === 'string' ? saved : null;
      } catch (err) {
        return null;
      }
    }

    function show(view, error, size) {
      render(view, { order: order, stock: stock, error: error || null, size: size || null });
    }

    function stopPolling() {
      polling = false;
      if (pollTimer) clearTimer(pollTimer);
      pollTimer = null;
    }

    function offline() {
      stopPolling();
      render('offline', {});
    }

    function isOfflineAnswer(r) {
      var code = r.body && r.body.error;
      return !code || code === 'offline' || code === 'origin' || r.status >= 500;
    }

    function schedule() {
      pollTimer = setTimer(tick, POLL_MS);
    }

    function tick() {
      pollTimer = null;
      if (!polling) return;
      if (now() - pollStarted >= POLL_CAP_MS) {
        polling = false;
        show('checking');
        return;
      }
      var path = '/order/' + encodeURIComponent(order.order) + '?t=' + encodeURIComponent(order.token);
      request(path).then(function (r) {
        if (!polling) return;
        var state = r.ok && r.body && r.body.state;
        if (state) {
          if (state === 'awaiting_payment' && (
            (r.body.expiresAt && r.body.expiresAt !== order.expiresAt) ||
            (r.body.invoice && r.body.invoice !== order.invoice)
          )) return refreshOrder();
          order.state = state;
          if (r.body.expiresAt) order.expiresAt = r.body.expiresAt;
          save();
          if (isFinalState(state)) {
            polling = false;
            show(viewForState(state));
            return;
          }
        }
        schedule();
      }, function () {
        if (polling) schedule();
      });
    }

    function startLightning() {
      stopPolling();
      if (!lightningUri(order.invoice)) return show('checking');
      show('lightning');
      polling = true;
      pollStarted = now();
      schedule();
    }

    function loadStore() {
      return Promise.all([request('/health'), request('/stock')]).then(function (r) {
        var health = r[0];
        var answer = r[1];
        if (!health.ok || String(health.body).trim() !== 'ok' || !answer.ok || !validStock(answer.body)) return offline();
        stock = answer.body;
        show('form');
      }, offline);
    }

    function forgetOrder() {
      order = null;
      save();
    }

    function refreshOrder() {
      stopPolling();
      show('checking');
      var path = '/order/' + encodeURIComponent(order.order) + '?t=' + encodeURIComponent(order.token);
      return request(path).then(function (r) {
        var b = r.body;
        if (r.status === 404 && b && b.error === 'not_found') {
          forgetOrder();
          return loadStore();
        }
        if (!r.ok || !b || !viewForState(b.state)) return show('checking');

        var sameQuote = order.state === 'awaiting_payment' && Boolean(b.expiresAt) && b.expiresAt === order.expiresAt;
        var newInvoice = typeof b.invoice === 'string' && b.invoice && b.invoice !== order.invoice;
        if (b.state === 'awaiting_payment' && (!sameQuote || newInvoice)) {
          // An old invoice must not be paired with a replacement quote's price or expiry.
          delete order.invoice;
          delete order.lightning;
          delete order.sats;
          delete order.expiresAt;
        }
        ['state', 'size', 'priceUsd', 'sats', 'invoice', 'lightning', 'expiresAt', 'pickup'].forEach(function (key) {
          if (Object.prototype.hasOwnProperty.call(b, key)) order[key] = b[key];
        });
        save();
        if (order.state === 'awaiting_payment') {
          if (!order.invoice || typeof order.sats !== 'number' || !isFinite(order.sats) || !isFinite(Date.parse(order.expiresAt))) {
            return show('checking');
          }
          return startLightning();
        }
        return show(viewForState(order.state));
      }, function () { show('checking'); });
    }

    function load() {
      order = loadSaved();
      if (order) return refreshOrder();
      return loadStore();
    }

    function refreshStockWithError(code, size) {
      return request('/stock').then(function (r) {
        if (!r.ok || !validStock(r.body)) return offline();
        stock = r.body;
        show('form', code, size);
      }, offline);
    }

    function placeOrder(input) {
      var rail = input.rail === 'cash' ? 'cash' : 'ln';
      var body = { size: input.size, phone: input.phone, email: input.email, rail: rail };
      return postJson('/order', body).then(function (r) {
        var b = r.body;
        if (r.status === 201 && b && b.order && b.token) {
          order = {
            order: b.order,
            token: b.token,
            rail: rail,
            state: b.state,
            size: b.size,
            priceUsd: b.priceUsd,
            sats: b.sats,
            invoice: b.invoice,
            lightning: b.lightning,
            expiresAt: b.expiresAt,
            pickup: rail === 'cash' ? b.pickup : stock && stock.nextPickup,
          };
          save();
          if (rail === 'cash') return show('cash');
          return startLightning();
        }
        if (isOfflineAnswer(r)) return offline();
        if (b.error === 'sold_out') return refreshStockWithError('sold_out', body.size);
        return show('form', b.error, body.size);
      }, offline);
    }

    function requote() {
      if (!order) return Promise.resolve();
      var path = '/order/' + encodeURIComponent(order.order) + '/requote';
      return postJson(path, { t: order.token }).then(function (r) {
        var b = r.body;
        if (r.ok && b && b.invoice) {
          order.state = b.state;
          order.sats = b.sats;
          order.invoice = b.invoice;
          order.lightning = b.lightning;
          order.expiresAt = b.expiresAt;
          save();
          return startLightning();
        }
        if (b && b.error === 'not_expired') return refreshOrder();
        if (isOfflineAnswer(r)) return refreshOrder();
        return show('expired', b.error, order.size);
      }, refreshOrder);
    }

    return {
      load: load,
      placeOrder: placeOrder,
      requote: requote,
      stop: stopPolling,
      current: function () { return order; },
      isPolling: function () { return polling; },
    };
  }

  function valuesFor(order, stock) {
    var o = order || {};
    var pickup = o.pickup || (stock && stock.nextPickup) || {};
    var price = typeof o.priceUsd === 'number' ? o.priceUsd : stock && stock.priceUsd;
    return {
      order: o.order || '',
      size: o.size || '',
      sats: formatSats(o.sats),
      invoice: o.invoice || '',
      'price-usd': formatUsd(price),
      'price-usd-cents': formatUsd(price, true),
      'pickup-date': pickup.date || '',
      'pickup-venue': pickup.venue || '',
    };
  }

  function fill(view, values) {
    view.querySelectorAll('[data-fill]').forEach(function (el) {
      el.textContent = values[el.getAttribute('data-fill')] || '';
    });
    view.querySelectorAll('[data-row]').forEach(function (row) {
      var fills = Array.prototype.slice.call(row.querySelectorAll('[data-fill]'));
      if (row.hasAttribute('data-fill')) fills.push(row);
      row.hidden = fills.length > 0 && fills.every(function (el) { return !el.textContent; });
    });
  }

  function setNotice(el, text, lead) {
    if (!el) return;
    el.textContent = '';
    if (lead) {
      var strong = el.ownerDocument.createElement('strong');
      strong.textContent = lead;
      el.appendChild(strong);
      if (text) el.appendChild(el.ownerDocument.createTextNode(' ' + text));
    } else {
      el.textContent = text || '';
    }
    el.hidden = !lead && !text;
  }

  function renderSizes(view, stock, chosen) {
    var box = view.querySelector('[data-sizes]');
    var doc = box.ownerDocument;
    var checked = view.querySelector('input[name="size"]:checked');
    var keep = chosen || (checked && checked.value);
    var open = 0;
    box.textContent = '';
    Object.keys(stock.sizes).forEach(function (size) {
      var left = Number(stock.sizes[size]) || 0;
      var label = doc.createElement('label');
      var input = doc.createElement('input');
      var face = doc.createElement('span');
      var name = doc.createElement('b');
      var note = doc.createElement('small');
      label.className = left > 0 ? 'Size' : 'Size Size--out';
      input.type = 'radio';
      input.name = 'size';
      input.value = size;
      input.required = true;
      input.disabled = left < 1;
      input.checked = left > 0 && size === keep;
      name.textContent = size;
      note.textContent = left > 0 ? left + ' left' : 'Sold out';
      face.appendChild(name);
      face.appendChild(note);
      label.appendChild(input);
      label.appendChild(face);
      box.appendChild(label);
      if (left > 0) open += 1;
    });
    return open;
  }

  function createRenderer(container, win) {
    var views = Array.prototype.slice.call(container.querySelectorAll('[data-view]'));
    var current = null;
    var countdown = null;

    function renderForm(view, data) {
      var open = renderSizes(view, data.stock, data.size);
      var notice = view.querySelector('[data-size-notice]');
      if (open === 0) setNotice(notice, 'All sizes are sold out.');
      else if (data.error === 'sold_out') setNotice(notice, 'The other sizes are still available.', messageFor('sold_out', data.size));
      else setNotice(notice, '');
      if (data.error === 'sold_out') {
        var header = win.document.querySelector('.Header');
        notice.style.scrollMarginTop = ((header ? header.offsetHeight : 0) + 16) + 'px';
        notice.scrollIntoView({ block: 'start' });
      }
      setNotice(view.querySelector('[data-form-error]'), data.error && data.error !== 'sold_out' ? messageFor(data.error, data.size) : '');
      view.querySelector('[data-submit]').disabled = open === 0;
    }

    function renderLightning(view, order) {
      var link = lightningUri(order.invoice);
      if (!link) {
        view.querySelector('[data-wallet-link]').removeAttribute('href');
        view.querySelector('[data-qr]').textContent = '';
        return;
      }
      view.querySelector('[data-wallet-link]').setAttribute('href', link);
      view.querySelector('[data-qr]').innerHTML = qrSvg(link, win.qrcode);
      var clock = view.querySelector('[data-countdown]');
      var update = function () { clock.textContent = formatCountdown(order.expiresAt, Date.now()); };
      update();
      countdown = win.setInterval(update, 1000);
    }

    return function render(viewName, data) {
      data = data || {};
      if (countdown) win.clearInterval(countdown);
      countdown = null;
      var active = null;
      views.forEach(function (view) {
        var on = view.getAttribute('data-view') === viewName;
        view.hidden = !on;
        if (on) active = view;
      });
      if (!active) return;
      fill(active, valuesFor(data.order, data.stock));
      if (viewName === 'form') renderForm(active, data);
      if (viewName === 'lightning') renderLightning(active, data.order);
      if (viewName === 'expired') {
        setNotice(active.querySelector('[data-requote-error]'), data.error ? messageFor(data.error, data.size) : '');
      }
      var heading = active.querySelector('h2');
      if (heading && current && current !== viewName) heading.focus();
      current = viewName;
    };
  }

  function mount(container, win) {
    var storage = null;
    try { storage = win.sessionStorage; } catch (err) { storage = null; }
    var shop = createShop({
      fetch: win.fetch.bind(win),
      render: createRenderer(container, win),
      storage: storage,
      setTimeout: win.setTimeout.bind(win),
      clearTimeout: win.clearTimeout.bind(win),
    });

    var form = container.querySelector('[data-order-form]');
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var button = form.querySelector('[data-submit]');
      var size = form.querySelector('input[name="size"]:checked');
      var rail = form.querySelector('input[name="rail"]:checked');
      var done = function () { button.disabled = !form.querySelector('input[name="size"]:not(:disabled)'); };
      button.disabled = true;
      shop.placeOrder({
        size: size ? size.value : '',
        phone: form.elements.phone.value,
        email: form.elements.email.value,
        rail: rail ? rail.value : 'ln',
      }).then(done, done);
    });
    form.addEventListener('change', function (event) {
      if (event.target.name !== 'rail') return;
      form.querySelectorAll('.Pay-opt').forEach(function (opt) {
        opt.classList.toggle('Pay-opt--on', opt.querySelector('input').checked);
      });
    });

    var copy = container.querySelector('[data-copy]');
    copy.addEventListener('click', function () {
      var order = shop.current();
      if (!order || !order.invoice) return;
      var clip = win.navigator.clipboard;
      (clip ? clip.writeText(order.invoice) : Promise.reject(new Error('no clipboard'))).then(function () {
        copy.textContent = 'Copied';
        win.setTimeout(function () { copy.textContent = 'Copy invoice'; }, 2000);
      }, function () {
        var range = win.document.createRange();
        range.selectNodeContents(container.querySelector('[data-view="lightning"] .Invoice'));
        win.getSelection().removeAllRanges();
        win.getSelection().addRange(range);
      });
    });

    var again = container.querySelector('[data-requote]');
    again.addEventListener('click', function () {
      var done = function () { again.disabled = false; };
      again.disabled = true;
      shop.requote().then(done, done);
    });

    shop.load();
    return shop;
  }

  return {
    SHOP_URL: SHOP_URL,
    POLL_MS: POLL_MS,
    POLL_CAP_MS: POLL_CAP_MS,
    STORAGE_KEY: STORAGE_KEY,
    viewForState: viewForState,
    isFinalState: isFinalState,
    messageFor: messageFor,
    formatSats: formatSats,
    formatUsd: formatUsd,
    formatCountdown: formatCountdown,
    lightningUri: lightningUri,
    qrSvg: qrSvg,
    setNotice: setNotice,
    createShop: createShop,
    mount: mount,
  };
});
