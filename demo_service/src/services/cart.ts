/**
 * Baseline Cart Calculation Service
 * Computes item subtotals, promotional discounts, and localized tax totals.
 */

export interface CartItem {
  id: string;
  name: string;
  price: number;
  quantity: number;
}

export interface CartOptions {
  discountPercent?: number; // 0 to 100
  taxRate?: number;         // Decimal rate, e.g. 0.08 for 8%
  currency?: string;
}

export interface CartCalculationResult {
  itemsCount: number;
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  totalAmount: number;
  currency: string;
}

/**
 * Calculates cart totals in a baseline, deterministic manner.
 * 
 * @param items List of items in the cart
 * @param options Calculation options such as discount percentage and tax rate
 * @returns Standardized calculation summary
 */
export function calculateCart(
  items: CartItem[],
  options: CartOptions = {}
): CartCalculationResult {
  const currency = options.currency || 'USD';
  const discountPercent = Math.max(0, Math.min(100, options.discountPercent ?? 0));
  const taxRate = Math.max(0, options.taxRate ?? 0);

  if (!Array.isArray(items) || items.length === 0) {
    return {
      itemsCount: 0,
      subtotal: 0,
      discountAmount: 0,
      taxAmount: 0,
      totalAmount: 0,
      currency,
    };
  }

  let subtotal = 0;
  let itemsCount = 0;

  for (const item of items) {
    const quantity = Math.max(0, item.quantity || 0);
    const price = Math.max(0, item.price || 0);

    itemsCount += quantity;
    subtotal += price * quantity;
  }

  // Standardize subtotal to currency precision before discounts/taxes
  const roundedSubtotal = Number(subtotal.toFixed(2));
  const discountAmount = Number(((roundedSubtotal * discountPercent) / 100).toFixed(2));
  const discountedSubtotal = Math.max(0, roundedSubtotal - discountAmount);
  const taxAmount = Number((discountedSubtotal * taxRate).toFixed(2));
  const totalAmount = Number((discountedSubtotal + taxAmount).toFixed(2));

  return {
    itemsCount,
    subtotal: roundedSubtotal,
    discountAmount,
    taxAmount,
    totalAmount,
    currency,
  };
}
