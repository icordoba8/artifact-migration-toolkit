'use strict';

class DiscountError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DiscountError';
    this.code = code;
  }
}

module.exports = { DiscountError };
