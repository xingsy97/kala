# CI release-gate integrations

GitHub Actions, GitLab CI, and Jenkins examples in this directory call the same `agent-eval-ci` entry point. The CLI consumes a committed `RegressionGateDecision` JSON document and its immutable `ReportManifest`; CI files do not recalculate statistics or reinterpret the decision.

Set these paths in the job workspace (the report URL is the durable human-facing report):

```bash
AGENT_EVAL_GATE_DECISION=artifacts/gate-decision.json
AGENT_EVAL_REPORT_MANIFEST=artifacts/report-manifest.json
AGENT_EVAL_REPORT_URL=https://reports.example.invalid/evaluations/current
```

The CLI writes `gate.json`, `gate.csv`, `gate.junit.xml`, `gate.sarif.json`, and `gate.md`; Markdown and JSON carry the report URL. Exit codes are stable: `0` is pass, `1` is a deterministic regression block, and `2` is indeterminate evidence or infrastructure. All three examples always upload outputs, publish JUnit and SARIF where supported, and do not convert `2` into an Agent regression.

The files under `fixtures/` are public synthetic acceptance inputs. They contain no model credentials, prompts, workspace source, or historical Host evaluation state.
