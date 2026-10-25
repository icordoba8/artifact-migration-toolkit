# discounts Specification

## Purpose

Price a shopping cart in integer USD cents by applying volume, loyalty and coupon
discounts and a shipping charge, and validate coupon codes. Consumers reach the
module through its exported `quote` and `validateCoupon` functions; the orders
checkout summary calls `quote(cart, options)` and renders its result.

## Requirements

### Requirement: DISCOUNTS-REQ-001 Quote call contract
The module MUST export `quote(cart, options)`. `cart` is an object with `items` (an array of `{ sku, qty, unitPrice }` where `qty` and `unitPrice` are integer cents and counts), an optional `customer` object with an optional `tier`, and an optional `coupon` string. `options` is optional; the only key read is `options.now`, a `Date` that defaults to the current date when omitted. The function MUST return `{ currency, subtotal, discounts, shipping, total }` where `currency` is `"USD"`, `subtotal` is the sum of `unitPrice * qty` over all items, `discounts` is an ordered array of `{ code, amount }` lines with positive integer cent amounts, `shipping` is the shipping charge in cents and `total` is the subtotal minus every discount amount plus shipping.

#### Scenario: DISCOUNTS-SCN-001 Plain cart without discounts
Calling `quote({ items: [{ sku: "A", qty: 2, unitPrice: 1000 }] })` with no options returns `{ currency: "USD", subtotal: 2000, discounts: [], shipping: 799, total: 2799 }`.

#### Scenario: DISCOUNTS-SCN-002 Checkout summary consumer
The orders checkout summary calls `quote(cart, options)` with the caller's cart and options unchanged and reads `discounts[].code`, `discounts[].amount`, `shipping` and `total` from the result.

### Requirement: DISCOUNTS-REQ-002 Cart validation
`quote` MUST reject a cart whose `items` is missing, not an array or empty with error code `EMPTY_CART`, including when `cart` itself is null or undefined. It MUST reject any item whose `qty` is not an integer of at least 1 with error code `INVALID_QTY`, and any item whose `unitPrice` is not a non-negative integer with error code `INVALID_PRICE`. Items are checked in order and the first failing item determines the error. Each rejection MUST be thrown as an error carrying the stable upper-case identifier in its `code` property.

#### Scenario: DISCOUNTS-SCN-003 Empty cart
Calling `quote({ items: [] })` throws an error whose `code` is `EMPTY_CART`.

#### Scenario: DISCOUNTS-SCN-004 Missing cart
Calling `quote(null)` throws an error whose `code` is `EMPTY_CART`.

#### Scenario: DISCOUNTS-SCN-005 Non-integer quantity
Calling `quote` with an item whose `qty` is `0` or `1.5` throws an error whose `code` is `INVALID_QTY`.

#### Scenario: DISCOUNTS-SCN-006 Invalid unit price
Calling `quote` with an item whose `unitPrice` is `-1` or `9.99` throws an error whose `code` is `INVALID_PRICE`.

### Requirement: DISCOUNTS-REQ-003 Volume discount
`quote` MUST apply a volume discount to the subtotal based on the total quantity across all items: 10 percent when the total quantity is at least 50, 5 percent when it is at least 10, and none otherwise. The amount MUST be rounded half-up to whole cents and, when positive, recorded as the first discount line with code `VOLUME`.

#### Scenario: DISCOUNTS-SCN-007 Five percent volume tier
A cart of one item with `qty` 10 and `unitPrice` 1000 yields subtotal 10000 and a first discount line `{ code: "VOLUME", amount: 500 }`.

#### Scenario: DISCOUNTS-SCN-008 Ten percent volume tier
A cart of one item with `qty` 50 and `unitPrice` 100 yields subtotal 5000 and a first discount line `{ code: "VOLUME", amount: 500 }`.

#### Scenario: DISCOUNTS-SCN-009 Below volume threshold
A cart whose total quantity is 9 records no `VOLUME` line.

### Requirement: DISCOUNTS-REQ-004 Loyalty discount
`quote` MUST apply a loyalty discount after the volume discount, to the amount remaining after it, at 0 percent for tier `standard`, 2 percent for `gold` and 4 percent for `platinum`. A missing customer or a `tier` that is undefined or null MUST be treated as 0 percent. Any other tier value MUST be rejected with error code `UNKNOWN_TIER`. The amount MUST be rounded half-up to whole cents and, when positive, recorded with code `LOYALTY` after any `VOLUME` line.

#### Scenario: DISCOUNTS-SCN-010 Gold after volume
A cart with one item of `qty` 10 and `unitPrice` 1000 and customer tier `gold` yields `discounts` `[{ code: "VOLUME", amount: 500 }, { code: "LOYALTY", amount: 190 }]`.

#### Scenario: DISCOUNTS-SCN-011 Unknown tier
A cart with customer tier `silver` throws an error whose `code` is `UNKNOWN_TIER`.

