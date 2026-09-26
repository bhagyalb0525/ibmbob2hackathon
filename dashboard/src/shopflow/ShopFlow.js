// ===========================================================================
// ShopFlow — storefront for the LEFT panel.
//
// SCOPE (Phase 2 — real checkout):
//   • Visual ecommerce shell: brand, sidebar nav, checkout page.
//   • LOCAL interactions: nav selection, quantity +/-, coupon entry/apply.
//   • "Pay Now" performs a REAL checkout against the existing demo_service
//     through the dashboard proxy at POST /api/shopflow/checkout. The order
//     number, totals and error text shown here all come from the real
//     response — nothing about the result is simulated.
//
// EXPLICITLY OUT OF SCOPE:
//   • The browser never calls :3001 directly (one origin, no CORS needed).
//   • The demo_service, its cart logic and its seeded defect are NOT modified.
//   • No REGEN pipeline / orchestrator / agent invocation from here — the
//     dashboard proxy only records an in-memory IncidentPayload for Phase 3.
//   • No second service, database or cache.
//
// All static data is local demo data. Order state is in-memory per page load.
// ===========================================================================

'use strict';

// ---------------------------------------------------------------- Static data
const SF_PRODUCTS = [
  { id: 'laptop', name: 'Laptop',          price: 50000, icon: '💻' },
  { id: 'mouse',  name: 'Wireless Mouse', price: 1000,  icon: '🖱️' },
];

// Cross-currency vouchers (EUR) — the exact scenario demo_service's
// convertVoucherDiscount() is built around. EUR rate must stay in sync with
// EXCHANGE_RATES.EUR in demo_service/src/services/cart.ts (1.08).
// The cart currency is INR, which the backend resolves at rate 1.0 via its
// `EXCHANGE_RATES[cur] || 1` fallback, so the €→₹ conversion is a genuine
// cross-currency step and the Math.trunc defect is genuinely exercised.
const SF_EUR_RATE = 1.08;
const SF_CURRENCY = 'INR';
const SF_TAX_RATE = 0;   // keeps Total === Subtotal − Discount, fully visible in the summary

const SF_COUPONS = {
  EUR10OFF:  { amount: 10,  label: '€10 voucher' },
  EUR50OFF:  { amount: 50,  label: '€50 voucher' },
  EUR100OFF: { amount: 100, label: '€100 voucher' },
};

const SF_NAV = [
  { id: 'home',     label: 'Home',     icon: '🏠' },
  { id: 'products', label: 'Products', icon: '📦' },
  { id: 'cart',     label: 'Cart',     icon: '🛒', badge: true },
  { id: 'orders',   label: 'Orders',   icon: '📋' },
  { id: 'checkout', label: 'Checkout', icon: '💳' },
];

const SF_ORDERS = [
  { id: 'SF-10042', date: '24 Aug 2026', items: 'Wireless Mouse × 1',        total: 1000,  status: 'Delivered' },
  { id: 'SF-10039', date: '19 Aug 2026', items: 'Laptop × 1',                total: 50000, status: 'Delivered' },
  { id: 'SF-10031', date: '11 Aug 2026', items: 'Laptop × 1, Mouse × 2',     total: 52000, status: 'Delivered' },
];

const VIEW_TITLES = {
  home:     { title: 'Home',     sub: 'Welcome back to ShopFlow' },
  products: { title: 'Products', sub: 'Everything in the catalogue' },
  cart:     { title: 'Cart',     sub: 'Review the items in your cart' },
  orders:   { title: 'Orders',   sub: 'Your recent order history' },
  checkout: { title: 'Checkout', sub: 'Review your order and complete payment' },
};

// -------------------------------------------------------------------- State
const sfState = {
  view: 'checkout',                       // Checkout is the initial view
  qty: { laptop: 1, mouse: 1 },
  orderId: 'sf-' + Date.now(),
  couponInput: 'EUR10OFF',
  // EUR10OFF is pre-applied so the canonical demo is a single "Pay Now" click.
  coupon: 'EUR10OFF',
  couponError: '',
  payment: { number: '', expiry: '', cvv: '' },
  status: {
    tone: 'ok',
    title: 'Payment Ready',
    detail: 'Cart totals verified. No payment issues detected.',
  },
  lastIncidentId: null,
  submitting: false,
};

