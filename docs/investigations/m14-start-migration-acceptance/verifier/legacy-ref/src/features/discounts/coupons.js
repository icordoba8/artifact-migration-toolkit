'use strict';

// Coupon catalogue. `minSubtotal` is compared against the cart subtotal
// (before any discount). Dates are ISO days, inclusive.
const COUPONS = {
  SAVE10: { kind: 'percent', rate: 0.10, minSubtotal: 5000 },
  FLAT500: { kind: 'fixed', amount: 500, minSubtotal: 2000 },
  FREESHIP: { kind: 'shipping', minSubtotal: 0 },
  SUMMER23: { kind: 'percent', rate: 0.15, minSubtotal: 0, expires: '2023-09-30' },
};

function normalizeCode(code) {
  return String(code).trim().toUpperCase();
}

function validateCoupon(code, subtotal, now) {
  const key = normalizeCode(code);
  const coupon = COUPONS[key];
  if (!coupon) return { valid: false, code: key, reason: 'UNKNOWN_COUPON' };
  const today = (now || new Date()).toISOString().slice(0, 10);
  if (coupon.expires && today > coupon.expires) {
    return { valid: false, code: key, reason: 'COUPON_EXPIRED' };
  }
  if (subtotal < coupon.minSubtotal) {
    return { valid: false, code: key, reason: 'COUPON_MINIMUM_NOT_MET' };
  }
  return { valid: true, code: key, coupon };
}

module.exports = { validateCoupon, normalizeCode };
