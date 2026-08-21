# Release evidence and RC promotion contract

**Status:** normative

An RC remains a draft until clean-environment evidence for every supported
distribution is complete. A successful build, unit test, packaging job, or workflow
definition is not a substitute for runtime evidence.

## Evidence envelope

Each runner writes one `*.rc-evidence.json` object. The schema is versioned and
closed: unknown fields are rejected. It binds `tag`, SemVer `version`, exact
40-character source `revision`, distribution `category`, target, tested artifact
name and SHA-256, generation time, and a fixed set of boolean checks. `ok` and every
required check must equal `true`.

Before a runner starts the product, the workflow verifies GitHub provenance for
the downloaded artifact and checksum index, verifies the checksum entry, and binds
the release manifest to the candidate or predecessor tag revision. A matching file
name or a checksum downloaded from the same unverified release is not sufficient.

Evidence deliberately excludes logs, receipts, domains, IP addresses, endpoints,
credentials, private paths, Session content, and screenshots. Those diagnostics may
remain in access-controlled workflow artifacts but cannot enter the public aggregate.

The required matrix is:

| Category | Target | Required proof |
|---|---|---|
| Portable | Linux, macOS, Windows on x64 and arm64 | exact asset, clean install, boot, capabilities, embedded Dashboard, persisted Session state, graceful stop, predecessor-to-candidate replacement |
| Dedicated | Linux x64 clean systemd | disabled staging, install, Browser, Executor, self-initiated graceful slot cutover, continuation, reboot, backup/restore, Supervisor rollback |
| Private Cloud | Linux x64 clean Compose | source-free install, two-tenant Runtime Session isolation, Browser, Executor, full image update, isolated Dashboard update, rollback, backup/restore |

## Promotion

`rc-acceptance.yml` runs against a draft tag and an explicit supported predecessor.
Portable jobs run on matching native runners. Dedicated uses a uniquely named clean
systemd LXD instance controlled from the runner. Private Cloud uses a runner reserved
for clean Compose acceptance and an access-controlled configuration template.

`promote-rc.yml` accepts an explicit acceptance run ID. Before changing release
state it verifies that the run used the RC workflow, concluded successfully, and
has the same source revision as the tag. It downloads all evidence and executes
`verify-rc-evidence.mjs`, which rejects missing or duplicate targets, false or
missing checks, revision/tag drift, unknown schema fields, and private diagnostic
material. Only then is the public redacted aggregate attached and the draft bit
cleared.

Publishing npm packages or OCI images is a separate authorization boundary. RC
promotion does not infer permission to publish those registries.
