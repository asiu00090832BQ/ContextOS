---
name: Cross-agent data sharing in runEngine
description: Any cross-agent hand-off inside a run must go through the context broker (shared_context_grant), never via prompt embedding.
---

# Cross-agent sharing must use the broker, not the prompt

When one agent in a run needs another agent's output (e.g. the QA/verifier
agent reviewing a coding agent's work), share it by inserting a
`shared_context_grant` (fromAgentId=producer, toAgentId=consumer, mode
`shared_full`, capped `maxSensitivity`) and running the consumer under a
`brokered` context policy. Do NOT splice the producer's raw output into the
consumer's task/prompt string.

**Why:** `runAgent`'s context assembly is the single isolation chokepoint —
it enforces per-relationship sensitivity ceilings, drops redacted material, and
an independent invariant re-checks the result. Embedding output directly is an
out-of-band channel that bypasses all of it; a code review will flag it as a
cross-agent data-leak (it did, for the QA wiring).

**How to apply:** producer output is already persisted as a context fragment
(`ownerAgentId = agentId`). Insert a grant scoped to the producer (leave
`fragmentIds` null to cover all its run fragments), then call the consumer's
`runAgent` with `contextPolicy: "brokered"`. Verify via the consumer's
`context.scoped` event ("N visible, M withheld") and a zero count of
`security.isolation_violation` events. A grant is ignored under an `isolated`
policy, so the consumer must be `brokered` (or broader) for it to take effect.
