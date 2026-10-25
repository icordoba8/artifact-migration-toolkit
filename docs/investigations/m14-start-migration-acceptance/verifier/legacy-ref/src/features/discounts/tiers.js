'use strict';

// Volume discount by total item count, applied to the subtotal.
function volumeRate(totalQty) {
  if (totalQty >= 50) return 0.10;
  if (totalQty >= 10) return 0.05;
  return 0;
}

// Loyalty discount by customer tier, applied after the volume discount.
const LOYALTY = { standard: 0, gold: 0.02, platinum: 0.04 };

function loyaltyRate(tier) {
  if (tier === undefined || tier === null) return 0;
  if (!Object.prototype.hasOwnProperty.call(LOYALTY, tier)) return null;
  return LOYALTY[tier];
}

module.exports = { volumeRate, loyaltyRate };
