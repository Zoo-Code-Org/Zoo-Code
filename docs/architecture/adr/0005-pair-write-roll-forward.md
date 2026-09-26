# ADR-0005: Roll forward a half-finished pair write

## Status

Proposed (2026-09-27). Decider: @edelauna, core maintainer. The P1 spec applies it in LIFE-BLK-P1-001 ([task-lifecycle-persisted-ownership-model.md](../task-lifecycle-persisted-ownership-model.md)). `LIFE-BLK-P2-004` owns the implementation.

## Context

`TaskHistoryStore.atomicUpdatePair` writes the child record first and the parent record second (`TaskHistoryStore.ts:1040-1043`). Each file has its own lock, so the pair is not atomic. If the parent write is rejected or fails, the child write has already committed.

Existing mechanisms:

- `reconcileDelegationStateCore` already rolls a delegated parent forward from a `completed` awaited child (`TaskHistoryStore.ts:478-494`). It runs only at startup (`:133`) and after migration (`:827`). It writes with `skipTransitionCheck` and has no ownership check.
- `replayDelegationRepairIntent` (`TaskHistoryStore.ts:127`) completes a two-record repair whose intent was durable.

Line references are at commit `7c291bb08`.

## Decision

The system never undoes the child write.

1. If the parent write is rejected because ownership moved, the superseded child's committed state is final. The parent keeps its newer delegation. The host logs a warning that names the child, the parent, and the parent's newer awaited child.
2. If the parent write fails for another reason, the failing host retries it at once through the normal write path, with the lock-time ownership check.
3. If the process stops before the retry, startup reconciliation is the backstop.
4. A new reconciliation rule releases a delegated parent whose awaited child no longer links back to it. This is a behavior change. Today such a parent stays delegated (`TaskHistoryStore.ts:403-407`).

## Consequences

- A superseded child's result is lost, but the warning makes the loss visible.
- A parent left delegated by the fail-closed cancel detach (`ClineProvider.ts:3638`) is released instead of waiting for a child that can never report back.
- `LIFE-BLK-P2-004` decides whether the roll-forward writes a repair intent through `replayDelegationRepairIntent`, and owns the fault-injection tests.

## Alternatives considered

- Write the parent first. Rejected. The lock-time generation check lives in the child file, so it could no longer reject before anything commits.
- Roll back the child. Rejected. The undo can fail, and another host may already have read the child.
- An operation intent log for every pair write. Deferred to the P2 program. It is the complete answer, but it is XL-sized.
