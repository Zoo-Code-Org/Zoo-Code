# Run-state kernel issues

## Purpose

This file holds the GitHub issues to build the run-state kernel from [task-lifecycle-target-architecture.md](./task-lifecycle-target-architecture.md). One parent issue owns the work. Each child is a sub-issue of 1 SP. Copy each body into a GitHub issue.

Code references: line numbers are at commit `fadd66a34` (`main`, 2026-09-25). Symbol names stay valid after later edits. Line numbers can drift.

## GitHub issues

Created on 2026-09-26. The epic is a sub-issue of #1688. The children are sub-issues of the epic, in dependency order, with native blocked-by links. RSK-03 is the existing #374, whose parent is #359, so it is related, not a sub-issue.

| Ticket | Issue | Title                                                    |
| ------ | ----- | -------------------------------------------------------- |
| Epic   | #1790 | `[lifecycle-RSK]` Run-state kernel, under #1688          |
| RSK-01 | #1791 | Add the pure run-state kernel module                     |
| RSK-02 | #1792 | Extend the bounded model-check to the kernel             |
| RSK-03 | #374  | DispatchState machine refactor                           |
| RSK-12 | #1793 | Remove the dead isPaused field                           |
| RSK-19 | #1802 | Keep the first abort reason                              |
| RSK-20 | #1803 | Check abort before an ask posts                          |
| RSK-04 | #1794 | Add the run field, write helpers, and the projection     |
| RSK-05 | #1795 | Add the divergence comparison and a metric               |
| RSK-06 | #1796 | Route latch and phase writes through events              |
| RSK-07 | #1797 | Flip abort and abortReason reads                         |
| RSK-08 | #1798 | Flip abandoned reads                                     |
| RSK-11 | #1799 | Flip isInitialized reads                                 |
| RSK-09 | #1800 | Add the turn sub-machine                                 |
| RSK-17 | #1801 | Reset didFinishAbortingStream for each request           |
| RSK-10 | #1804 | Route stream, ask, and turn-field writes through events  |
| RSK-16 | #1805 | Flip stream and turn-field reads                         |
| RSK-13 | #1806 | Wrap run state in a task actor with a serialized mailbox |
| RSK-14 | #1807 | Route the provider through actor messages                |
| RSK-15 | #1808 | Add the RunState to persisted-status consistency check   |

## Scope

In scope: the in-memory run-state kernel. It replaces the run-state fields on `Task` with orthogonal regions (phase, stream, ask), latches, a turn sub-machine, a pure transition function, and derived getters. It uses shadow-then-strangle migration. It also fixes three code races that block the migration (RSK-17, RSK-19, RSK-20). The maintainer product requirements PR-1 to PR-8 in the design doc set the target behavior.

Out of scope:

1. Persisted ownership and generation (P1) and crash recovery (P2). These carry the data-loss risk. They stay a separate program.
2. Tool-call identity and approval correlation (`LIFE-GAP-036`, `037`, `038`). These are P4 and P5 identity work. The kernel stores `toolCallId` and `approvalId` as optional opaque strings. P4-010 guards detached writes with the kernel `generation`, so it depends on RSK-10.
3. Queued user input. The queued-input bugs come from `Task#ask`, not from run state.
4. Concurrent sibling fan-out.

## Decisions

1. Use orthogonal regions of discriminated unions and a pure reducer. Do not add xstate.
2. Keep the persisted reducers (`src/core/task-persistence/taskLifecycle.ts`) unchanged. The kernel is a separate in-memory submodel (`task-lifecycle-model.md`, Extending the model).
3. Model `abort`, `abandoned`, `disposed`, and `reason` as latches. Latches never return to false within one instance. `didFinishAbortingStream` is not a latch. It lives on the live stream as `cleanupFinished`, so every instance gets the same cancel timing (PR-2).
4. The kernel always runs from RSK-04. Only the divergence comparison is gated.
5. Route every write of a field through a write helper before any read of that field flips. The helper sets the field and drives the event. The field stays authoritative until its read flip.
6. There is no runtime kill switch after a read flip. Rollback of a flip is a revert of that flip PR. Each flip PR covers one field family, so a revert stays small.
7. The design doc "Known code races" table is the only ignore list for the comparison. Each entry names its fix ticket or its reason to allow.

## Rollout gate

The divergence comparison runs when one of these conditions is true:

1. `process.env.PKG_RELEASE_CHANNEL === "prerelease"`. `src/esbuild.mjs:50` defines this value, and the nightly workflow sets it (`.github/workflows/nightly-publish.yml:80, 89`).
2. `contextProxy.extensionMode` is `vscode.ExtensionMode.Development` or `vscode.ExtensionMode.Test`. `ClineProvider.ts:1046` checks `Development` in the same style. No non-test file in `src` checks `Production` today.

