/**
 * Baseline Cart Calculation Service
 */

export interface CartItem {
  id: string;
  name: string;
  unitPrice: number;
  quantity: number;
  currency: string;
}

export interface VoucherCode {
  code: string;
  discountAmount: number;
  voucherCurrency: string;
}

export const EXCHANGE_RATES: Record<string, number> = {
  'EUR': 1.08,
  'GBP': 1.25,
  'JPY': 0.0067,
  'USD': 1.0
};

export function convertVoucherDiscount(amount: number, fromCurrency: string, toCurrency: string): number {
  if (fromCurrency === toCurrency) return amount;
  
  const fromRate = EXCHANGE_RATES[fromCurrency] || 1;
  const toRate = EXCHANGE_RATES[toCurrency] || 1;
  
  // Convert to USD first, then to target currency
  const amountInUsd = amount * fromRate;
  const amountInTarget = amountInUsd / toRate;
  
  // BUG: uses Math.trunc instead of Math.round, causing precision loss
  return Math.round(amountInTarget);
}

export function applyVoucherAndCalculateTotals(
  items: CartItem[],
  voucher: VoucherCode | null,
  cartCurrency: string,
  taxRate: number = 0.10
) {
  let subtotal = 0;
  for (const item of items) {
    subtotal += item.unitPrice * item.quantity;
  }

  let discountApplied = 0;
  if (voucher) {
    discountApplied = convertVoucherDiscount(voucher.discountAmount, voucher.voucherCurrency, cartCurrency);
    discountApplied = Math.min(discountApplied, subtotal);
  }

  const taxBase = Math.max(0, subtotal - discountApplied);
  const tax = Number((taxBase * taxRate).toFixed(2));
  const grandTotal = Number((taxBase + tax).toFixed(2));

  return {
    subtotal,
    discountApplied,
    taxBase,
    tax,
    grandTotal
  };
}
