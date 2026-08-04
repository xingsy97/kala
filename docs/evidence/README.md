# Evidence revision and supersession policy

Evidence is immutable and revision-bound. A JSON evidence record used by a release decision must contain:

- `status`: `current`, `historical`, or `superseded`;
- `sourceRevision`: the full Git commit SHA used to produce it;
- `generatedAt`: an ISO-8601 timestamp;
- `supersedes`: an array of repository-relative evidence paths (empty for the first record);
- `generator`: the repository-relative command or script that can reproduce the record.

Only `current` evidence generated from a clean tree at the release commit is authoritative. Dirty-tree evidence, fixture evidence, and records whose `sourceRevision` differs from release HEAD are historical and cannot satisfy a release gate. A replacement record lists every displaced record in `supersedes`; displaced records remain immutable and are treated as `superseded` by consumers. There must be at most one current record for a given scope.

The files under [`evaluation/`](evaluation/) predate this policy unless they contain all metadata above. They are historical inputs, not current release acceptance. In particular, filenames containing `final` or `current` do not confer current status.

Use `node scripts/evaluation/record-evidence-revision.mjs --input <generated.json> --output <docs/evidence/...json> [--supersedes <path,...>]` from a clean checkout. The recorder rejects a dirty tree, binds the record to HEAD, and refuses to overwrite evidence.
