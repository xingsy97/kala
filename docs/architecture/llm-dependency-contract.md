# LLM Dependency Architecture

The Host loop depends only on `LLMAdapter` (the Port). OpenAI/Anthropic implementations are Adapters. Provider selection and construction belong to `LLMClientFactory`; environment/configuration is read only by Standalone and RuntimeHost composition roots.

## Scopes

- Process: immutable adapter registry, HTTP pools, bounded provider health registry.
- TenantRuntimeUnit: model policy, credential references, quotas and health view; never shared mutable credentials.
- Session: selected model, cancellation signal, usage and trace state.

`SecretResolver` resolves an opaque credential reference only at adapter construction/call boundaries. Secrets never enter Dashboard payloads, Unit catalogs, Sessions, traces, logs or errors. Provider protocol branching is allowed only in factories/adapters. Global service locators are forbidden.

The Port preserves request messages/tools/model/cancellation/text deltas and normalized response message/usage/finish reason/trace. Provider errors normalize status, retryability, rate limiting and context overflow without exposing response bodies.
