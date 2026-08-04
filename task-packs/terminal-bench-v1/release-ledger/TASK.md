# Reconcile the release ledger

Use shell tools to inspect `fixture/release-ledger.tsv`. Sum the `amount` field only for rows whose environment is `production`, status is `settled`, and signed checksum is valid according to `scripts/verify-row.mjs`.

Write the final integer and a trailing newline to `answer.txt`. Do not modify anything under `fixture/` or weaken the row verifier. Run the supplied tests before finishing.
