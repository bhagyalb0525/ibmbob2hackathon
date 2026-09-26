#!/usr/bin/env bash
# =============================================================================
# seed_incident.sh — Deterministic incident seeder for the checkout service
#
# BUG TRIGGER (cart.ts convertVoucherDiscount)
# ------------------------------
# convertVoucherDiscount uses Math.trunc() instead of Math.round() when
# converting exchange rates, causing the discount applied to be slightly lower
# than expected. The frontend calculates the correct expectedTotal using proper
# rounding, but the backend calculates an inflated total.
# This causes the checkout route to throw a PAYMENT_MISMATCH_ERROR (HTTP 500).
#
# EXPECTED RESULTS
#   Requests 1–8   NORMAL   Same currency vouchers      → HTTP 200
#   Requests 9–10  INCIDENT Multi-currency voucher      → HTTP 500
# =============================================================================

BASE_URL="${CHECKOUT_URL:-http://127.0.0.1:3001/api/checkout}"
SEP="----------------------------------------------------------------------"

echo ""
echo "================================================================"
echo " Checkout Service — Multi-Currency Voucher Incident Seeder"
echo " Target : $BASE_URL"
echo "================================================================"
echo ""

fire() {
  local label="$1"
  local payload="$2"
  echo "$SEP"
  echo "REQUEST $label"
  echo "Payload : $payload"
  http_code=$(curl -s -o ./_seed_body.json -w "%{http_code}" \
    -X POST "$BASE_URL" \
    -H "Content-Type: application/json" \
    -d "$payload")
  body=$(cat ./_seed_body.json)
  echo "HTTP    : $http_code"
  echo "Body    : $body"
  echo ""
}

# ===========================================================================
# Requests 1–8  NORMAL — Same currency vouchers or no voucher
# ===========================================================================

# 1: 2x 9.99 = 19.98. No voucher. Tax 0. expectedTotal = 19.98
fire "1/10 [NORMAL USD — no voucher]" \
  '{"orderId":"ord-seed-001","items":[{"id":"sku-A","name":"USB Cable","unitPrice":9.99,"quantity":2,"currency":"USD"}],"currency":"USD","taxRate":0,"expectedTotal":19.98}'

# 2: 1x 49.99, 1x 29.99 = 79.98. USD10OFF -> 10 USD discount. Base = 69.98. Tax 8% = 5.60. Total = 75.58.
fire "2/10 [NORMAL USD — 10 USD voucher, 8% tax]" \
  '{"orderId":"ord-seed-002","items":[{"id":"sku-B","name":"Keyboard","unitPrice":49.99,"quantity":1,"currency":"USD"},{"id":"sku-C","name":"Mouse","unitPrice":29.99,"quantity":1,"currency":"USD"}],"currency":"USD","voucher":{"code":"USD10OFF","discountAmount":10,"voucherCurrency":"USD"},"taxRate":0.08,"expectedTotal":75.58}'

# 3: 1x 24.99 = 24.99 EUR. EUR5OFF -> 5 EUR discount. Base = 19.99. Tax 5% = 1.00. Total = 20.99
fire "3/10 [NORMAL EUR — 5 EUR voucher, 5% tax]" \
  '{"orderId":"ord-seed-003","items":[{"id":"sku-D","name":"Book","unitPrice":24.99,"quantity":1,"currency":"EUR"}],"currency":"EUR","voucher":{"code":"EUR5OFF","discountAmount":5,"voucherCurrency":"EUR"},"taxRate":0.05,"expectedTotal":20.99}'

# 4: 1x 89.99 = 89.99 GBP. GBP20OFF -> 20 GBP. Base = 69.99. Tax 0. Total = 69.99
fire "4/10 [NORMAL GBP — 20 GBP voucher, no tax]" \
  '{"orderId":"ord-seed-004","items":[{"id":"sku-E","name":"Jacket","unitPrice":89.99,"quantity":1,"currency":"GBP"}],"currency":"GBP","voucher":{"code":"GBP20OFF","discountAmount":20,"voucherCurrency":"GBP"},"taxRate":0,"expectedTotal":69.99}'

# 5: 1x 299.99 = 299.99 USD. Tax 7% = 21.00. Total = 320.99
fire "5/10 [NORMAL USD — no discount, 7% tax]" \
  '{"orderId":"ord-seed-005","items":[{"id":"sku-F","name":"Monitor","unitPrice":299.99,"quantity":1,"currency":"USD"}],"currency":"USD","taxRate":0.07,"expectedTotal":320.99}'

fire "6/10 [NORMAL USD — no voucher]" \
  '{"orderId":"ord-seed-006","items":[{"id":"sku-A","name":"USB Cable","unitPrice":9.99,"quantity":1,"currency":"USD"}],"currency":"USD","taxRate":0,"expectedTotal":9.99}'

fire "7/10 [NORMAL USD — no voucher]" \
  '{"orderId":"ord-seed-007","items":[{"id":"sku-A","name":"USB Cable","unitPrice":9.99,"quantity":1,"currency":"USD"}],"currency":"USD","taxRate":0,"expectedTotal":9.99}'

fire "8/10 [NORMAL USD — no voucher]" \
  '{"orderId":"ord-seed-008","items":[{"id":"sku-A","name":"USB Cable","unitPrice":9.99,"quantity":1,"currency":"USD"}],"currency":"USD","taxRate":0,"expectedTotal":9.99}'

# ===========================================================================
# Requests 9–10  INCIDENT — Math.trunc precision error
# EUR to USD conversion rate is 1.08. 
# 10 EUR * 1.08 = 10.8 USD. 
# Expected correctly rounded: 11 USD discount.
# Bug (Math.trunc): 10 USD discount.
# Subtotal: 100 USD.
# Expected Tax Base: 100 - 11 = 89. Tax (10%): 8.90. Total: 97.90
# Buggy Tax Base: 100 - 10 = 90. Tax (10%): 9.00. Total: 99.00 (mismatch!)
# ===========================================================================

fire "9/10 [INCIDENT 10 EUR voucher on USD cart — EXPECT HTTP 500]" \
  '{"orderId":"ord-seed-009","items":[{"id":"sku-X","name":"Widget","unitPrice":50.00,"quantity":2,"currency":"USD"}],"currency":"USD","voucher":{"code":"EUR10OFF","discountAmount":10,"voucherCurrency":"EUR"},"taxRate":0.10,"expectedTotal":97.90}'

fire "10/10 [INCIDENT 10 EUR voucher on USD cart — EXPECT HTTP 500]" \
  '{"orderId":"ord-seed-010","items":[{"id":"sku-Y","name":"Widget Pro","unitPrice":100.00,"quantity":1,"currency":"USD"}],"currency":"USD","voucher":{"code":"EUR10OFF","discountAmount":10,"voucherCurrency":"EUR"},"taxRate":0.10,"expectedTotal":97.90}'
# Wait, for request 10: 
# Subtotal: 100.
# Voucher: 10 EUR = 10.8 USD -> rounded = 11 USD.
# Base = 89. Tax (10%) = 8.90. Expected Total = 97.90. 
# Let me fix expectedTotal in payload 10.
# Ah, I'll just change the payload 10 to match 97.90 exactly.

echo "$SEP"
echo "Seed complete."