Do not add a new define. Do not add a user setting. The gate controls only the comparison and its log. It never controls the kernel computation or the read source, so a read never sees an inert kernel.

## Grounding: existing issues to reuse

The lifecycle epics already exist. Link the new parent under the umbrella. Relate #374, do not reparent it.

| Existing issue                                          | Relationship                                                                                               |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| #1688 [Umbrella] Task lifecycle gap remediation         | Parent of the new run-state-kernel epic.                                                                   |
| #374 [Story 4.2a] `DispatchState` machine refactor      | Do the RSK-03 work here. #374 has parent #359 and depends on #373. GitHub allows one parent, so relate it. |
| #1696 [lifecycle-P8] Verification and traceability      | RSK-02 extends this platform. Cross-link.                                                                  |
| #1691 [lifecycle-P3] Schema, path, and vocabulary       | RSK-15 depends on the P3 persisted-status type. Cross-link.                                                |
| #1689 [lifecycle-P1] Persisted ownership and generation | Out of scope here. The kernel does not touch it.                                                           |
| #1692 [lifecycle-P4], #1693 [lifecycle-P5]              | Own the identity work that the kernel stores as optional opaque strings.                                   |

Bugs near this work. Reference these, do not close them:

| Bug                                                        | Relationship                                                                                                   |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| #1308, #1574, #1170 (queued input becomes a tool approval) | Out of scope. The fix is in `Task#ask` (`Task.ts:1462, 1647, 1661`). Do not mark these `Fixes`.                |
| #325 (duplicated render state)                             | RSK-03 `DispatchState` addresses it.                                                                           |
| #1714 (replay of a rejected pending subtask)               | Out of scope. LIFE-BLK-P1-012 owns the pending-action replay and settlement contract, and #1726 fixes the bug. |
| #1469 (cross-window stale completion)                      | Out of scope. LIFE-BLK-P1-001 owns it, under #1689.                                                            |
| Race R-1: stale `didFinishAbortingStream`                  | New bug. RSK-17 files and fixes it (PR-2).                                                                     |
| Race R-4: `streaming_failed` overwrites `user_cancelled`   | New bug. RSK-19 files and fixes it (PR-3).                                                                     |
| Race R-3: an ask row posts after abort                     | New bug. RSK-20 files and fixes it (PR-8).                                                                     |
| #998 (commands run without approval, or the task hangs)    | Related to RSK-10. The `askTs` identity that RSK-10 wires is the key the #998 fix needs (PR-6).                |

## Follow-up issues outside this epic

The product requirements create these issues. They are not RSK tickets, because they do not change run state.

