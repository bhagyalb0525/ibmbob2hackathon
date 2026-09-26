import { Router, Request, Response } from 'express';
import { applyVoucherAndCalculateTotals, CartItem, VoucherCode } from '../services/cart';
import { processPayment } from '../services/payment';
import { logger } from '../utils/logger';

export const checkoutRouter = Router();

interface CheckoutRequestBody {
  orderId?: string;
  items?: CartItem[];
  currency?: string;
  voucher?: VoucherCode | null;
  taxRate?: number;
  paymentMethod?: string;
  expectedTotal?: number;
}

/**
 * POST /api/checkout
 * Validates cart contents, calculates totals, and charges payment.
 */
checkoutRouter.post('/', async (req: Request<Record<string, never>, unknown, CheckoutRequestBody>, res: Response): Promise<void> => {
  const { orderId, items, currency = 'USD', voucher = null, taxRate = 0, paymentMethod, expectedTotal } = req.body;
  const currentOrderId = orderId || `ord_${Date.now()}`;

  logger.info('Checkout request received', { orderId: currentOrderId, itemsCount: items?.length });

  // 1. Validation
  if (!items || !Array.isArray(items) || items.length === 0) {
    logger.warn('Checkout validation failed: Empty or invalid cart items', { orderId: currentOrderId });
    res.status(400).json({
      success: false,
      error: 'Invalid cart: At least one item is required for checkout',
      orderId: currentOrderId,
    });
    return;
  }

  try {
    // 2. Cart calculation
    const cartSummary = applyVoucherAndCalculateTotals(items, voucher, currency, taxRate);

    // 3. Precision truncation verification (simulating payment gateway pre-auth mismatch)
    if (expectedTotal !== undefined && Math.abs(cartSummary.grandTotal - expectedTotal) >= 0.01) {
      throw new Error(`PAYMENT_MISMATCH_ERROR: Expected total ${expectedTotal} but calculated ${cartSummary.grandTotal}`);
    }

    // 4. Payment execution
    const paymentResult = await processPayment({
      orderId: currentOrderId,
      amount: cartSummary.grandTotal,
      currency: currency,
      paymentMethod,
    });

    if (!paymentResult.success) {
      logger.warn('Payment failed during checkout', {
        orderId: currentOrderId,
        status: paymentResult.status,
        reason: paymentResult.errorMessage,
      });

      res.status(402).json({
        success: false,
        error: paymentResult.errorMessage || 'Payment transaction failed',
        orderId: currentOrderId,
        cart: cartSummary,
        payment: paymentResult,
      });
      return;
    }

    logger.info('Checkout succeeded', {
      orderId: currentOrderId,
      transactionId: paymentResult.transactionId,
      totalAmount: cartSummary.grandTotal,
    });

    res.status(200).json({
      success: true,
      orderId: currentOrderId,
      cart: cartSummary,
      payment: paymentResult,
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Unhandled exception during checkout', { orderId: currentOrderId }, err);

    res.status(500).json({
      success: false,
      error: 'Internal server error processing checkout',
      orderId: currentOrderId,
      message: err.message,
    });
  }
});
