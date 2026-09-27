import { calculateCart, CartItem } from '../../src/services/cart';

describe('Cart Calculation Service - Baseline Unit Tests', () => {
  it('should return zeros for an empty cart', () => {
    const result = calculateCart([]);

    expect(result.itemsCount).toBe(0);
    expect(result.subtotal).toBe(0);
    expect(result.discountAmount).toBe(0);
    expect(result.taxAmount).toBe(0);
    expect(result.totalAmount).toBe(0);
    expect(result.currency).toBe('USD');
  });

  it('should calculate correct subtotal and total for a single item without discount or tax', () => {
    const items: CartItem[] = [
      { id: 'item_1', name: 'Product A', price: 29.99, quantity: 2 },
    ];

    const result = calculateCart(items);

    expect(result.itemsCount).toBe(2);
    expect(result.subtotal).toBe(59.98);
    expect(result.discountAmount).toBe(0);
    expect(result.taxAmount).toBe(0);
    expect(result.totalAmount).toBe(59.98);
  });

  it('should calculate multiple items with percentage discount correctly', () => {
    const items: CartItem[] = [
      { id: 'item_1', name: 'T-Shirt', price: 20.00, quantity: 2 }, // 40
      { id: 'item_2', name: 'Jeans', price: 60.00, quantity: 1 },   // 60
    ]; // subtotal = 100

    const result = calculateCart(items, { discountPercent: 15 });

    expect(result.itemsCount).toBe(3);
    expect(result.subtotal).toBe(100.00);
    expect(result.discountAmount).toBe(15.00);
    expect(result.totalAmount).toBe(85.00);
  });

  it('should apply tax to the discounted subtotal correctly', () => {
    const items: CartItem[] = [
      { id: 'item_1', name: 'Electronics', price: 100.00, quantity: 1 },
    ];

    // 20% discount on $100 = $80 taxable, 10% tax on $80 = $8 tax, total = $88
    const result = calculateCart(items, { discountPercent: 20, taxRate: 0.10 });

    expect(result.subtotal).toBe(100.00);
    expect(result.discountAmount).toBe(20.00);
    expect(result.taxAmount).toBe(8.00);
    expect(result.totalAmount).toBe(88.00);
  });

  it('should handle edge cases: zero or negative quantities safely', () => {
    const items: CartItem[] = [
      { id: 'item_1', name: 'Corrupted Item', price: 50.00, quantity: -2 },
      { id: 'item_2', name: 'Zero Item', price: 10.00, quantity: 0 },
      { id: 'item_3', name: 'Valid Item', price: 25.00, quantity: 2 },
    ];

    const result = calculateCart(items);

    expect(result.itemsCount).toBe(2);
    expect(result.subtotal).toBe(50.00);
    expect(result.totalAmount).toBe(50.00);
  });

  it('should handle 100% discount without negative values', () => {
    const items: CartItem[] = [
      { id: 'item_1', name: 'Gift Card', price: 50.00, quantity: 1 },
    ];

    const result = calculateCart(items, { discountPercent: 100, taxRate: 0.08 });

    expect(result.subtotal).toBe(50.00);
    expect(result.discountAmount).toBe(50.00);
    expect(result.taxAmount).toBe(0.00);
    expect(result.totalAmount).toBe(0.00);
  });

  it('should handle decimal precision rounding cleanly', () => {
    const items: CartItem[] = [
      { id: 'item_1', name: 'Item with fractional cents', price: 10.333, quantity: 3 },
    ];

    const result = calculateCart(items, { discountPercent: 10, taxRate: 0.05 });

    // Subtotal: 30.999 -> 31.00
    // Discount 10%: 3.10
    // Discounted: 27.90
    // Tax 5%: 1.40
    // Total: 29.30
    expect(result.subtotal).toBe(31.00);
    expect(result.discountAmount).toBe(3.10);
    expect(result.taxAmount).toBe(1.40);
    expect(result.totalAmount).toBe(29.30);
  });
});
