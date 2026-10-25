'use strict';

// Half-up rounding to whole cents. Inputs are non-negative.
function roundCents(value) {
  return Math.floor(value + 0.5);
}

function formatCents(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return sign + '$' + Math.floor(abs / 100) + '.' + String(abs % 100).padStart(2, '0');
}

module.exports = { roundCents, formatCents };
