import { applyVoucherAndCalculateTotals, CartItem, VoucherCode } from '../../src/services/cart';

describe('Cart Calculation Service - Baseline Unit Tests', () => {
  it('should return zeros for an empty cart', () => {
    const result = applyVoucherAndCalculateTotals([], null, 'USD');

    expect(result.subtotal).toBe(0);
    expect(result.discountApplied).toBe(0);
    expect(result.tax).toBe(0);
    expect(result.grandTotal).toBe(0);
  });

  it('should calculate correct subtotal and total for a single item without discount or tax', () => {
    const items: CartItem[] = [
      { id: 'item_1', name: 'Product A', unitPrice: 29.99, quantity: 2, currency: 'USD' },
    ];

    const result = applyVoucherAndCalculateTotals(items, null, 'USD', 0);

    expect(result.subtotal).toBe(59.98);
    expect(result.discountApplied).toBe(0);
    expect(result.tax).toBe(0);
    expect(result.grandTotal).toBe(59.98);
  });

  it('should calculate multiple items with discount correctly', () => {
    const items: CartItem[] = [
      { id: 'item_1', name: 'T-Shirt', unitPrice: 20.00, quantity: 2, currency: 'USD' }, // 40
      { id: 'item_2', name: 'Jeans', unitPrice: 60.00, quantity: 1, currency: 'USD' },   // 60
    ]; // subtotal = 100

    const voucher: VoucherCode = { code: '15OFF', discountAmount: 15, voucherCurrency: 'USD' };
    const result = applyVoucherAndCalculateTotals(items, voucher, 'USD', 0);

    expect(result.subtotal).toBe(100.00);
    expect(result.discountApplied).toBe(15.00);
    expect(result.grandTotal).toBe(85.00);
  });

  it('should apply tax to the discounted subtotal correctly', () => {
    const items: CartItem[] = [
      { id: 'item_1', name: 'Electronics', unitPrice: 100.00, quantity: 1, currency: 'USD' },
    ];

    // 20 discount on $100 = $80 taxable, 10% tax on $80 = $8 tax, total = $88
    const voucher: VoucherCode = { code: '20OFF', discountAmount: 20, voucherCurrency: 'USD' };
    const result = applyVoucherAndCalculateTotals(items, voucher, 'USD', 0.10);

    expect(result.subtotal).toBe(100.00);
    expect(result.discountApplied).toBe(20.00);
    expect(result.tax).toBe(8.00);
    expect(result.grandTotal).toBe(88.00);
  });
});
