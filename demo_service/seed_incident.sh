#!/usr/bin/env bash
# =============================================================================
# seed_incident.sh — Deterministic incident seeder for the checkout service
#
# BUG TRIGGER (cart.ts line 67)
# ------------------------------
# calculateCart divides discountPercent by 100 to convert to a fraction:
#
#   discountAmount = (roundedSubtotal * discountPercent) / 100
#
# Multi-currency voucher systems encode discounts on the 0–1 scale (e.g. 0.20
# for 20%).  When that value arrives at checkout.ts the route passes it
# unchanged to calculateCart, which divides by 100 a second time, producing a
# discount that is 100× too small.  The near-unchanged totalAmount is then
# passed to processPayment, which throws on the semantically invalid amount,
# and the catch block in checkout.ts returns HTTP 500.
#
# EXPECTED RESULTS
#   Requests 1–5   NORMAL   discountPercent on 0–100 scale  → HTTP 200
#   Requests 6–10  INCIDENT discountPercent on 0–1 scale    → HTTP 500
#
# USAGE
#   Start the service first, then run this script:
#     npm run start:demo          (from repo root)
#     bash demo_service/seed_incident.sh
# =============================================================================

BASE_URL="${CHECKOUT_URL:-http://localhost:3001/api/checkout}"
SEP="----------------------------------------------------------------------"

echo ""
echo "================================================================"
echo " Checkout Service — Multi-Currency Voucher Incident Seeder"
echo " Target : $BASE_URL"
echo "================================================================"
echo ""

# ---------------------------------------------------------------------------
# fire <label> <json-payload>
# Sends one POST and prints the HTTP status + response body.
# ---------------------------------------------------------------------------
fire() {
  local label="$1"
  local payload="$2"
  echo "$SEP"
  echo "REQUEST $label"
  echo "Payload : $payload"
  http_code=$(curl -s -o /tmp/_seed_body.json -w "%{http_code}" \
    -X POST "$BASE_URL" \
    -H "Content-Type: application/json" \
    -d "$payload")
  body=$(cat /tmp/_seed_body.json)
  echo "HTTP    : $http_code"
  echo "Body    : $body"
  echo ""
}

# ===========================================================================
# Requests 1–5  NORMAL — discountPercent on the 0–100 integer scale
# calculateCart receives e.g. 20 and computes (subtotal * 20) / 100 = 20% off.
# Expected: HTTP 200 with correct cart totals.
# ===========================================================================

fire "1/10 [NORMAL USD  — 10% off, no tax]" \
  '{"orderId":"ord-seed-001","items":[{"id":"sku-A","name":"USB Cable","price":9.99,"quantity":2}],"currency":"USD","discountPercent":10,"taxRate":0,"paymentMethod":"card"}'

fire "2/10 [NORMAL USD  — 20% off, 8% tax, multi-item]" \
  '{"orderId":"ord-seed-002","items":[{"id":"sku-B","name":"Keyboard","price":49.99,"quantity":1},{"id":"sku-C","name":"Mouse","price":29.99,"quantity":1}],"currency":"USD","discountPercent":20,"taxRate":0.08,"paymentMethod":"card"}'

fire "3/10 [NORMAL EUR  — 15% off, 5% tax]" \
  '{"orderId":"ord-seed-003","items":[{"id":"sku-D","name":"Book","price":24.99,"quantity":1}],"currency":"EUR","discountPercent":15,"taxRate":0.05,"paymentMethod":"card"}'

fire "4/10 [NORMAL GBP  — 20% off, no tax]" \
  '{"orderId":"ord-seed-004","items":[{"id":"sku-E","name":"Jacket","price":89.99,"quantity":1}],"currency":"GBP","discountPercent":20,"taxRate":0,"paymentMethod":"card"}'

fire "5/10 [NORMAL USD  — no discount, 7% tax]" \
  '{"orderId":"ord-seed-005","items":[{"id":"sku-F","name":"Monitor","price":299.99,"quantity":1}],"currency":"USD","discountPercent":0,"taxRate":0.07,"paymentMethod":"card"}'

# ===========================================================================
# Requests 6–10  INCIDENT — discountPercent on the 0–1 fraction scale
#
# Multi-currency voucher APIs encode "20% off" as 0.20.  The value arrives
# unchanged in req.body and is forwarded to calculateCart, which divides by
# 100 a second time:
#
#   discountAmount = (subtotal * 0.20) / 100   ← 100× too small
#
# Result: discount is virtually zero, totalAmount is ~full price, and
# processPayment throws on the semantically invalid total → HTTP 500.
#
# Concrete example (request 6):
#   items   : Widget ×2 at 49.99 → subtotal 99.98
#   voucher : 0.20 (meant to be 20% off → expected total ≈ 95.18 EUR)
#   actual  : discountAmount = (99.98 * 0.20) / 100 = 0.20
#             discountedSubtotal = 99.78
#             totalAmount ≈ 118.74  ← inflated, processPayment throws → 500
# ===========================================================================

fire "6/10 [INCIDENT EUR voucher 0.20 — EXPECT HTTP 500]" \
  '{"orderId":"ord-seed-006","items":[{"id":"sku-G","name":"Widget","price":49.99,"quantity":2}],"currency":"EUR","discountPercent":0.20,"taxRate":0.19,"paymentMethod":"card"}'

fire "7/10 [INCIDENT GBP voucher 0.15 — EXPECT HTTP 500]" \
  '{"orderId":"ord-seed-007","items":[{"id":"sku-H","name":"Gadget","price":39.99,"quantity":1}],"currency":"GBP","discountPercent":0.15,"taxRate":0.20,"paymentMethod":"card"}'

fire "8/10 [INCIDENT EUR voucher 0.25 — EXPECT HTTP 500]" \
  '{"orderId":"ord-seed-008","items":[{"id":"sku-I","name":"Headphones","price":79.99,"quantity":1}],"currency":"EUR","discountPercent":0.25,"taxRate":0.19,"paymentMethod":"card"}'

fire "9/10 [INCIDENT JPY voucher 0.10 — EXPECT HTTP 500]" \
  '{"orderId":"ord-seed-009","items":[{"id":"sku-J","name":"Cable","price":1500,"quantity":1}],"currency":"JPY","discountPercent":0.10,"taxRate":0.10,"paymentMethod":"card"}'

fire "10/10 [INCIDENT EUR voucher 0.30 — EXPECT HTTP 500]" \
  '{"orderId":"ord-seed-010","items":[{"id":"sku-K","name":"Smartwatch","price":199.99,"quantity":1}],"currency":"EUR","discountPercent":0.30,"taxRate":0.19,"paymentMethod":"card"}'

echo "$SEP"
echo "Seed complete."
echo ""
echo "Expected:"
echo "  Requests 1–5  → HTTP 200  (normal carts, correct totals)"
echo "  Requests 6–10 → HTTP 500  (multi-currency voucher, discountPercent on"
echo "                             0–1 scale passed to calculateCart which"
echo "                             divides by 100 a second time, inflating"
echo "                             totalAmount → processPayment throws)"
echo "$SEP"
