# Privacy gate

The privacy gate blocks sensitive or non-public development data before it
enters Git history. Repository policy contains only public structural rules,
example values, runtime asset paths, and narrowly documented exceptions.

Install the versioned hooks once per clone:

```bash
pnpm hooks:install
```

The hooks run the same scanner in three modes:

- `pre-commit`: staged Git objects and staged paths;
- `commit-msg`: the proposed commit message;
- `pre-push`: commits that the push would introduce.

CI runs both the checked-out snapshot scan and the pull-request commit range.
Hooks are fast feedback, while the required CI check is the non-bypassable
repository boundary.

Release CI additionally scans the complete reachable Git history with
`pnpm privacy:history`. Historical runtime assets are approved only by exact path
and content hash; a current-tree pass alone is not sufficient for publication.

## Machine-local denylist

Known private values must never be committed to the policy. Put one exact
value per line in `.git/privacy-denylist`, point `PRIVACY_DENYLIST_FILE` at a
permission-restricted file, or inject newline-separated values through the
`PRIVACY_DENYLIST` CI secret. Findings report a rule, location, and diagnostic
fingerprint but never print the matched value.

## Policy changes

New images and binary fixtures are denied by default. Add an exact path only
when the file is required at runtime or is a reviewed deterministic fixture.
Exceptions require an exact rule and path plus a public reason; directory-wide
or wildcard exceptions are not supported.
