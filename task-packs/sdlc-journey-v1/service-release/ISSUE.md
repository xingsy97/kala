# Release v2 does not appear after deployment

The service is preparing the next release, but `GET /version` still reports `v1`. Update the implementation and its test coverage so the source, built output, and release archive report `v2`. Preserve `GET /health`.

Record the root cause and the files used to confirm it in `evidence/investigation.md`. Run the unit tests and the build/package workflow. Do not edit anything under `fixture/`; it is the protected rollback release.
