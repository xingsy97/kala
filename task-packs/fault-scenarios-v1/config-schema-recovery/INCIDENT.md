# Recover service startup after a configuration incident

The service stopped during startup. Diagnose the checked-in incident evidence, repair the production configuration without weakening the strict schema, and confirm both the recovered configuration and a known-good control.

Write `evidence/recovery.md` describing the observed error, the affected path, and why the recovery is safe. Preserve the strict rejection of string-valued ports and do not edit anything under `fixture/`.
