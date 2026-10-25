// Proof-only adapter: exposes the legacy CommonJS module through the ESM import path.
import { createRequire } from 'node:module';
const m = createRequire(import.meta.url)('./legacy-ref/src/features/discounts/index.js');
export const quote = m.quote; export const validateCoupon = m.validateCoupon;
