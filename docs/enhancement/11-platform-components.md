# Platform Components

Status: proposed enhancement  
Priority: 11

## Why This Matters

The project is TypeScript-first today, which is fine for the host/dashboard
prototype. The target roles also value Python/Go/C++ systems ability and ML
platform integration. The right move is not a rewrite; it is adding platform
components where they carry real value.

## Design Principle

Keep the core protocol stable and language-neutral. Add Python/Go components as
adapters, runners, or high-performance services around the existing architecture.

## Python Components

Best fit:

- SWE-bench harness wrapper and dataset loader.
- Eval runner integrations with Hugging Face datasets.
- RL rollout exporters for slime/verl.
- Phoenix/LangSmith interop scripts.

Python is appropriate because SWE-bench, RL frameworks, PyTorch, vLLM, SGLang,
and many eval libraries are Python-native.

## Go Components

Best fit:

- High-concurrency worker supervisor.
- Artifact server for traces and run files.
- OTLP collector sidecar or gateway.
- Process supervisor for executors in production deployment.

Go is appropriate where static binaries, concurrency, and operational simplicity
matter.

## TypeScript Components

Keep TypeScript for:

- Kernel reducer.
- Host orchestration.
- Dashboard.
- Executor tool implementations.
- Local developer workflow.

## CI/CD

Release workflows should build and publish binaries for key components:

- host CLI
- executor CLI
- optional eval runner artifacts
- dashboard static bundle

GitHub Actions should run:

- lint/typecheck/test for packages
- dashboard build
- package binaries on tags
- attach artifacts to GitHub Releases
- optional manual SWE-bench smoke workflow

## Testing Plan

- Cross-language contract tests using JSON fixtures.
- CLI smoke tests for packaged host/executor.
- Release workflow dry-run on pull requests without publishing.
- Manual release workflow that uploads artifacts only on tags.

## Non-Goals

- Do not rewrite the kernel in another language prematurely.
- Do not create separate protocols per language.
- Do not add Python/Go just for portfolio value; each component must own a real
  integration or operational boundary.

