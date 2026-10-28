# M14.1: live `/start-migration` runs on the engine fix (`9842054`, `49a4e1e`)

The M14 D1 fix moved from guidance (`cd73701`) into the engine: FINALIZE refuses
`EXPORT_CONTRACT_INCOMPATIBLE` and `STALE_VERIFICATION_EVIDENCE` (`9842054`), and a
module root's public entry is held to its whole export surface (`49a4e1e`). Each
commit was built as a `0.0.1` candidate with the repository's own procedure, and
installed and staged offline in a fresh consumer from the M14 fixture, as in the
parent README. **Assurance: FUNCTIONAL_VALIDATION_ONLY**, with the same limits:
no OS isolation, and one LLM sample per candidate.

The independent verifier is the M14 one (`../verifier/verify.mjs`, sha256 `a0055e2d…52e7`).

| | `run-9842054/` | `run-49a4e1e/` |
| --- | --- | --- |
| Candidate | contentHash `3ec13f79…5d11`, pin `4aefed69…0af5` | contentHash `d79d9c82…e2be`, pin `a3709d13…1948` |
| Run 1 | `/start-migration discounts --target discounts --registry …`, SIGKILLed 25 s into `BUILD_BASELINE` | same |
| Resume | run 2 `/start-migration discounts` resumed at `BUILD_BASELINE` → `COMPLETE`, exit 0 | run 2 stopped at `BUILD_BASELINE` on the account's 5-hour usage limit (exit 1, an infra stop, no record change); run 3, the same resume command, → `COMPLETE`, exit 0 |
| Lifecycle | 9/9, 2 slices, `COMPLETE` at revision 11, format 21 | same |
| Writes | `legacy/`, installed skills and verifier hashes unchanged | same |
| **Independent verifier** | **37/37 PASS** | **37/37 PASS** |

`watch.log` is the watcher's step timeline for each run.

## Mutations of the completed target (`negative-checks.json`)

Each case changes the completed target and re-evaluates the two FINALIZE refusals.

| Case | `9842054` export / freshness | `49a4e1e` export / freshness |
| --- | --- | --- |
| as-completed | PASS / PASS | PASS / PASS |
| d1-bare-date (`quote(cart, now)`) | REFUSED / REFUSED | REFUSED / REFUSED |
| quote-not-exported | REFUSED / REFUSED | REFUSED / REFUSED |
| unused-export-dropped (`validateCoupon`) | **PASS** / REFUSED | **REFUSED** / REFUSED |
| benign-edit-after-verify | PASS / REFUSED | PASS / REFUSED |
| benign-edit-then-fresh-final-verify | PASS / PASS | PASS / PASS |

`unused-export-dropped` is the gap `9842054` left. The only legacy consumer
destructures `quote` alone, so `validateCoupon` was owed only by freshness. `49a4e1e`
closes it: the public index owes every export once any production consumer imports it.
Benign edits are refused only until fresh `FINAL_VERIFY` evidence is recorded.

## Limits

- One sample per candidate. The candidates are `0.0.1` builds, not published releases.
- Run transcripts (`run*.jsonl`) stay in the operator's acceptance workspace. They are not committed.
- Codex, OpenCode, Copilot, Windows and the `OPERATOR_DECISION` relay are NOT_TESTED.
