/**
 * Regression test: multi-currency voucher discount precision failure
 *
 * Incident ID  : REGEN-INCIDENT-001
 * Root cause   : demo_service/src/services/cart.ts → convertVoucherDiscount()
 * Lines        : 0–0
 * Blast radius : 0.49
 *
 * Bug description
 * ---------------
 * convertVoucherDiscount() uses Math.trunc() when converting a voucher amount
 * from a foreign currency to the cart currency. For exchange-rate values that
 * produce a fractional result (e.g. 10 EUR × 1.08 = 10.8 USD), Math.trunc()
 * silently drops the 0.8, returning 10 instead of the correct 11. The
 * under-applied discount inflates the grandTotal, which is then rejected by
 * the payment gateway with a PAYMENT_MISMATCH_ERROR / 500 response.
 *
 * Reproduction scenario
 * ---------------------
 * Incident reproducer for: demo_service/src/services/cart.ts → convertVoucherDiscount()
 * Bug: Math.trunc() in convertVoucherDiscount() truncates the EUR→USD exchange conversion of a voucher discount instead of rounding, producing a discount that is 1 USD too small.
 * Trigger: apply a 10 EUR voucher to a USD cart; expect 11 USD discount, receive 10 USD.
 *
 * This test FAILS on the unfixed code and PASSES after Treatment patches
 * Math.trunc → Math.round in convertVoucherDiscount().
 */

import {
  convertVoucherDiscount,
  applyVoucherAndCalculateTotals,
  EXCHANGE_RATES,
  CartItem,
  VoucherCode,
} from '../../src/services/cart';

// ---------------------------------------------------------------------------
// Regression test 1: direct unit-level reproduction of the precision bug
// ---------------------------------------------------------------------------
describe('REGRESSION: convertVoucherDiscount — EUR→USD truncation bug', () => {
  const VOUCHER_AMOUNT_EUR = 10;
  const EXPECTED_USD       = Math.round(VOUCHER_AMOUNT_EUR * EXCHANGE_RATES['EUR']); // 11

  it('should return the ROUNDED conversion (11 USD) not the TRUNCATED value (10 USD)', () => {
    const result = convertVoucherDiscount(VOUCHER_AMOUNT_EUR, 'EUR', 'USD');

    // This assertion FAILS on the buggy code because Math.trunc(10.8) = 10, not 11.
    // After the fix (Math.round), this assertion PASSES.
    expect(result).toBe(EXPECTED_USD);
  });

  it('documents the exact bug: Math.trunc(10.8) returns 10 instead of 11', () => {
    // Confirm that Math.trunc exhibits the under-application behaviour
    const rawConversion = VOUCHER_AMOUNT_EUR * EXCHANGE_RATES['EUR']; // 10.8
    expect(Math.trunc(rawConversion)).toBe(10);  // the bug
    expect(Math.round(rawConversion)).toBe(11);  // the fix
  });
});

// ---------------------------------------------------------------------------
// Regression test 2: end-to-end cart totals diverge when EUR voucher is applied
// ---------------------------------------------------------------------------
describe('REGRESSION: applyVoucherAndCalculateTotals — grandTotal inflated by EUR voucher bug', () => {
  const items: CartItem[] = [
    { id: 'P1', name: 'Widget', quantity: 2, unitPrice: 50, currency: 'USD' }, // 100 USD
    { id: 'P2', name: 'Gadget', quantity: 1, unitPrice: 30, currency: 'USD' }, // 30 USD
    // subtotal = 130 USD
  ];

  const voucher: VoucherCode = {
    code: 'EUR10OFF',
    discountAmount: 10,      // 10 EUR
    voucherCurrency: 'EUR',
  };

  it('should apply an 11 USD discount (rounded) not 10 USD (truncated)', () => {
    const totals = applyVoucherAndCalculateTotals(items, voucher, 'USD');

    // With the BUG:   discountApplied = 10, taxBase = 120, tax = 12.00, grandTotal = 132.00
    // With the FIX:   discountApplied = 11, taxBase = 119, tax = 11.90, grandTotal = 130.90

    // This assertion FAILS on the buggy code (result is 10) and PASSES after the fix (result is 11).
    expect(totals.discountApplied).toBe(11);
  });

  it('should produce a grandTotal of 130.90 USD not the inflated 132.00 USD', () => {
    const totals = applyVoucherAndCalculateTotals(items, voucher, 'USD');

    // grandTotal with correct 11 USD discount: (130 - 11) + (130 - 11) * 0.10
    //   = 119 + 11.90 = 130.90
    expect(totals.grandTotal).toBeCloseTo(130.9, 2);
  });
});

// ---------------------------------------------------------------------------
// Regression test 3: same-currency vouchers are unaffected (guard rail)
// ---------------------------------------------------------------------------
describe('GUARD: same-currency vouchers remain correct', () => {
  const items: CartItem[] = [
    { id: 'P1', name: 'Widget', quantity: 1, unitPrice: 100, currency: 'USD' },
  ];

  it('USD voucher on USD cart applies the full discount without truncation', () => {
    const totals = applyVoucherAndCalculateTotals(
      items,
      { code: 'USD10', discountAmount: 10, voucherCurrency: 'USD' },
      'USD'
    );
    expect(totals.discountApplied).toBe(10);
    expect(totals.grandTotal).toBeCloseTo(99, 2); // (100-10) * 1.10 = 99
  });
});
