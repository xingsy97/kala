-------------------------- MODULE KernelContract --------------------------
\* Generated from packages/kernel/src/core.ts. Do not edit by hand.

Statuses == {
  "idle",
  "thinking",
  "awaiting_approval",
  "executing_tools",
  "done",
  "error"
}

EventKinds == {
  "user_message",
  "llm_response",
  "llm_error",
  "user_approve",
  "user_reject",
  "tool_result",
  "cancel",
  "clear",
  "messages_replaced",
  "approval_mode_changed",
  "cwd_changed"
}

LegalEvents(status) ==
  CASE status = "idle" -> {
         "user_message",
         "cancel",
         "clear",
         "messages_replaced",
         "approval_mode_changed",
         "cwd_changed"
       }
    [] status = "thinking" -> {
         "llm_response",
         "llm_error",
         "cancel",
         "clear",
         "messages_replaced",
         "approval_mode_changed"
       }
    [] status = "awaiting_approval" -> {
         "user_approve",
         "user_reject",
         "tool_result",
         "cancel",
         "clear",
         "approval_mode_changed"
       }
    [] status = "executing_tools" -> {
         "tool_result",
         "cancel",
         "clear",
         "messages_replaced",
         "approval_mode_changed"
       }
    [] status = "done" -> {
         "user_message",
         "clear",
         "messages_replaced",
         "approval_mode_changed",
         "cwd_changed"
       }
    [] status = "error" -> {
         "user_message",
         "clear",
         "messages_replaced",
         "approval_mode_changed"
       }

=============================================================================
