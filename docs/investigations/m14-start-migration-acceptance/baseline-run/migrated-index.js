import { DomainError } from '../../shared/errors.js';
import { roundCents } from '../../shared/money.js';
import { checkCoupon } from './coupons.js';
import { loyaltyRate, volumeRate } from './tiers.js';

const SHIPPING_CENTS = 799;
const FREE_SHIPPING_FROM = 5000;

function validateItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new DomainError('EMPTY_CART', 'Cart has no items');
  }
  for (const item of items) {
    if (!Number.isInteger(item.qty) || item.qty < 1) {
      throw new DomainError('INVALID_QTY', `Invalid quantity ${item.qty}`);
    }
    if (!Number.isInteger(item.unitPrice) || item.unitPrice < 0) {
      throw new DomainError('INVALID_PRICE', `Invalid unit price ${item.unitPrice}`);
    }
  }
}

function hasCoupon(code) {
  return code !== undefined && code !== null && code !== '';
}

export function validateCoupon(code, subtotal, now = new Date()) {
  const { valid, code: normalised, reason } = checkCoupon(code, subtotal, now);
  return valid ? { valid, code: normalised } : { valid, code: normalised, reason };
}

export function quote(cart, now = new Date()) {
  const items = cart?.items;
  validateItems(items);

  const subtotal = items.reduce((sum, item) => sum + item.qty * item.unitPrice, 0);
  const totalQty = items.reduce((sum, item) => sum + item.qty, 0);
  const loyalty = loyaltyRate(cart.customer?.tier);

  let applied = null;
  if (hasCoupon(cart.coupon)) {
    applied = checkCoupon(cart.coupon, subtotal, now);
    if (!applied.valid) {
      throw new DomainError(applied.reason, `Coupon ${applied.code} rejected`);
    }
  }

  const discounts = [];
  let remaining = subtotal;

  const volumeAmount = roundCents(remaining * volumeRate(totalQty));
  if (volumeAmount > 0) {
    discounts.push({ code: 'VOLUME', amount: volumeAmount });
    remaining -= volumeAmount;
  }

  const loyaltyAmount = roundCents(remaining * loyalty);
  if (loyaltyAmount > 0) {
    discounts.push({ code: 'LOYALTY', amount: loyaltyAmount });
    remaining -= loyaltyAmount;
  }

  let freeShipping = false;
  if (applied) {
    const { coupon } = applied;
    let couponAmount = 0;
    if (coupon.kind === 'percent') couponAmount = roundCents(remaining * coupon.rate);
    else if (coupon.kind === 'fixed') couponAmount = Math.min(coupon.amount, remaining);
    else freeShipping = true;
    if (couponAmount > 0) {
      discounts.push({ code: applied.code, amount: couponAmount });
      remaining -= couponAmount;
    }
  }

  const shipping = freeShipping || remaining >= FREE_SHIPPING_FROM ? 0 : SHIPPING_CENTS;

  return { currency: 'USD', subtotal, discounts, shipping, total: remaining + shipping };
}
