# Dashboard Agent Kernel Debugger
  
  **Status**: design target for the right-side dashboard inspector.
  **Scope**: `packages/dashboard/src/features/inspector/` plus optional host-side LLM trace metadata.
  
  ## 1. Purpose
  
  The right sidebar is a teaching debugger for the core runtime loop:
  
  ```text
  event in -> pure reducer -> next state + effects -> host/executor/LLM IO -> new event
  ```
  
  The UI should make that loop readable while preserving access to raw internals. A learner should be able to start from the state-machine trace and drill into JSON, tool lifecycle, memory, and LLM request/response data.
  
  ## 2. Design Constraints
  
  Preserve the dashboard visual language, keep reducer state and effect names visible, preserve existing timeline/state/fork/jump/raw JSON capabilities, add a clear LLM-call view, and keep provider trace metadata outside kernel state.
  
  ## 3. Information Architecture
  
  The inspector consists of an overview, debugger tabs for runtime objects, trace tabs for reducer/LLM/tool calls, and detail modals for selected events, LLM I/O, tool lifecycle, full state JSON, and compaction artifacts.
  
  ## 4. Mock Session Data
  
  Example session data uses a generic cwd-fix task, an Anthropic model, `approvalMode: ask`, `status: executing_tools`, a current cursor, message counts, tool counts, memory counts, and usage totals.
  
  ## 5. Reducer Trace
  
  Reducer Trace merges timeline and state flow. Each row shows the input event, state transition, emitted effects, and row actions. Example user text: "Please fix executor relative paths so they follow cwd." Example assistant text: "Fixed cwd-relative path resolution and added tests."
  
  ## 6. LLM Calls
  
  LLM Calls groups `call_llm` effects with later `llm_response` or `llm_error` events. It should answer what request each LLM call sent and what response came back. Kernel request data can come from effects; provider HTTP body/response requires host adapter trace metadata with credential redaction.
  
  ## 7. Tool Calls
  
  Tool Calls should show lifecycle, approval state, executor result, status, call id, tool name, input preview, and raw JSON drill-down. It should remain a debugger, not a simplified activity feed.
  
  ## 8. Boundary Rule
  
  Provider traces and UI explanations are metadata. They are not reducer events and do not belong in `AgentState`.
  