// ----------------------------------------------------------------- Helpers
function sfEsc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sfMoney(n) {
  return '₹' + Math.round(n).toLocaleString('en-IN');
}

function sfProduct(id) {
  return SF_PRODUCTS.find(p => p.id === id);
}

function sfSubtotal() {
  return SF_PRODUCTS.reduce((sum, p) => sum + p.price * sfState.qty[p.id], 0);
}

/**
 * Cross-currency voucher conversion using the CORRECT rounding.
 * This is a faithful mirror of demo_service convertVoucherDiscount() in its
 * healthy form, i.e. the figure the payment gateway authorises.
 *
 *   10 EUR x 1.08 = 10.8  ->  Math.round = 11   (correct)
 *                        ->  Math.trunc = 10   (the seeded defect)
 */
function sfConvertVoucher(amountEur) {
  const toRate = 1;   // backend: EXCHANGE_RATES['INR'] || 1
  return Math.round((amountEur * SF_EUR_RATE) / toRate);
}

function sfDiscount() {
  if (!sfState.coupon) return 0;
  const c = SF_COUPONS[sfState.coupon];
  if (!c) return 0;
  return Math.min(sfConvertVoucher(c.amount), sfSubtotal());
}

function sfTotal() {
  return Math.max(0, sfSubtotal() - sfDiscount());
}

/**
 * The `expectedTotal` we send to the checkout service.
 * Mirrors applyVoucherAndCalculateTotals() step for step so that, against a
 * healthy backend, the calculated grandTotal equals this value exactly.
 */
function sfExpectedTotal() {
  const taxBase = Math.max(0, sfSubtotal() - sfDiscount());
  const tax = Number((taxBase * SF_TAX_RATE).toFixed(2));
  return Number((taxBase + tax).toFixed(2));
}

/** Build the exact request body the existing demo_service expects. */
function sfBuildCheckoutPayload() {
  const coupon = sfState.coupon && SF_COUPONS[sfState.coupon];
  return {
    orderId: sfState.orderId,
    items: SF_PRODUCTS.map(p => ({
      id: p.id,
      name: p.name,
      unitPrice: p.price,
      quantity: sfState.qty[p.id],
      currency: SF_CURRENCY,
    })),
    currency: SF_CURRENCY,
    voucher: coupon
      ? { code: sfState.coupon, discountAmount: coupon.amount, voucherCurrency: 'EUR' }
      : null,
    taxRate: SF_TAX_RATE,
    paymentMethod: 'CARD',
    expectedTotal: sfExpectedTotal(),
  };
}

function sfCartCount() {
  return SF_PRODUCTS.reduce((n, p) => n + sfState.qty[p.id], 0);
}

function sfSetStatus(tone, title, detail) {
  sfState.status = { tone, title, detail };
}

// ---------------------------------------------------------- Fragments
function sfQtyControl(id, qty) {
  return `
    <div class="sf-qty">
      <button type="button" class="sf-qty__btn" data-action="qty" data-id="${id}" data-delta="-1"
              ${qty <= 1 ? 'disabled' : ''} aria-label="Decrease ${sfEsc(sfProduct(id).name)} quantity">−</button>
      <span class="sf-qty__val">${qty}</span>
      <button type="button" class="sf-qty__btn" data-action="qty" data-id="${id}" data-delta="1"
              aria-label="Increase ${sfEsc(sfProduct(id).name)} quantity">+</button>
    </div>`;
}

function sfStatusBanner() {
  const icons = { ok: '✓', busy: '◌', error: '✕' };
  const s = sfState.status;
  return `
    <div class="sf-status sf-status--${s.tone}" role="status" aria-live="polite">
      <span class="sf-status__icon">${icons[s.tone] || '•'}</span>
      <div>
        <div class="sf-status__title">${sfEsc(s.title)}</div>
        <div class="sf-status__detail">${sfEsc(s.detail)}</div>
      </div>
    </div>`;
}

function sfSidebar() {
  const count = sfCartCount();
  return `
    <aside class="sf-sidebar">
      <nav class="sf-nav" aria-label="ShopFlow sections">
        ${SF_NAV.map(item => `
          <button type="button" class="sf-nav__item ${sfState.view === item.id ? 'is-active' : ''}"
                  data-action="nav" data-view="${item.id}"
                  aria-current="${sfState.view === item.id ? 'page' : 'false'}">
            <span class="sf-nav__icon">${item.icon}</span>
            <span>${item.label}</span>
            ${item.badge ? `<span class="sf-nav__badge">${count}</span>` : ''}
          </button>`).join('')}
      </nav>
      <div class="sf-sidebar__foot">
        <b>● Storefront healthy</b>
        Pricing and inventory are operating normally.
      </div>
    </aside>`;
}

