# Operator-signer "proof swapped" failure at 86d66a9

CI run 40108455285 (`release/v1.6.2-evidence` @ `86d66a9`, a one-line README
change), shard 3/3, failed with `Missing expected rejection: proof swapped` in
`operator-signer.integration.spec.mjs` (full log: `ci-86d66a9-shard3-failed.log`).
The same engine tree passed at `4a431b8`, `0ed58b8` and `336531c`.

## Classification: test nondeterminism, not an engine defect

The forgery was `signature.slice(0, -2) + "AA"`. When the genuine base64url
ECDSA signature already ends in `AA`, the "forged" line is byte-identical to the
genuine one, so the read correctly accepts it: nothing was forged.

- Rate: 299 of 200,000 P-256 signatures end in `AA`, about 1 in 669 (`aa-rate.json`).
- Deterministic repro: with a genuine signature forced to end in `AA`, the
  original mutation fails with the exact CI error (`repro-original-mutation.log`).
- Engine read path (`operator-signer.mjs` `verifyDecisionLine`): the whole line's
  sha256 must equal the protected claim's `lineDigest`, and `sha256(webauthn)`
  must equal `proofDigest`, before the WebAuthn signature is re-verified. So any
  changed proof byte is refused.

## Fix (test only)

- "proof swapped" now flips one decoded signature byte, so it always differs.
- Every forgery asserts it changes the line before it expects a refusal.
- Regression test: a genuine signature that ends in `AA` (forced); all five
  forgeries are refused, and so is every single-character signature change.
- Five consecutive runs of the fixed suite: 19/19 pass (`fixed-runs.txt`).

No engine source changed.
