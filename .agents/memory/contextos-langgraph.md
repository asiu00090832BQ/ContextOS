---
name: ContextOS run engine on LangGraph
description: Why/how the run lifecycle is a LangGraph StateGraph, and the DB-as-checkpoint decision that resume depends on.
---

# Run engine = LangGraph StateGraph

The run lifecycle in `artifacts/api-server/src/lib/runEngine.ts` is expressed as a
LangGraph.js (`@langchain/langgraph`) `StateGraph` purely for readability. The
public entrypoints `executeRun(tenantId,runId)` / `resumeRun(tenantId,runId)` are
unchanged thin wrappers that `graph.invoke(...)` and keep the top-level
try/catch that maps any throw to run `status='failed'` + `run.failed` log.

- Execute graph nodes: loadRun → assembleContext → orchestrateAgents →
  proposeActions → (conditional) pauseForApproval | finalize. `loadRun` returns
  `{abort:true}` on missing run/intent → conditional edge to END (silent, no
  status change — matches original early-return).
- Resume graph nodes: resumeGuard (load + pending-approval guard + idempotent
  claim via conditional UPDATE on status=waiting_approval) → (conditional)
  resumeFinalize | END. Finalize-only; never replays the lifecycle.
- Node bodies wrap the EXISTING logic unchanged (contextBroker isolation,
  runAgent, MCP tool dispatch, policy bundles, all DB writes). State flows via
  bare `Annotation<T>` channels (last-value-wins); accumulators
  (totalTokens/totalCost/obsCount) are recomputed-and-returned per node — safe
  because the flow is linear.

## Why DB-as-checkpoint, NOT a LangGraph checkpointer
**Decision:** do not use an in-memory (or any) LangGraph checkpointer for the
approval pause/resume. The durable checkpoint is the database itself (run
`waiting_approval` status + already-created actions/approval requests). Resume is
modeled as a SEPARATE graph re-entry that reconstructs from the DB.
**Why:** a run starts fire-and-forget in the background and is resumed by a
different HTTP request minutes later, possibly after a process restart/deploy. An
in-memory checkpointer would lose the thread and break resume. The DB already
held all state, so DB-as-checkpoint preserves exact prior behavior with no new
persistence layer.
**How to apply:** if asked to add LangGraph interrupts/checkpointer here, push
back unless it's a durable (Postgres) checkpointer AND resume-across-restart is
re-verified.

## Reviewer trap
A diff of this file looks huge (executeRun/resumeRun fully restructured). The
builder/tool-calling loop in `runAgent` (runBuilderCompletion, BUILDER_TOOL_NAMES,
canBuildIntegrations, endpointIsLive) is PRE-EXISTING (merged "autonomous MCP
builder" work), not part of the LangGraph port. Don't "revert" it as if new.
