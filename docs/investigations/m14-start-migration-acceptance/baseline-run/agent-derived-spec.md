# discounts Specification

## Purpose

Price a shopping cart in integer USD cents by applying, in order, a volume
discount, a loyalty discount, an optional coupon, and shipping, and validate
coupon codes on their own.

## Requirements

### Requirement: DISCOUNTS-REQ-001 Cart validation
The target MUST reject a cart with no items with the failure code EMPTY_CART, MUST reject any item whose quantity is not an integer of at least 1 with the failure code INVALID_QTY, and MUST reject any item whose unit price is not a non-negative integer number of cents with the failure code INVALID_PRICE. Cart validation SHALL happen before any other check.

#### Scenario: DISCOUNTS-SCN-001 Empty cart
Quoting a cart whose items list is missing or empty fails with code EMPTY_CART.

#### Scenario: DISCOUNTS-SCN-002 Invalid quantity
Quoting a cart containing an item with quantity 0 or a fractional quantity fails with code INVALID_QTY.

#### Scenario: DISCOUNTS-SCN-003 Invalid price
Quoting a cart containing an item with a negative or fractional unit price fails with code INVALID_PRICE; a unit price of 0 is accepted.

### Requirement: DISCOUNTS-REQ-002 Volume discount
The target MUST apply a volume discount to the cart subtotal based on the total item quantity: 10% from 50 items, 5% from 10 items, and none below 10 items. The amount SHALL be rounded half-up to whole cents and recorded as a discount line with code VOLUME only when it is greater than zero.

#### Scenario: DISCOUNTS-SCN-004 Ten items
A cart of 10 items with subtotal 10000 cents receives a VOLUME discount line of 500 cents.

#### Scenario: DISCOUNTS-SCN-005 Fifty items
A cart of 50 items receives a VOLUME discount of 10% of the subtotal.

#### Scenario: DISCOUNTS-SCN-006 Below threshold
A cart of 9 items receives no VOLUME discount line.

### Requirement: DISCOUNTS-REQ-003 Loyalty discount
The target MUST apply a loyalty discount after the volume discount, computed on the amount remaining after volume: 0% for standard, 2% for gold and 4% for platinum. A customer with no tier SHALL be treated as standard. An unrecognised tier MUST fail with the failure code UNKNOWN_TIER. The amount SHALL be rounded half-up and recorded as a LOYALTY discount line only when greater than zero.

#### Scenario: DISCOUNTS-SCN-007 Gold after volume
A gold customer with 10 items and subtotal 10000 cents receives VOLUME 500 and LOYALTY 190.

#### Scenario: DISCOUNTS-SCN-008 No tier
A cart without a customer or tier receives no LOYALTY discount line and does not fail.

#### Scenario: DISCOUNTS-SCN-009 Unknown tier
A cart whose customer tier is diamond fails with code UNKNOWN_TIER.

### Requirement: DISCOUNTS-REQ-004 Coupon validation
The target MUST normalise a coupon code by trimming surrounding whitespace and upper-casing it. It MUST report UNKNOWN_COUPON for a code not in the catalogue, COUPON_EXPIRED when the current calendar day (UTC) is after the coupon's inclusive expiry day, and COUPON_MINIMUM_NOT_MET when the cart subtotal before any discount is below the coupon minimum, checked in that order. The catalogue SHALL contain SAVE10 (10% off, minimum 5000), FLAT500 (500 cents off, minimum 2000), FREESHIP (free shipping, no minimum) and SUMMER23 (15% off, no minimum, expires 2023-09-30). A standalone coupon check MUST return the validity, the normalised code and, when invalid, the reason.

#### Scenario: DISCOUNTS-SCN-010 Normalised code
Checking the code " save10 " against a subtotal of 5000 is valid with code SAVE10.

#### Scenario: DISCOUNTS-SCN-011 Unknown code
Checking the code BOGUS is invalid with reason UNKNOWN_COUPON.

#### Scenario: DISCOUNTS-SCN-012 Expired code
Checking SUMMER23 on 2023-10-01 is invalid with reason COUPON_EXPIRED, and on 2023-09-30 it is valid.

#### Scenario: DISCOUNTS-SCN-013 Minimum on pre-discount subtotal
Checking SAVE10 against a subtotal of 4999 is invalid with reason COUPON_MINIMUM_NOT_MET, judged on the subtotal before volume and loyalty discounts.

### Requirement: DISCOUNTS-REQ-005 Coupon application
When a cart carries a non-empty coupon, the target MUST validate it and, if invalid, fail with the validation reason as the failure code. A valid coupon SHALL be applied after loyalty: a percentage coupon to the remaining amount rounded half-up, a fixed coupon capped at the remaining amount, and a shipping coupon granting free shipping without a discount line. A coupon discount line MUST use the normalised coupon code and SHALL be recorded only when greater than zero. An absent, null or empty coupon MUST be ignored.

#### Scenario: DISCOUNTS-SCN-014 Percent coupon after loyalty
A coupon SAVE10 is applied to the amount remaining after volume and loyalty discounts.

#### Scenario: DISCOUNTS-SCN-015 Fixed coupon capped
FLAT500 never reduces the remaining amount below zero.

#### Scenario: DISCOUNTS-SCN-016 Rejected coupon fails the quote
Quoting a cart with coupon BOGUS fails with code UNKNOWN_COUPON.

#### Scenario: DISCOUNTS-SCN-017 Free shipping coupon
Quoting with FREESHIP produces shipping 0 and no FREESHIP discount line.

### Requirement: DISCOUNTS-REQ-006 Shipping and totals
The target MUST charge 799 cents shipping unless a shipping coupon applies or the amount remaining after all discounts is at least 5000 cents, in which case shipping SHALL be 0. A quote MUST return currency USD, the pre-discount subtotal, the ordered discount lines, the shipping and a total equal to the remaining amount plus shipping.

#### Scenario: DISCOUNTS-SCN-018 Shipping charged
A cart whose discounted amount is 4999 cents is charged 799 cents shipping and totals 5798.

#### Scenario: DISCOUNTS-SCN-019 Free shipping threshold after discounts
A cart with subtotal 5200 whose discounts bring the remaining amount below 5000 is charged shipping, while a remaining amount of exactly 5000 ships free.
