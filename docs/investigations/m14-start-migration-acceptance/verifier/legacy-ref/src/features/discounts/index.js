'use strict';

const { roundCents } = require('../../shared/money');
const { DiscountError } = require('./errors');
const { validateCoupon } = require('./coupons');
const { volumeRate, loyaltyRate } = require('./tiers');

const SHIPPING_CENTS = 799;
const FREE_SHIPPING_FROM = 5000;

function checkItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new DiscountError('EMPTY_CART', 'Cart has no items');
  }
  for (const item of items) {
    if (!Number.isInteger(item.qty) || item.qty < 1) {
      throw new DiscountError('INVALID_QTY', 'Invalid quantity for ' + item.sku);
    }
    if (!Number.isInteger(item.unitPrice) || item.unitPrice < 0) {
      throw new DiscountError('INVALID_PRICE', 'Invalid price for ' + item.sku);
    }
  }
}

// Price a cart: volume, then loyalty, then coupon, then shipping.
function quote(cart, options) {
  const opts = options || {};
  checkItems(cart && cart.items);
  const customer = cart.customer || {};
  const loyalty = loyaltyRate(customer.tier);
  if (loyalty === null) {
    throw new DiscountError('UNKNOWN_TIER', 'Unknown customer tier ' + customer.tier);
  }

  const subtotal = cart.items.reduce((sum, i) => sum + i.unitPrice * i.qty, 0);
  const totalQty = cart.items.reduce((sum, i) => sum + i.qty, 0);
  const discounts = [];
  let remaining = subtotal;

  const volume = roundCents(remaining * volumeRate(totalQty));
  if (volume > 0) { discounts.push({ code: 'VOLUME', amount: volume }); remaining -= volume; }

  const loyal = roundCents(remaining * loyalty);
  if (loyal > 0) { discounts.push({ code: 'LOYALTY', amount: loyal }); remaining -= loyal; }

  let freeShipping = false;
  if (cart.coupon !== undefined && cart.coupon !== null && cart.coupon !== '') {
    const result = validateCoupon(cart.coupon, subtotal, opts.now);
    if (!result.valid) throw new DiscountError(result.reason, 'Coupon rejected: ' + result.code);
    const c = result.coupon;
    let amount = 0;
    if (c.kind === 'percent') amount = roundCents(remaining * c.rate);
    else if (c.kind === 'fixed') amount = Math.min(c.amount, remaining);
    else if (c.kind === 'shipping') freeShipping = true;
    if (amount > 0) { discounts.push({ code: result.code, amount }); remaining -= amount; }
  }

  const shipping = freeShipping || remaining >= FREE_SHIPPING_FROM ? 0 : SHIPPING_CENTS;
  return { currency: 'USD', subtotal, discounts, shipping, total: remaining + shipping };
}

module.exports = { quote, validateCoupon: (code, subtotal, now) => {
  const r = validateCoupon(code, subtotal, now);
  return r.valid ? { valid: true, code: r.code } : { valid: false, code: r.code, reason: r.reason };
} };
