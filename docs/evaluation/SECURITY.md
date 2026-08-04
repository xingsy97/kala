# Evaluation extension security

Treat Agent code, repositories, task packs, verifiers, and plugin inputs as untrusted. Agent and verifier processes execute only in an explicitly configured Docker or LXD sandbox with a read-only base, ephemeral overlay, resource limits, denied-by-default network, and a contained artifact allowlist.

Extensions receive resolved credentials only at the execution boundary. Accept credential references in public specs; map only declared providers to an explicit sandbox environment allowlist. Do not put secret values in host command arguments, files outside the sandbox, logs, events, metrics, reports, exceptions, or plugin descriptors.

Artifacts must use relative contained paths and regular files. Reject traversal, absolute paths, symlinks, hash or size mismatches, unknown licenses, and denied/unreviewed evaluation permissions. Public fixtures and corpora must contain no credentials, private absolute paths, customer data, or non-redistributable material.

Report a suspected vulnerability privately to the repository security contact. Include the affected package/version and a minimal synthetic reproduction; do not attach real credentials or private evaluation artifacts.
