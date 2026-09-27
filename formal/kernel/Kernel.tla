------------------------------ MODULE Kernel ------------------------------
EXTENDS FiniteSets, KernelContract, Naturals

Calls == {"call-1", "call-2"}
EffectKinds == {
  "call_llm",
  "call_tool",
  "request_approval",
  "finish",
  "emit_error"
}

VARIABLES
  status,
  waitingApproval,
  dispatched,
  authorized,
  cursorParity,
  lastEvent,
  effects,
  effectCalls

vars ==
  <<status, waitingApproval, dispatched, authorized, cursorParity, lastEvent,
    effects, effectCalls>>

Init ==
  /\ status = "idle"
  /\ waitingApproval = {}
  /\ dispatched = {}
  /\ authorized = {}
  /\ cursorParity = FALSE
  /\ lastEvent = "none"
  /\ effects = {}
  /\ effectCalls = {}

RecordStep(event, producedEffects, producedCalls) ==
  /\ cursorParity' = ~cursorParity
  /\ lastEvent' = event
  /\ effects' = producedEffects
  /\ effectCalls' = producedCalls

UserMessage ==
  /\ status \in {"idle", "done", "error"}
  /\ status' = "thinking"
  /\ waitingApproval' = {}
  /\ dispatched' = {}
  /\ authorized' = {}
  /\ RecordStep("user_message", {"call_llm"}, {})

LlmPlain ==
  /\ status = "thinking"
  /\ status' = "done"
  /\ waitingApproval' = {}
  /\ dispatched' = {}
  /\ authorized' = {}
  /\ RecordStep("llm_response", {"finish"}, {})

LlmError ==
  /\ status = "thinking"
  /\ status' = "error"
  /\ waitingApproval' = {}
  /\ dispatched' = {}
  /\ authorized' = {}
  /\ RecordStep("llm_error", {"emit_error"}, {})

LlmSafeTool(call) ==
  /\ status = "thinking"
  /\ call \in Calls
  /\ status' = "executing_tools"
  /\ waitingApproval' = {}
  /\ dispatched' = {call}
  /\ authorized' = {call}
  /\ RecordStep("llm_response", {"call_tool"}, {call})

LlmGuardedTool(call) ==
  /\ status = "thinking"
  /\ call \in Calls
  /\ status' = "awaiting_approval"
  /\ waitingApproval' = {call}
  /\ dispatched' = {}
  /\ authorized' = {}
  /\ RecordStep("llm_response", {"request_approval"}, {})

Approve(call) ==
  /\ status = "awaiting_approval"
  /\ call \in waitingApproval
  /\ status' = "executing_tools"
  /\ waitingApproval' = {}
  /\ dispatched' = {call}
  /\ authorized' = authorized \cup {call}
  /\ RecordStep("user_approve", {"call_tool"}, {call})

Reject(call) ==
  /\ status = "awaiting_approval"
  /\ call \in waitingApproval
  /\ status' = "thinking"
  /\ waitingApproval' = {}
  /\ dispatched' = {}
  /\ authorized' = {}
  /\ RecordStep("user_reject", {"call_llm"}, {})

ToolResult(call) ==
  /\ status = "executing_tools"
  /\ call \in dispatched
  /\ status' = "thinking"
  /\ waitingApproval' = {}
  /\ dispatched' = {}
  /\ authorized' = {}
  /\ RecordStep("tool_result", {"call_llm"}, {})

RejectedAwaitingToolResult ==
  /\ status = "awaiting_approval"
  /\ UNCHANGED <<status, waitingApproval, dispatched, authorized>>
  /\ RecordStep("tool_result", {}, {})

Cancel ==
  /\ status \in {"idle", "thinking", "awaiting_approval", "executing_tools"}
  /\ status' = IF status = "idle" THEN "idle" ELSE "done"
  /\ waitingApproval' = {}
  /\ dispatched' = {}
  /\ authorized' = {}
  /\ RecordStep("cancel", IF status = "idle" THEN {} ELSE {"finish"}, {})

Clear ==
  /\ status \in Statuses
  /\ status' = "idle"
  /\ waitingApproval' = {}
  /\ dispatched' = {}
  /\ authorized' = {}
  /\ RecordStep("clear", {}, {})

MessagesReplaced ==
  /\ status \in {"idle", "thinking", "executing_tools", "done", "error"}
  /\ UNCHANGED <<status, waitingApproval, dispatched, authorized>>
  /\ RecordStep("messages_replaced", {}, {})

ApprovalModeChanged ==
  /\ status \in Statuses
  /\ UNCHANGED <<status, waitingApproval, dispatched, authorized>>
  /\ RecordStep("approval_mode_changed", {}, {})

CwdChanged ==
  /\ status \in {"idle", "done"}
  /\ UNCHANGED <<status, waitingApproval, dispatched, authorized>>
  /\ RecordStep("cwd_changed", {}, {})

Ignored(event) ==
  /\ event \in EventKinds \ LegalEvents(status)
  /\ UNCHANGED <<status, waitingApproval, dispatched, authorized>>
  /\ RecordStep(event, {}, {})

LlmCompletes ==
  LlmPlain
  \/ LlmError
  \/ \E call \in Calls: LlmSafeTool(call) \/ LlmGuardedTool(call)

ApprovalCompletes ==
  \E call \in Calls: Approve(call) \/ Reject(call)

ToolCompletes ==
  \E call \in Calls: ToolResult(call)

Next ==
  UserMessage
  \/ LlmCompletes
  \/ ApprovalCompletes
  \/ ToolCompletes
  \/ RejectedAwaitingToolResult
  \/ Cancel
  \/ Clear
  \/ MessagesReplaced
  \/ ApprovalModeChanged
  \/ CwdChanged
  \/ \E event \in EventKinds: Ignored(event)

Spec ==
  /\ Init
  /\ [][Next]_vars
  /\ WF_vars(LlmCompletes)
  /\ WF_vars(ApprovalCompletes)
  /\ WF_vars(ToolCompletes)

TypeOK ==
  /\ status \in Statuses
  /\ waitingApproval \subseteq Calls
  /\ dispatched \subseteq Calls
  /\ authorized \subseteq Calls
  /\ cursorParity \in BOOLEAN
  /\ lastEvent \in EventKinds \cup {"none"}
  /\ effects \subseteq EffectKinds
  /\ effectCalls \subseteq Calls

PendingConsistency ==
  /\ waitingApproval \cap dispatched = {}
  /\ status = "awaiting_approval" => waitingApproval # {}
  /\ status = "executing_tools" => dispatched # {}
  /\ status \notin {"awaiting_approval", "executing_tools"} =>
       waitingApproval = {} /\ dispatched = {}

ApprovalSafety ==
  "call_tool" \in effects => effectCalls \subseteq authorized

ThinkingProgress ==
  status = "thinking" ~> status # "thinking"

ApprovalProgress ==
  status = "awaiting_approval" ~> status # "awaiting_approval"

ToolProgress ==
  status = "executing_tools" ~> status # "executing_tools"

=============================================================================
