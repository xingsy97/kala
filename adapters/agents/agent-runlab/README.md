# @agent-kernel/eval-agent-runlab

Agent RunLab backend plugin for the Agent Evaluation Platform. It drives a RunLab
Session through the public protocol and exports `AgentRunLabBackend`,
`createAgentRunLabBackend`, and `evaluationPlugins`.

Load the package as an Eval Worker Agent plugin. Runtime credentials and endpoints
must be supplied through declared credential references, never committed config.