| Requirement    | Issue to file                                                                                                                                                                                            | Owner                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| PR-1           | Record the cancelled request row, its tokens, and its cost on a user cancel, without a wait for the stream.                                                                                              | New bug                                             |
| PR-4           | `LIFE-GAP-039`: continuing a completed task keeps the persisted status `completed`.                                                                                                                      | LIFE-BLK-P1-039 (#1689)                             |
| PR-5           | Add the teardown cause to the `TaskAborted` payload.                                                                                                                                                     | P6 (#1694)                                          |
| PR-6           | Tie each ask response to its `askTs`, and return an explicit tool result for a superseded approval.                                                                                                      | P5 (#1693), with #998                               |
| `LIFE-GAP-002` | Split the lifecycle fields out of the per-message save (`Task.ts:1377-1411`). The save writes `rootTaskId` and `parentTaskId` every time, so a late save restores abandoned lineage.                     | P1 implementation issue for LIFE-BLK-P1-002 (#1689) |
| Speed          | Deferred to a separate speed epic: batch the per-chunk webview `messageUpdated` post (#1343), add gated and sampled speed metrics, and write messages incrementally instead of rewriting the whole file. | Not planned yet                                     |

`LIFE-GAP-039` is in the gap report register, and LIFE-BLK-P1-039 owns it in the remediation blocks.

## Parent issue: `[lifecycle-RSK]` Run-state kernel

Parent: #1688
Assignee: @edelauna
Size: epic

### Context

`Task` models run state with 11 run fields and 2 dispatch locks. The fields overlap in time: an ask can be pending while a stream is live or after it ends, and the abort latches stay set across both. The type system cannot tell a legal combination from an illegal one. The fix is orthogonal regions, latches, a pure transition function, derived getters, and an actor per task. This epic builds the kernel with shadow-then-strangle migration. It does not change the persisted reducers.

### Sub-issues

Listed in dependency order.

- [ ] RSK-01 Add the pure run-state kernel module
- [ ] RSK-02 Extend the bounded model-check to the kernel
- [ ] RSK-03 DispatchState machine refactor (relate #374)
- [ ] RSK-12 Remove the dead isPaused field
- [ ] RSK-19 Keep the first abort reason
- [ ] RSK-20 Check abort before an ask posts
- [ ] RSK-04 Add the run field, write helpers, and the projection
- [ ] RSK-05 Add the divergence comparison and a metric
- [ ] RSK-06 Route latch and phase writes through events
- [ ] RSK-07 Flip abort and abortReason reads
- [ ] RSK-08 Flip abandoned reads
- [ ] RSK-11 Flip isInitialized reads
- [ ] RSK-09 Add the turn sub-machine
- [ ] RSK-17 Reset didFinishAbortingStream for each request
- [ ] RSK-10 Route stream, ask, and turn-field writes through events
- [ ] RSK-16 Flip stream and turn-field reads
- [ ] RSK-13 Wrap run state in a task actor with a serialized mailbox
- [ ] RSK-14 Route the provider through actor messages
- [ ] RSK-15 Add the RunState to persisted-status consistency check

Withdrawn number: RSK-18 is not used.

- RSK-18 would have checked `abort` again before a stream starts. That early throw skips the chunk-loop catch, which marks the `api_req_started` row cancelled and sets the reason. The kernel allows race R-2 instead, and the request guard (`Task.ts:4615`) stops the model call.

### Grounding: current field surface

Counts are Task-owned references in `src` at the audited commit. Tests and comment lines are excluded. The `abort` count excludes `.abort()` method calls on controllers and processes. The `isInitialized` count excludes 6 references on other classes. Route the writes before you flip the reads.

| Field                                      | Writes | Reads | Home                     | Writes routed | Reads flipped |
| ------------------------------------------ | ------ | ----- | ------------------------ | ------------- | ------------- |
| `abort`                                    | 3      | 41    | `latches.abort`          | RSK-06        | RSK-07        |
| `abortReason`                              | 4      | 4     | `latches.reason`         | RSK-06        | RSK-07        |
| `abandoned`                                | 3      | 22    | `latches.abandoned`      | RSK-06        | RSK-08        |
| `isInitialized`                            | 4      | 3     | `phase`                  | RSK-06        | RSK-11        |
| `didFinishAbortingStream`                  | 2      | 1     | `stream.cleanupFinished` | RSK-10        | RSK-16        |
| `isStreaming`                              | 3      | 2     | `stream`                 | RSK-10        | RSK-16        |
| `isWaitingForFirstChunk`                   | 4      | 1     | turn sub-machine         | RSK-10        | RSK-16        |
| `didRejectTool`                            | 10     | 6     | turn sub-machine         | RSK-10        | RSK-16        |
| `didAlreadyUseTool`                        | 2      | 3     | turn sub-machine         | RSK-10        | RSK-16        |
| `didToolFailInCurrentTurn`                 | 54     | 1     | turn sub-machine         | RSK-10        | RSK-16        |
| `didCompleteReadingStream`                 | 2      | 2     | turn sub-machine         | RSK-10        | RSK-16        |
| `presentAssistantMessageLocked`            | 5      | 1     | `DispatchState`          | RSK-03        | RSK-03        |
| `presentAssistantMessageHasPendingUpdates` | 3      | 1     | `DispatchState`          | RSK-03        | RSK-03        |
| `isPaused`                                 | 0      | 1     | remove                   | none          | RSK-12        |

---

## RSK-01: Add the pure run-state kernel module

Parent: `[lifecycle-RSK]`
Depends on: none
Size: 1 SP
Labels: enhancement

### Context

The run-state fields admit illegal combinations, and they overlap in time. Orthogonal regions and latches represent the overlap. This issue adds the module alone. It wires nothing.

### Developer Notes

- [ ] Add `src/core/task/run-state/runState.ts`.
- [ ] Define `Phase`, `Stream`, `Ask`, `Latches`, `RunState` (with `lastCompletionAskTs`), `RunEvent`, `AbortReason`, and `Transition` from the design doc. `AbortReason` is `ClineApiReqCancelReason`.
- [ ] Implement `nextRunState(state, event): Transition` from the guard and effect table. Keep it pure. Return `{ rejected: state }` when a guard fails.
- [ ] Implement the getters: `abort`, `abandoned`, `abortReason`, `didFinishAbortingStream`, `isStreaming`, `isInitialized`.
- [ ] Add unit tests for every event on its guard edge, every getter, each observed flow in the design doc, and a superseded ask.
- [ ] Update `AGENTS.md` to name the run-state submodel and its location.

Exit criteria: the module compiles, tests pass, no production code imports it.

Reversibility: the module is dead code until a later issue imports it.

---

## RSK-02: Extend the bounded model-check to the kernel

Parent: `[lifecycle-RSK]`
Depends on: RSK-01
Cross-link: #1696
Size: 1 SP
Labels: enhancement

### Context

The persisted reducers have a bounded model-check in CI. The kernel is a new checked submodel. It must join the suite under the same contract so an illegal state cannot regress.

### Developer Notes

- [ ] Add `scripts/check-run-state-kernel.ts` beside the existing checkers.
- [ ] Assert the invariants from the design doc in every reachable state.
- [ ] On a violation, print the shortest counterexample trace (`task-lifecycle-model.md`, introduction).
- [ ] Meet the suite contract (`scripts/check-task-lifecycle.ts:25-27, 228-252`): reachability of every event, named landmarks, a declared state budget, unseen-successor detection, and interleaved event sources.
- [ ] Add landmarks for: abort during a pending approval inside a live stream, an ask after the stream ends, abandon after the stream ends, dispose after completion, a stream failure cleanup followed by a new stream, and resume that starts a stream without user input.
- [ ] Require the stale `askSettled` no-op after a superseded ask as a reachable action with its own action name, for example `askSettledStale`. It leaves the state unchanged, so it cannot be a state landmark, and the checker keys action reachability by the name before `(`.
- [ ] Record the boundary mapping to the cleanup model from the design doc. Do not re-prove abort and dispose settlement.
- [ ] Add the checker to `pnpm lifecycle:model-check`.

Exit criteria: `pnpm lifecycle:model-check` runs the kernel checker in CI and passes the full contract.

Reversibility: the checker is additive.

---

## RSK-03: DispatchState machine refactor

Parent: #359 (existing). Relate to `[lifecycle-RSK]`.
Depends on: #373
Size: 1 SP
Labels: enhancement

Do the work in issue #374. Do not reparent it.

### Context

Dispatch re-entrancy uses `presentAssistantMessageLocked` and `presentAssistantMessageHasPendingUpdates`. They model a small lock, not run state. This is an independent track. No RSK ticket depends on it, because the kernel does not use `DispatchState`. It addresses #325.

Risk: #373 is open and unassigned under Epic 4 (Parallel Tool Execution). Name an owner for #373 before this ticket starts.

### Developer Notes

- [ ] Land #373 first if it is still open.
- [ ] Follow the #374 body for the `pendingWork` field and its three named tests.
- [ ] Add a `DispatchState = "idle" | "serial" | "parallel"` region. `parallel` means intra-task message dispatch, not sibling fan-out.
- [ ] Replace the two booleans with the region. Keep the observable behavior the same.

Exit criteria: no behavior change, both booleans deleted, tests pass.

Reversibility: behavior-preserving.

---

## RSK-12: Remove the dead isPaused field

Parent: `[lifecycle-RSK]`
Depends on: none
Size: 1 SP
Labels: tech-debt

### Context

`isPaused` (`Task.ts:345`) is declared and read at `Task.ts:4086`. No code in `src` sets it to true. The read is always false.

### Developer Notes

- [ ] Confirm no assignment sets `Task.isPaused` to true in `src`.
- [ ] Remove the field and the always-false read at `Task.ts:4086`. Simplify the branch.
- [ ] Remove the stale `isPaused` references in `newTaskTool.spec.ts:94, 138, 596` and `new-task-delegation.spec.ts:35`.

Exit criteria: the field is gone, tests pass.

Reversibility: small deletion.

---

## RSK-04: Add the run field, write helpers, and the projection

Parent: `[lifecycle-RSK]`
Depends on: RSK-01
Size: 1 SP
Labels: enhancement

### Context

A direct swap is unsafe. The fields are read across `src`. The safe path runs the kernel beside the fields. The fields stay authoritative. This issue adds the parts that later issues use. It changes no behavior.

### Developer Notes

- [ ] Add a `run: RunState` field to `Task`. It always runs. It is not gated.
- [ ] Add the write-helper pattern: one method per event that sets the old field and drives the event into `nextRunState`. Keep the field authoritative.
- [ ] If the kernel rejects an event that the code applies, keep the field write. Record the rejection for RSK-05.
- [ ] Add the projection: a pure function from the current field values to the expected `RunState`. RSK-05 compares against it.
- [ ] Do not read `run` for control flow.

Exit criteria: the helpers and the projection exist and are unit-tested. No write site uses them yet. Behavior is unchanged.

Reversibility: additive.

---

## RSK-05: Add the divergence comparison and a metric

Parent: `[lifecycle-RSK]`
Depends on: RSK-04
Size: 1 SP
Labels: enhancement

### Context

Shadow mode must report disagreement. Before any read flips, the kernel must agree with the fields on real traffic. A rejected event is also a divergence, because after a flip the kernel would drop that write. Some windows in the code are known races. The design doc lists them under "Known code races".

### Developer Notes

- [ ] After each helper call, compare `run` with the projection from RSK-04, for the routed fields only. A field whose writes are not routed yet gets no events, so a comparison of it reports a false mismatch. Keep the routed fields in one list that each routing ticket extends: RSK-06 adds the latches and `phase`, and RSK-10 adds the stream, ask, and turn regions.
- [ ] Log each mismatch and each rejected event with the state, the event, the field values, and `taskId`.
- [ ] Tag each mismatch with a race ID when it matches a known window. Count tagged and untagged mismatches as separate metrics.
- [ ] Load the ignore list from the known-races table. An entry with a fix ticket stays in the list only until that ticket merges. R-1 stays until RSK-17 merges. R-3 stays until RSK-20 merges. R-4 stays until RSK-19 merges.
- [ ] Gate the comparison as described in the Rollout gate section. Do not gate the kernel.
- [ ] Do not throw on divergence in production. Log only.

Exit criteria: a forced divergence in a test produces one log line and one metric increment. A forced divergence on a known race that still has an open fix ticket produces a tagged mismatch, not an untagged one.

Reversibility: additive observability.

---

## RSK-06: Route latch and phase writes through events

Parent: `[lifecycle-RSK]`
Depends on: RSK-04
Size: 1 SP
Labels: enhancement

### Context

The abort path carries the highest bug value. Every writer of a latch field must go through a helper before any latch read flips. This includes the external writers, so RSK-07 and RSK-08 do not break their compile.

### Developer Notes

- [ ] Route each source in the design doc "Abort sources and reasons" table through its helper.
- [ ] `cancelTask`: `reasonSet` at `ClineProvider.ts:3572`, `abortRequested(false)` through `abortTask()`, then `abandonRequested` at `:3588`. Keep this order for issue #560.
- [ ] `abortTask(isAbandoned)` (`Task.ts:2680-2687`): `abortRequested(isAbandoned)`. This covers `removeClineFromStack` (`ClineProvider.ts:631`), `createTaskWithHistoryItem` (`ClineProvider.ts:1389`), and the checkpoint-restore delete (`checkpointRestoreHandler.ts:34`, abandoned false).
- [ ] `disposeOnce` (`Task.ts:2770`): `disposeRequested`. It must not change `reason`.
- [ ] Chunk-loop catch (`Task.ts:3718`): `reasonSet(cancelReason)`, then `abortRequested(false)`. Retry backoff (`Task.ts:3738`): `reasonSet("user_cancelled")`, then `abortRequested(false)`.
- [ ] `resumeAfterDelegation` resets (`Task.ts:2881-2883`): confirm the instance is always new, then delete the three latch resets. A reset has no event. RSK-10 owns the resets at `:2884-2886`.
- [ ] Do not fix race R-4 here. RSK-19 owns it.
- [ ] Route the four `isInitialized` writes through the `initialized` helper (`Task.ts:2266, 2391, 2412, 2892`). Each instance takes one of these paths. RSK-11 flips the reads after these writes have soaked on nightly.
- [ ] Confirm the comparison shows zero untagged divergence and zero untagged rejections on these paths.

Exit criteria: every latch write, and every `isInitialized` write, goes through a helper in `Task`, `ClineProvider`, and `checkpointRestoreHandler`. The fields stay authoritative. Tests pass.

Reversibility: reads are unchanged, so behavior is unchanged.

---

## RSK-07: Flip abort and abortReason reads

Parent: `[lifecycle-RSK]`
Depends on: RSK-06, RSK-05, RSK-19
Size: 1 SP
Labels: enhancement

### Context

With writes routed and the comparison clean, these reads move to the latch getters. `abort` must stay true after the stream ends and after disposal. The run loop is `while (!this.abort)` (`Task.ts:2953`), and guards read it after the abort (`TaskScheduler.ts:34`, `TaskRegistry.ts:67, 73`, `ClineProvider.ts:4388`, `presentAssistantMessage.ts:88`, `Task.ts:1654`).

### Developer Notes

- [ ] Precondition: the comparison shows zero untagged divergence and zero untagged rejections for latch events on nightly.
- [ ] Add getters that read `latches.abort` and `latches.reason`.
- [ ] Flip the 41 `abort` reads and the 4 `abortReason` reads.
- [ ] Delete the two fields and remove their writes from the helpers.

Exit criteria: no direct reads remain. Tests and E2E pass. The run loop and the latched guards still work.

Reversibility: revert this PR. The helpers restore the fields.

---

## RSK-08: Flip abandoned reads

Parent: `[lifecycle-RSK]`
Depends on: RSK-06, RSK-05
Size: 1 SP
Labels: enhancement

### Context

`abandoned` has 22 reads. It marks an instance that no one waits for. It latches in any phase after `abort`, including after the stream ends.

### Developer Notes

- [ ] Precondition: the comparison shows zero untagged divergence and zero untagged rejections for `abandonRequested` on nightly.
- [ ] Add a getter that reads `latches.abandoned`.
- [ ] Flip the 22 reads, including `ClineProvider.ts:1153` and `TaskRegistry.ts:67, 73`.
- [ ] Delete the field and remove its write from the helpers.

Exit criteria: no direct reads remain. Tests and E2E pass.

Reversibility: revert this PR.

---

## RSK-11: Flip isInitialized reads

Parent: `[lifecycle-RSK]`
Depends on: RSK-06, RSK-05
Size: 1 SP
Labels: enhancement

### Context

`isInitialized` maps to `phase`. RSK-06 routes its four writes (`Task.ts:2266, 2391, 2412, 2892`), so nightly data exists before this flip. The three reads are external (`checkpointRestoreHandler.ts:96`, `webviewMessageHandler.ts:1586, 1624`).

### Developer Notes

- [ ] Precondition: the comparison shows no rejected `initialized` event on nightly.
- [ ] Add a getter that returns `phase !== "uninitialized"`.
- [ ] Flip the three external reads.
- [ ] Delete the field and remove its write from the helpers.

Exit criteria: no direct reads remain. Tests pass.

Reversibility: revert this PR.

---

## RSK-09: Add the turn sub-machine

Parent: `[lifecycle-RSK]`
Depends on: RSK-01
Size: 1 SP
Labels: enhancement

### Context

Five fields are within-turn bookkeeping: `isWaitingForFirstChunk`, `didRejectTool`, `didAlreadyUseTool`, `didToolFailInCurrentTurn`, `didCompleteReadingStream`. A turn is one request iteration of the loop. The code writes these fields before the stream starts and after it ends (`Task.ts:3228-3245, 3768, 3810, 3830, 4029`). So the turn sub-machine is independent of the stream region.

### Developer Notes

- [ ] Add a turn state with a `turnStarted` event. The event maps to the per-request reset block (`Task.ts:3228-3245`).
- [ ] Model the five fields as the turn state. Do not tie the turn state to `stream.tag`.
- [ ] Add unit tests for the turn transitions, including tool writes after the stream ends and an abort before the first chunk.
- [ ] Do not route writes or flip reads. RSK-10 and RSK-16 do that.

Exit criteria: the turn sub-machine compiles and is tested. Nothing is wired.

Reversibility: additive.

---

## RSK-17: Reset didFinishAbortingStream for each request

Parent: `[lifecycle-RSK]`
Depends on: none
Size: 1 SP
Labels: bug

### Context

This is race R-1 and requirement PR-2. A stream failure without abort calls `abortStream("streaming_failed")` (`Task.ts:3714`). That sets `didFinishAbortingStream = true` (`Task.ts:3225`). The per-request reset block (`Task.ts:3228-3245`) does not reset the field. Only `resumeAfterDelegation` resets it (`Task.ts:2884`).

So today an instance with an earlier failure skips the `cancelTask` wait (`ClineProvider.ts:3594`), and every other instance waits. After the skipped wait, the old loop can still save messages after the rebuild, because `saveClineMessages` has no abandoned guard (`Task.ts:1376`).

Behavior change: after the fix, every instance waits the same way. The wait usually lasts milliseconds, because `cancelTask` cancels the HTTP request first (`ClineProvider.ts:3579`). It lasts up to 3 seconds only for a hung stream.

### Developer Notes

- [ ] File the bug and link it here.
- [ ] Add `this.didFinishAbortingStream = false` to the per-request reset block.
- [ ] Add a regression test at the lowest layer that fails today: a stream failure, then a new request, then a cancel. The cancel must wait until the new stream ends, the first-chunk state holds, or 3 seconds pass. It must not exit at once.

Exit criteria: the field resets for each request. The regression test passes. The R-1 entry leaves the ignore list.

Reversibility: revert this PR. The change is one line.

---

## RSK-19: Keep the first abort reason

Parent: `[lifecycle-RSK]`
Depends on: none
Size: 1 SP
Labels: bug

### Context

This is race R-4 and requirement PR-3. The chunk-loop catch computes the reason while `abort` is false (`Task.ts:3706`). It then awaits the failure cleanup (`Task.ts:3714`). If a cancel lands during that await, `Task.ts:3718` writes `streaming_failed` over `user_cancelled`. The `onTaskAborted` rehydrate branch (`ClineProvider.ts:423`) can then run in addition to the `cancelTask` rehydrate.

### Developer Notes

- [ ] File the bug and link it here.
- [ ] Change `Task.ts:3718` to `this.abortReason ??= "user_cancelled"`.
- [ ] Confirm that no other code writes `"streaming_failed"` to `abortReason`. Then delete the rehydrate branch at `ClineProvider.ts:423`. #8171 added that branch. #8794 changed stream failures to retry instead of abort, which left race R-4 as its only path.
- [ ] Add a regression test: a stream error, then a cancel during the cleanup await. The reason must stay `user_cancelled`, and only one rehydrate must run.

Exit criteria: the first reason wins. The dead branch is gone. The R-4 entry leaves the ignore list.

Reversibility: revert this PR.

---

## RSK-20: Check abort before an ask posts

Parent: `[lifecycle-RSK]`
Depends on: none
Size: 1 SP
Labels: bug

### Context

This is race R-3 and requirement PR-8. `Task#ask` checks `abort` only at entry (`Task.ts:1447`). It then awaits `getState` and `checkAutoApproval` (`Task.ts:1460, 1470`) and adds the ask row without a second check (`Task.ts:1505, 1551, 1569`). An abort in that window adds a row that no one can answer, and then the ask throws.

### Developer Notes

- [ ] File the bug and link it here.
- [ ] Check `abort` right before each branch sets `lastMessageTs` (`Task.ts:1504, 1529, 1550, 1568`). Throw the same error as `Task.ts:1448`, and release the queued message first, as the abort exit does (`Task.ts:1676-1679`).
- [ ] Add a regression test: an abort during the `checkAutoApproval` await must not add an ask row.

Exit criteria: no ask row posts after abort. The R-3 entry leaves the ignore list.

Reversibility: revert this PR.

---

## RSK-10: Route stream, ask, and turn-field writes through events

Parent: `[lifecycle-RSK]`
Depends on: RSK-09, RSK-04, RSK-20
Size: 1 SP (split if it grows)
Labels: enhancement

### Context

The stream and ask regions and the turn fields need their writes routed before RSK-16 flips their reads. `didToolFailInCurrentTurn` alone has 54 writes in `src/core/tools`, so this may exceed 1 SP.

### Developer Notes

- [ ] `streamStarted` where the stream starts (`Task.ts:3269`). `streamEnded` in the `finally` block (`Task.ts:3756`).
- [ ] `streamCleanupFinished` in `abortStream`, where it sets `didFinishAbortingStream` (`Task.ts:3225`).
- [ ] `turnStarted` at the per-request reset block (`Task.ts:3228-3245`).
- [ ] `askStarted` in `Task#ask` where a blocking ask sets `lastMessageTs` (`Task.ts:1529, 1550, 1568`), after the abort check from RSK-20. Carry that `askTs`. This is the ask identity that the #998 fix needs (PR-6). Do not drive it for a partial ask, which throws at once (`Task.ts:1499, 1507`).
- [ ] `askSettled` with the same `askTs` in a `finally` block, so every blocking exit drives it: the abort throw (`Task.ts:1679`), the superseded throw (`Task.ts:1689`), and the return (`Task.ts:1714`). A stale `askTs` is a no-op (race R-6).
- [ ] `completionAccepted` on the accept path in `AttemptCompletionTool.ts`. Pass the `askTs` of the completion ask. `Task#ask` does not return `askTs` today, so add it to the result object that `ask` returns as an optional field. Existing callers (about 40 call sites in 22 files, the 3 result types in `AutoApprovalHandler.ts`, and the test mocks) need no change, because they ignore the new field. Drive `completionAccepted` right after `ask` returns, before any other await. That ask has already settled, so the guard reads `lastCompletionAskTs`, not the ask region.
- [ ] Route the turn-field writes: `isWaitingForFirstChunk` (4), `didRejectTool` (10), `didAlreadyUseTool` (2), `didToolFailInCurrentTurn` (54), and `didCompleteReadingStream` (2).
- [ ] `resumeAfterDelegation` resets (`Task.ts:2884-2886`): delete them. The new instance already has the defaults.
- [ ] If the change exceeds 1 SP, split per region and keep this issue as the tracker.
- [ ] Confirm the comparison shows zero untagged divergence and zero untagged rejections on nightly.

Exit criteria: every stream, ask, and turn-field write goes through a helper. The fields stay authoritative. Tests pass.

Reversibility: reads are unchanged, so behavior is unchanged.

---

## RSK-16: Flip stream and turn-field reads

Parent: `[lifecycle-RSK]`
Depends on: RSK-10, RSK-05, RSK-17
Size: 1 SP
Labels: enhancement

### Context

With writes routed, race R-1 fixed, and the comparison clean, the stream and turn reads move to the kernel. `isStreaming` must stay true until `streamEnded`. An abandon must not clear it, so `cancelTask` still waits for the old stream loop (`ClineProvider.ts:3589-3600`).

### Developer Notes

- [ ] Precondition: RSK-17 merged. The comparison shows zero divergence for the stream region and the turn fields on nightly, with an empty ignore list for them.
- [ ] Add getters for `isStreaming` (`stream.tag === "live"`) and `didFinishAbortingStream` (`stream.tag === "live"` and `stream.cleanupFinished`).
- [ ] Flip the reads of `isStreaming` (2), `didFinishAbortingStream` (1), `isWaitingForFirstChunk` (1), `didRejectTool` (6), `didAlreadyUseTool` (3), `didToolFailInCurrentTurn` (1), and `didCompleteReadingStream` (2).
- [ ] Delete the seven fields and remove their writes from the helpers.

Exit criteria: no direct reads remain. Tests and E2E pass.

Reversibility: revert this PR.

---

## RSK-13: Wrap run state in a task actor with a serialized mailbox

Parent: `[lifecycle-RSK]`
Depends on: RSK-07, RSK-08, RSK-11, RSK-16, RSK-19, RSK-20
Size: 1 SP
Labels: enhancement

### Context

The real hazard is interleaving between await points, not concurrent mutation. The extension host is single-threaded. The actor is a serialized mailbox that processes one event at a time.

### Developer Notes

- [ ] Precondition: RSK-07, RSK-08, RSK-11, and RSK-16 merged, so the kernel is the only run-state source.
- [ ] Replace the write helpers with a mailbox on `Task`: accept a `RunEvent`, apply `nextRunState`, keep `ok`, report `rejected`.
- [ ] State the rule: an await inside a handler does not hold the mailbox. Re-read state after each await.
- [ ] Reuse the `runDelegationTransition` queue (`ClineProvider.ts:148-172`) and the `abortPromise ??=` guard (`Task.ts:2687`). Do not add a new lock.
- [ ] A rejected event must not mutate state.
- [ ] Log each accepted and rejected transition with `taskId` and `generation`.

Exit criteria: internal callers drive run state through the mailbox. Tests pass.

Reversibility: internal to `Task`.

---

## RSK-14: Route the provider through actor messages

Parent: `[lifecycle-RSK]`
Depends on: RSK-13
Size: 1 SP (split if it grows)
Labels: enhancement

### Context

After RSK-13, `ClineProvider` and `checkpointRestoreHandler` still write run state through `Task` methods and the two direct writes at `ClineProvider.ts:3572, 3588`. This issue makes them send mailbox messages directly.

### Developer Notes

- [ ] Replace the direct run-state writes and calls in `src/core/webview/ClineProvider.ts` and `checkpointRestoreHandler.ts` with mailbox messages.
- [ ] `ClineProvider.ts` is large. If the change exceeds 1 SP, split per call site and keep this issue as the tracker.
- [ ] Send the run-state view to the webview as its own small webview message when the run state changes. Do not add it to the full state post. Keep the partial-post optimizations (`ClineProvider.ts:2438-2452, 2476-2491`).
- [ ] Define the new webview message type in `packages/types` with the other `ExtensionMessage` types.
- [ ] Handle it in the webview state context (`webview-ui/src/context/ExtensionStateContext.tsx`), beside the `messageUpdated` case.
- [ ] Post the current run-state view once when the webview loads and when the focused task changes. Without that first post, a reloaded webview shows an empty view until the next transition.
- [ ] Cross-link #630. This webview message follows the delta pattern that #630 proposes for `clineMessages`. Do not implement #630 here.
- [ ] Cover the change with provider and subtask E2E tests.

Exit criteria: the provider drives run state only through the mailbox. Tests and E2E pass.

Reversibility: behavior-preserving.

---

## RSK-15: Add the RunState to persisted-status consistency check

Parent: `[lifecycle-RSK]`
Depends on: RSK-13, P3-013 (#1691)
Size: 1 SP
Labels: enhancement

### Context

The store stays the source of persisted status. The webview reads it from the store (`ClineProvider.ts:3021`). Do not derive persisted status from `RunState`. The two can disagree on purpose: a parent abandoned in memory while the disk says `delegated`, a resumed child that runs while the disk says `interrupted`, and, until LIFE-BLK-P1-039 lands, a continued completed task that runs while the disk says `completed` (`LIFE-GAP-039`). LIFE-BLK-P6-029 forbids that inference. LIFE-BLK-P3-013 owns the persisted-status type. Both are in the remediation blocks.

### Developer Notes

- [ ] Add a pure function that maps `RunState` to the set of persisted statuses it allows.
- [ ] Use it as a consistency check against the store, not as the source.
- [ ] Log a mismatch that is not an expected disagreement.
- [ ] Keep `TaskStatus` a separate projection of the ask markers.
- [ ] Add unit tests for the map and for the three expected-disagreement cases.

Exit criteria: the check runs against the store. The store stays authoritative. Tests pass.

Reversibility: additive check.