#### Scenario: DISCOUNTS-SCN-012 No tier
A cart with no `customer` records no `LOYALTY` line and is not rejected.

### Requirement: DISCOUNTS-REQ-005 Coupon application in quote
When `cart.coupon` is present and is not undefined, null or the empty string, `quote` MUST validate it against the pre-discount subtotal and `options.now` using the coupon rules of DISCOUNTS-REQ-006, and MUST throw an error whose `code` is the rejection reason (`UNKNOWN_COUPON`, `COUPON_EXPIRED` or `COUPON_MINIMUM_NOT_MET`) when it is invalid. A valid coupon MUST apply after volume and loyalty: a percent coupon takes its rate of the remaining amount rounded half-up to whole cents; a fixed coupon takes its amount capped at the remaining amount; a shipping coupon adds no discount line and makes shipping free. A positive coupon amount MUST be recorded as the last discount line with the normalized coupon code as its `code`.

#### Scenario: DISCOUNTS-SCN-013 Percent coupon after volume and loyalty
A cart with one item of `qty` 10 and `unitPrice` 1000, customer tier `gold` and coupon `save10` yields `discounts` `[{ code: "VOLUME", amount: 500 }, { code: "LOYALTY", amount: 190 }, { code: "SAVE10", amount: 931 }]`, shipping 0 and total 8379.

#### Scenario: DISCOUNTS-SCN-014 Fixed coupon capped at remaining
A coupon `FLAT500` applied where the remaining amount is at least 500 records `{ code: "FLAT500", amount: 500 }`; the amount never exceeds the remaining amount.

#### Scenario: DISCOUNTS-SCN-015 Free shipping coupon
A cart of one item with `qty` 1 and `unitPrice` 1000 and coupon `FREESHIP` yields no coupon discount line, shipping 0 and total 1000.

#### Scenario: DISCOUNTS-SCN-016 Rejected coupon throws
A cart with coupon `NOPE` throws an error whose `code` is `UNKNOWN_COUPON`.

#### Scenario: DISCOUNTS-SCN-017 Empty coupon ignored
A cart with coupon `""` is quoted as if no coupon were present.

### Requirement: DISCOUNTS-REQ-006 Coupon validation call contract
The module MUST export `validateCoupon(code, subtotal, now)`. `code` is converted to a string, trimmed and upper-cased before lookup; `subtotal` is the pre-discount subtotal in cents; `now` is an optional `Date` defaulting to the current date. The catalogue is `SAVE10` (10 percent, minimum subtotal 5000), `FLAT500` (500 cents off, minimum subtotal 2000), `FREESHIP` (free shipping, no minimum) and `SUMMER23` (15 percent, no minimum, expires 2023-09-30 inclusive). The function MUST return `{ valid: true, code }` for an applicable coupon and `{ valid: false, code, reason }` otherwise, where `code` is the normalized code, and MUST NOT throw for an invalid coupon. The reason MUST be `UNKNOWN_COUPON` for a code not in the catalogue, then `COUPON_EXPIRED` when the UTC calendar date of `now` is after the expiry date, then `COUPON_MINIMUM_NOT_MET` when `subtotal` is below the minimum.

#### Scenario: DISCOUNTS-SCN-018 Normalized valid coupon
Calling `validateCoupon(" save10 ", 5000)` returns `{ valid: true, code: "SAVE10" }`.

#### Scenario: DISCOUNTS-SCN-019 Unknown coupon
Calling `validateCoupon("nope", 10000)` returns `{ valid: false, code: "NOPE", reason: "UNKNOWN_COUPON" }`.

#### Scenario: DISCOUNTS-SCN-020 Expired coupon
Calling `validateCoupon("SUMMER23", 10000, new Date("2023-10-01T00:00:00Z"))` returns `{ valid: false, code: "SUMMER23", reason: "COUPON_EXPIRED" }`, while the same call with `new Date("2023-09-30T23:59:59Z")` returns `{ valid: true, code: "SUMMER23" }`.

#### Scenario: DISCOUNTS-SCN-021 Minimum not met
Calling `validateCoupon("SAVE10", 4999)` returns `{ valid: false, code: "SAVE10", reason: "COUPON_MINIMUM_NOT_MET" }`.

### Requirement: DISCOUNTS-REQ-007 Shipping charge
`quote` MUST charge 799 cents shipping unless a valid shipping coupon was applied or the amount remaining after all discounts is at least 5000 cents, in which case shipping MUST be 0. `total` MUST equal the remaining amount plus shipping.

#### Scenario: DISCOUNTS-SCN-022 Free shipping threshold after discounts
A cart of one item with `qty` 1 and `unitPrice` 5000 and no discounts yields shipping 0 and total 5000.

#### Scenario: DISCOUNTS-SCN-023 Discounts drop below threshold
A cart with one item of `qty` 1 and `unitPrice` 5200 and coupon `FLAT500` leaves 4700 remaining and yields shipping 799 and total 5499.