function sfBrand() {
  return `
    <div class="sf-brand">
      <div class="sf-brand__name">ShopFlow</div>
      <div class="sf-brand__tag">Simple. Fast. Reliable.</div>
    </div>`;
}

// ------------------------------------------------------------- View: Home
function sfViewHome() {
  return `
    <h1 class="sf-h1">Home</h1>
    <p class="sf-sub">Welcome back to ShopFlow</p>

    <div class="sf-card">
      <h2 class="sf-card__title">Your cart</h2>
      <div class="sf-sum">
        <span>${sfCartCount()} item${sfCartCount() === 1 ? '' : 's'}</span>
        <span class="sf-sum__val">${sfMoney(sfSubtotal())}</span>
      </div>
      <div class="sf-sum sf-sum--total">
        <span>Order total</span>
        <span class="sf-sum__val">${sfMoney(sfTotal())}</span>
      </div>
      <button type="button" class="sf-btn sf-btn--primary sf-btn--block" data-action="nav" data-view="checkout">
        Go to Checkout
      </button>
    </div>

    <div class="sf-card">
      <h2 class="sf-card__title">Featured</h2>
      <div class="sf-grid">
        ${SF_PRODUCTS.map(p => `
          <div class="sf-product">
            <div class="sf-product__icon">${p.icon}</div>
            <div class="sf-product__name">${sfEsc(p.name)}</div>
            <div class="sf-product__price">${sfMoney(p.price)}</div>
            <button type="button" class="sf-btn sf-btn--sm sf-product__btn"
                    data-action="qty" data-id="${p.id}" data-delta="1">Add to cart</button>
          </div>`).join('')}
      </div>
    </div>`;
}

// ---------------------------------------------------------- View: Products
function sfViewProducts() {
  return `
    <h1 class="sf-h1">Products</h1>
    <p class="sf-sub">Everything in the catalogue</p>
    <div class="sf-grid">
      ${SF_PRODUCTS.map(p => `
        <div class="sf-product">
          <div class="sf-product__icon">${p.icon}</div>
          <div class="sf-product__name">${sfEsc(p.name)}</div>
          <div class="sf-product__price">${sfMoney(p.price)}</div>
          <div style="margin-top:8px">${sfQtyControl(p.id, sfState.qty[p.id])}</div>
          <button type="button" class="sf-btn sf-btn--sm sf-product__btn"
                  data-action="qty" data-id="${p.id}" data-delta="1">Add to cart</button>
        </div>`).join('')}
    </div>`;
}

// -------------------------------------------------------------- View: Cart
function sfViewCart() {
  const count = sfCartCount();
  return `
    <h1 class="sf-h1">Cart</h1>
    <p class="sf-sub">Review the items in your cart</p>

    <div class="sf-card">
      <h2 class="sf-card__title">Items</h2>
      ${SF_PRODUCTS.map(p => `
        <div class="sf-line">
          <div class="sf-line__icon">${p.icon}</div>
          <div class="sf-line__main">
            <div class="sf-line__name">${sfEsc(p.name)}</div>
            <div class="sf-line__unit">${sfMoney(p.price)} each</div>
          </div>
          ${sfQtyControl(p.id, sfState.qty[p.id])}
          <div class="sf-line__total">${sfMoney(p.price * sfState.qty[p.id])}</div>
        </div>`).join('')}
    </div>

    <div class="sf-card">
      <h2 class="sf-card__title">Summary</h2>
      <div class="sf-sum"><span>Subtotal</span><span class="sf-sum__val">${sfMoney(sfSubtotal())}</span></div>
      <div class="sf-sum sf-sum--discount">
        <span>Discount</span><span class="sf-sum__val">${sfDiscount() ? '− ' + sfMoney(sfDiscount()) : sfMoney(0)}</span>
      </div>
      <div class="sf-sum sf-sum--total"><span>Total</span><span class="sf-sum__val">${sfMoney(sfTotal())}</span></div>
      <button type="button" class="sf-btn sf-btn--primary sf-btn--block" data-action="nav" data-view="checkout"
              ${count ? '' : 'disabled'}>Proceed to Checkout</button>
    </div>`;
}

