/**
 * Mock Payment Service
 * Provides deterministic payment processing responses for the checkout pipeline.
 */

export interface PaymentRequest {
  orderId: string;
  amount: number;
  currency: string;
  paymentMethod?: string;
}

export interface PaymentResult {
  success: boolean;
  transactionId?: string;
  amount: number;
  currency: string;
  status: 'SETTLED' | 'REJECTED' | 'INVALID_AMOUNT';
  processedAt: string;
  errorMessage?: string;
}

/**
 * Deterministically processes payment simulation based on input request.
 * - Negative or zero amounts are rejected.
 * - paymentMethod === 'FAIL' triggers a deterministic failure simulation.
 * - Valid requests return a successful settlement with a mock transaction ID.
 */
export async function processPayment(request: PaymentRequest): Promise<PaymentResult> {
  const processedAt = new Date().toISOString();

  if (request.amount <= 0) {
    return {
      success: false,
      amount: request.amount,
      currency: request.currency || 'USD',
      status: 'INVALID_AMOUNT',
      processedAt,
      errorMessage: 'Payment amount must be greater than zero',
    };
  }

  if (request.paymentMethod === 'SIMULATED_FAILURE' || request.paymentMethod === 'FAIL') {
    return {
      success: false,
      amount: request.amount,
      currency: request.currency || 'USD',
      status: 'REJECTED',
      processedAt,
      errorMessage: 'Payment gateway rejected transaction (simulated card failure)',
    };
  }

  return {
    success: true,
    transactionId: `txn_mock_${request.orderId}_${Date.now()}`,
    amount: request.amount,
    currency: request.currency || 'USD',
    status: 'SETTLED',
    processedAt,
  };
}
