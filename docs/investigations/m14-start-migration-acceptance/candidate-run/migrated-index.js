import { checkCoupon } from './coupons.js';
import { priceCart } from './pricing.js';

export function quote(cart, options) {
  return priceCart(cart, options);
}

export function validateCoupon(code, subtotal, now) {
  const result = checkCoupon(code, subtotal, now);
  return result.valid
    ? { valid: true, code: result.code }
    : { valid: false, code: result.code, reason: result.reason };
}
