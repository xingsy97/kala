# Trace a configuration value to runtime output

The command `node src/cli.mjs Ada` currently prints `hello Ada`. Investigate how the `greetingPrefix` configuration value flows from its declaration to the final rendered output. Do not implement the proposed `welcome` change.

Replace the TODO content in `localization.json` with one strict JSON object:

- `schemaVersion`: `1`;
- `k`: `5`;
- `rankedFiles`: up to five repository-relative files, most relevant first;
- `rankedSymbols`: up to five symbols, most relevant first, formatted as `path#symbol`;
- `predictedDependencyEdges`: directed `[source, target]` symbol pairs representing the configuration-to-output call/data chain.

Use exact file and exported/local symbol names from the repository. Include only evidence that is necessary to explain the behavior and likely impact of changing the configured prefix. Do not modify source, configuration, tests, or verifier code. Run the public tests before finishing.
