# ADR-0003: Attempt generation, increment at resume, and replay settlement

## Status

Proposed (2026-09-27). Decider: @edelauna, core maintainer. The P1 spec applies it in LIFE-BLK-P1-012 ([task-lifecycle-persisted-ownership-model.md](../task-lifecycle-persisted-ownership-model.md)).

## Context

A delayed completion from an earlier attempt of a child can be accepted after the child was resumed (`LIFE-GAP-012`). The persisted record has no attempt identity. `PendingTaskAction.actionId` is an approval identity, not an attempt identity.

Three facts constrain the design:

- A resumed child keeps the status `interrupted` while it runs, because `interrupted → completed` is the only legal move out of `interrupted` (`taskLifecycle.ts:9`).
- `markDelegatedChildInterrupted` skips every child that is not `active` (`ClineProvider.ts:710`). The cancel path skips a child that is already `interrupted` (`:3610`). So a stop of a resumed child, which is still `interrupted`, writes nothing.
- The webview, API, and IPC resume surfaces all reach one of two methods in `Task`: `resumeTaskFromHistory` and `resumeAfterDelegation`.
- `resumeTaskFromHistory` runs as soon as a `Task` is built from history (`Task.ts:699, 1017, 2225`), before the user answers the `resume_task` ask. So it runs when a task opens, not only when it resumes.

Line references are at commit `7c291bb08`.

## Decision

1. Add an optional persisted field, `attemptGeneration`, to the child record. A record without it is read as `g0`.
2. Increment the generation when a resumed attempt starts to act: after the `resume_task` ask returns, after a pending-action replay's approval and before its commit, before the task loop starts after a denied replay or a replay answered with feedback, and at the start of `Task.resumeAfterDelegation`. Never write the increment to a `completed` record.
3. A completion carries the generation of the attempt that produced it. A lock-time generation check in the child file's merge rejects a completion whose generation is not current.
4. A replay stamps the new generation onto its `pendingAction` at the same point as the increment. Settlement compares `(actionId, generation)`, and so does the pending-action match in `reopenParentFromDelegation`. `actionId` stays `sanitizeToolUseId(toolCallId)`.

## Consequences

- Every stop and resume cycle gets a fresh generation. A stale completion from any earlier attempt is rejected after the next resume.
- Opening or viewing a task changes nothing. Another window keeps its running attempt, and a completed record stays unchanged (model invariant 6).
- A completion that is already in flight when the user stops the child can still land before the next resume. This is accepted. Once stopped, the instance is aborted and cannot ask again.
- A downgrade reader ignores the field and does not enforce the check.
- A stale settlement from another host cannot clear a replayed action, because the generations differ.
- The lifecycle checker models the generation as current versus stale, so repeated cycles keep a finite state space.

## Alternatives considered

- Increment when the task opens. Rejected. Opening a child in a second window would fence the attempt that runs in the first window, and viewing a completed task would rewrite it.
- Increment at stop. Rejected. A second stop writes nothing, because both stop paths skip a child that is not `active`. So only the first stop fences the old attempt.
- Write a generation-only fence at every stop. Rejected. It needs a new reducer and changes to both stop paths, for a narrow gain.
- Mint a new `actionId` on replay. Rejected. It breaks the tie to the tool call that `LIFE-GAP-038` relies on.
- Accept the replay race as fail-closed. Rejected. Multi-window use is supported, and the fix is one more field in the compare-and-clear.