// ------------------------------------------------------------ View: Orders
function sfViewOrders() {
  return `
    <h1 class="sf-h1">Orders</h1>
    <p class="sf-sub">Your recent order history</p>
    <div class="sf-card">
      <table class="sf-table">
        <thead>
          <tr><th>Order</th><th>Date</th><th>Items</th><th class="sf-table__right">Total</th><th>Status</th></tr>
        </thead>
        <tbody>
          ${SF_ORDERS.map(o => `
            <tr>
              <td style="font-family:monospace">${sfEsc(o.id)}</td>
              <td style="color:var(--sf-muted)">${sfEsc(o.date)}</td>
              <td>${sfEsc(o.items)}</td>
              <td class="sf-table__right">${sfMoney(o.total)}</td>
              <td><span class="sf-pill">${sfEsc(o.status)}</span></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

// ---------------------------------------------------------- View: Checkout
function sfViewCheckout() {
  const couponApplied = sfState.coupon
    ? `<div class="sf-coupon-msg sf-coupon-msg--ok">
         <span>✓</span><span><b>${sfEsc(sfState.coupon)}</b> applied — ${sfEsc(SF_COUPONS[sfState.coupon].label)}</span>
       </div>`
    : '';
  const couponError = sfState.couponError
    ? `<div class="sf-coupon-msg sf-coupon-msg--error"><span>✕</span><span>${sfEsc(sfState.couponError)}</span></div>`
    : '';

  return `
    <h1 class="sf-h1">Checkout</h1>
    <p class="sf-sub">Review your order and complete payment</p>

    <div class="sf-card">
      <h2 class="sf-card__title">Order Summary</h2>
      ${SF_PRODUCTS.map(p => `
        <div class="sf-line">
          <div class="sf-line__icon">${p.icon}</div>
          <div class="sf-line__main">
            <div class="sf-line__name">${sfEsc(p.name)}</div>
            <div class="sf-line__unit">${sfMoney(p.price)}</div>
          </div>
          ${sfQtyControl(p.id, sfState.qty[p.id])}
          <div class="sf-line__total">${sfMoney(p.price * sfState.qty[p.id])}</div>
        </div>`).join('')}
    </div>

    <div class="sf-card">
      <h2 class="sf-card__title">Coupon</h2>
      <div class="sf-coupon">
        <input class="sf-input" id="sf-coupon" type="text" placeholder="Enter coupon code"
               value="${sfEsc(sfState.couponInput)}" autocomplete="off" spellcheck="false" />
        <button type="button" class="sf-btn" data-action="apply-coupon">Apply</button>
      </div>
      <div class="sf-hint">Try <code>EUR10OFF</code>, <code>EUR50OFF</code> or <code>EUR100OFF</code> — EUR vouchers against an INR cart, the multi-currency path</div>
      ${couponApplied}
      ${couponError}
    </div>

    <div class="sf-card">
      <h2 class="sf-card__title">Summary</h2>
      <div class="sf-sum"><span>Subtotal</span><span class="sf-sum__val">${sfMoney(sfSubtotal())}</span></div>
      <div class="sf-sum sf-sum--discount">
        <span>Discount</span><span class="sf-sum__val">${sfDiscount() ? '− ' + sfMoney(sfDiscount()) : sfMoney(0)}</span>
      </div>
      <div class="sf-sum sf-sum--total"><span>Total</span><span class="sf-sum__val">${sfMoney(sfTotal())}</span></div>
      <button type="button" class="sf-btn sf-btn--primary sf-btn--block" data-action="proceed">
        Proceed to Payment
      </button>
    </div>

    <div class="sf-card" id="sf-payment-card">
      <h2 class="sf-card__title">Payment Details</h2>
      <label class="sf-field">
        <span class="sf-field__label">Card Number</span>
        <input class="sf-input" id="sf-card" type="text" inputmode="numeric" maxlength="19"
               placeholder="4242 4242 4242 4242" value="${sfEsc(sfState.payment.number)}"
               autocomplete="off" spellcheck="false" />
      </label>
      <div class="sf-field-row">
        <label class="sf-field">
          <span class="sf-field__label">Expiry Date</span>
          <input class="sf-input" id="sf-expiry" type="text" inputmode="numeric" maxlength="5"
                 placeholder="MM/YY" value="${sfEsc(sfState.payment.expiry)}"
                 autocomplete="off" spellcheck="false" />
        </label>
        <label class="sf-field">
          <span class="sf-field__label">CVV</span>
          <input class="sf-input" id="sf-cvv" type="password" inputmode="numeric" maxlength="4"
                 placeholder="123" value="${sfEsc(sfState.payment.cvv)}"
                 autocomplete="off" spellcheck="false" />
        </label>
      </div>
      <button type="button" class="sf-btn sf-btn--primary sf-btn--block" data-action="pay">Pay Now</button>
    </div>

    ${sfStatusBanner()}`;
}

/**
 * Update only the status banner, leaving the rest of the DOM (and the caret /
 * focus inside the payment fields) untouched.
 */
function sfUpdateStatusBanner() {
  const root = document.getElementById('mount-shopflow');
  const current = root && root.querySelector('.sf-status');
  if (!current) return;
  current.outerHTML = sfStatusBanner();
}

// ------------------------------------------------------------------ Render
function sfCurrentView() {
  switch (sfState.view) {
    case 'home':     return sfViewHome();
    case 'products': return sfViewProducts();
    case 'cart':     return sfViewCart();
    case 'orders':   return sfViewOrders();
    case 'checkout':
    default:         return sfViewCheckout();
  }
}

function sfRender() {
  const root = document.getElementById('mount-shopflow');
  if (!root) return;

  const meta = VIEW_TITLES[sfState.view] || VIEW_TITLES.checkout;

  root.innerHTML = `
    <div class="sf">
      <div>
        ${sfBrand()}
        ${sfSidebar()}
      </div>
      <main class="sf-main" data-view="${sfState.view}" aria-label="${sfEsc(meta.title)}">
        ${sfCurrentView()}
      </main>
    </div>`;
}

// ----------------------------------------------------------------- Actions
function sfSetQty(id, delta) {
  const next = (sfState.qty[id] || 0) + delta;
  if (next < 1) return;
  if (next > 99) return;
  sfState.qty[id] = next;
  sfState.couponError = '';
  sfSetStatus('ok', 'Payment Ready', 'Cart updated. Totals recalculated.');
}

function sfApplyCoupon() {
  const code = sfState.couponInput.trim().toUpperCase();
  sfState.couponInput = sfState.couponInput.trim();

  if (!code) {
    sfState.coupon = null;
    sfState.couponError = 'Enter a coupon code first.';
    sfSetStatus('error', 'Coupon Missing', 'Enter a coupon code and press Apply.');
    return;
  }

  if (!SF_COUPONS[code]) {
    sfState.coupon = null;
    sfState.couponError = `Unknown coupon code "${code}".`;
    sfSetStatus('error', 'Coupon Not Recognised', 'This coupon code is not valid for this order.');
    return;
  }

  sfState.coupon = code;
  sfState.couponError = '';
  sfSetStatus('ok', 'Payment Ready', `${code} applied — ${SF_COUPONS[code].label}.`);
}

function sfProceedToPayment() {
  sfSetStatus('ok', 'Payment Ready', 'Enter your card details to complete the order.');
  sfRender();
  const card = document.getElementById('sf-payment-card');
  if (card && card.scrollIntoView) {
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  const first = document.getElementById('sf-card');
  if (first) first.focus();
}

async function sfPayNow() {
  if (sfState.submitting) return;   // ignore double-clicks while in flight
  const digits = sfState.payment.number.replace(/\D/g, '');
  const expiry = sfState.payment.expiry.trim();
  const cvv = sfState.payment.cvv.trim();

  if (digits.length !== 16) {
    sfSetStatus('error', 'Card Number Invalid', 'Enter a 16-digit card number.');
    sfUpdateStatusBanner();
    return;
  }
  if (!/^(0[1-9]|1[0-2])\/\d{2}$/.test(expiry)) {
    sfSetStatus('error', 'Expiry Date Invalid', 'Use the MM/YY format, e.g. 04/28.');
    sfUpdateStatusBanner();
    return;
  }
  if (!/^\d{3,4}$/.test(cvv)) {
    sfSetStatus('error', 'CVV Invalid', 'Enter the 3 or 4 digit security code.');
    sfUpdateStatusBanner();
    return;
  }

  sfSetStatus('busy', 'Processing Payment', 'Posting the order to checkout-service…');
  sfUpdateStatusBanner();
  sfState.lastIncidentId = null;

  sfState.submitting = true;
  const payload = sfBuildCheckoutPayload();
  let response;
  let data;

  try {
    // Same-origin proxy -> demo_service. Raw card details are never sent;
    // the demo payment service only receives paymentMethod.
    response = await fetch('/api/shopflow/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    data = await response.json().catch(() => null);
  } catch (_) {
    sfState.submitting = false;
    sfSetStatus('error', 'Payment Failed',
      'Could not reach the dashboard server. Is dashboard/server.js still running?');
    sfUpdateStatusBanner();
    return;
  }

  sfState.submitting = false;

  if (response.ok && data && data.success) {
    // Real identifiers straight from the demo service response.
    const orderId = data.orderId || payload.orderId;
    const txn = data.payment && data.payment.transactionId;
    const charged = data.cart && typeof data.cart.grandTotal === 'number'
      ? data.cart.grandTotal
      : sfTotal();
    sfSetStatus('ok', 'Payment Successful',
      `Order ${orderId} confirmed · charged ${sfMoney(charged)}` +
      (txn ? ` · ${txn}` : '') + '.');
    sfUpdateStatusBanner();
    return;
  }

  // Real failure: show the actual error text returned by the backend.
  const detail = (data && (data.message || data.error)) || `Checkout returned HTTP ${response.status}.`;
  const incidentId = data && data._proxy && data._proxy.incidentCaptured;
  sfState.lastIncidentId = incidentId || null;
  sfSetStatus('error', 'Payment Failed',
    detail + (incidentId ? ` (incident ${incidentId})` : ''));
  sfUpdateStatusBanner();
}

// ------------------------------------------------------------------- Wiring
function sfBind(root) {
  // Delegated clicks — survives full re-renders.
  root.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el) return;

    const action = el.dataset.action;

    if (action === 'nav') {
      sfState.view = el.dataset.view;
      sfRender();
      return;
    }

    if (action === 'qty') {
      const id = el.dataset.id;
      const delta = Number(el.dataset.delta);
      sfSetQty(id, delta);
      sfRender();

      // Keep the +/- button focused so it can be clicked repeatedly.
      const again = root.querySelector(
        `[data-action="qty"][data-id="${id}"][data-delta="${delta}"]:not(:disabled)`
      );
      if (again) again.focus();
      return;
    }

    if (action === 'apply-coupon') { sfApplyCoupon(); sfRender(); return; }
    if (action === 'proceed')      { sfProceedToPayment(); return; }
    if (action === 'pay')          { sfPayNow().catch(() => {}); return; }
  });

  // Text fields: update state WITHOUT re-rendering so the caret is preserved.
  root.addEventListener('input', e => {
    const id = e.target.id;

    if (id === 'sf-coupon') {
      sfState.couponInput = e.target.value;
      return;
    }

    if (id === 'sf-card') {
      const digits = e.target.value.replace(/\D/g, '').slice(0, 16);
      sfState.payment.number = digits.replace(/(.{4})/g, '$1 ').trim();
      e.target.value = sfState.payment.number;
      return;
    }

    if (id === 'sf-expiry') {
      let digits = e.target.value.replace(/\D/g, '').slice(0, 4);
      if (digits.length >= 3) digits = digits.slice(0, 2) + '/' + digits.slice(2);
      else if (digits.length === 2) digits = digits + '/';
      sfState.payment.expiry = digits;
      e.target.value = digits;
      return;
    }

    if (id === 'sf-cvv') {
      sfState.payment.cvv = e.target.value.replace(/\D/g, '').slice(0, 4);
      e.target.value = sfState.payment.cvv;
    }
  });

  // Enter inside the coupon field applies it.
  root.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.id === 'sf-coupon') {
      e.preventDefault();
      sfApplyCoupon();
      sfRender();
      document.getElementById('sf-coupon')?.focus();
    }
  });
}

// ------------------------------------------------------------------ Mount
function sfMount() {
  const root = document.getElementById('mount-shopflow');
  if (!root || root.dataset.sfBound === '1') return;
  root.dataset.sfBound = '1';
  sfBind(root);
  sfRender();
}

document.addEventListener('DOMContentLoaded', sfMount);

window.__ShopFlow = {
  render: sfRender,
  mount: sfMount,
  state: sfState,
  checkoutPayload: sfBuildCheckoutPayload,
};
