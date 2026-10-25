'use strict';

const { quote } = require('../discounts');
const { formatCents } = require('../../shared/money');

// Builds the order summary shown on the confirmation e-mail.
function summarize(cart, options) {
  const q = quote(cart, options);
  const lines = q.discounts.map(d => d.code + ': -' + formatCents(d.amount));
  lines.push('Shipping: ' + formatCents(q.shipping));
  lines.push('Total: ' + formatCents(q.total));
  return lines.join('\n');
}

module.exports = { summarize };
