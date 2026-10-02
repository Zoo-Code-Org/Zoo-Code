# Task lifecycle target architecture

## Status

- Status: Draft (proposed).
- Authors: @edelauna.
- Reviewers: unassigned. Fill before circulating.
- Last updated: 2026-09-26.
- Code references: line numbers in this document are at commit `fadd66a34` (`main`, 2026-09-25). Symbol names stay valid after later edits. Line numbers can drift.
- Summary: Replace loose boolean run-state flags and process-global tool state with a run-state kernel of orthogonal regions and an actor per task. Keep the persisted lifecycle reducers and the bounded model-check suite. Migrate step by step. Do not rewrite from scratch.

This document is the design target. It does not restate the gap report, the remediation plan, or the model-check suite. Read those:

- Gap report: [task-lifecycle-gap-report.md](./task-lifecycle-gap-report.md).
- Remediation plan: [task-lifecycle-remediation-blocks.md](./task-lifecycle-remediation-blocks.md).
- Model-check suite: [task-lifecycle-model.md](./task-lifecycle-model.md).

## Context and scope

Zoo Code runs agent tasks inside a VS Code extension. A task can delegate to a child task. The extension host owns task state. A webview renders the task to the user.

Two classes carry most task state today. `src/core/task/Task.ts` is about 5,400 lines. `src/core/webview/ClineProvider.ts` is about 4,600 lines. Task run state is a set of separate boolean flags. Some tool state is process-global. This shape allows illegal flag combinations and interleaving races between await points. Issue #325 is one observed flag-combination defect.

```
System context

  [User] --edits/approvals--> [Webview UI]
     ^                              |
     | rendered snapshot            | postMessage / onDidReceiveMessage
     v                              v
  [VS Code] <---host API---> [Extension host: ClineProvider -> Task tree]
                                    |
                                    v
                          [Per-task history files on disk]
```

In scope:

1. In-memory task run state.
2. Parent-child delegation lifecycle, persisted ownership, and generation.
3. Tool-originated state ownership (approvals, partial calls, identity).
4. Status vocabulary and webview state snapshot.
5. The verification boundary between the checked core and unchecked effects.

Out of scope:

1. A greenfield v4 extension.
2. Concurrent sibling fan-out. It stays a separate optional program (see `FANOUT-BLK-*`).
3. Provider and model catalog code.

## Problem: current-state architecture

### The two-layer split

The system has two layers.

1. The persisted lifecycle layer is checked. `src/core/task-persistence/taskLifecycle.ts` holds pure transition reducers. `VALID_TASK_STATUS_TRANSITIONS` declares the legal moves. A bounded model-check suite runs in CI and calls the production reducers.
2. The runtime layer is not checked. `Task` holds run state as separate booleans. Some tool handlers hold state in process-global singletons.

The bugs come from the runtime layer and from state that escapes the checked reducers.

### Run state is a set of loose booleans

`Task` models mutually exclusive run phases with independent flags. Examples: `abort`, `didFinishAbortingStream`, `isInitialized`, `isPaused`, `isWaitingForFirstChunk`, `isStreaming`, `didRejectTool`, `didAlreadyUseTool`, `didToolFailInCurrentTurn`, `didCompleteReadingStream`. Dispatch re-entrancy uses `presentAssistantMessageLocked` and `presentAssistantMessageHasPendingUpdates`.

N independent booleans admit 2^N representable states. Only a few are legal. The type system cannot reject the rest. Some combinations are legal phases. For example, `abort` and `isStreaming` are both true during the graceful drain window (`Task.ts:2685, 3484, 3756`). The type system cannot tell a legal combination from an illegal one. The one flag-combination defect with a source is the duplicated render state in #325.

The persisted layer does not have this problem. `VALID_TASK_STATUS_TRANSITIONS` rejects an illegal move such as `interrupted -> delegated`. Issue #1714 is an unbounded retry around that correct rejection, not an illegal state that the reducers admit.

### State ownership is spread across eleven owners

The gap report inventories eleven state owners: persisted history schema, lifecycle reducers, history store, live task, task registry, provider, scheduler/semaphore, message queue, parser scope, event surfaces, and tool-originated task state. The persisted status vocabulary (`active`, `completed`, `delegated`, `interrupted`) is separate from the runtime `TaskStatus` vocabulary (`running`, `interactive`, `resumable`, `idle`, `none`) but uses similar names. The gap report notes that registry publication can precede scheduler admission. The terms "current", "running", "active", and "persisted active" name different states.

### Tool state is not scoped by identity

Three defects share one root cause: tool state without a task or call identity.

1. Interactive todo approval edits use a process-global slot. One task can consume another task's edit (`LIFE-GAP-036`).
2. Singleton tool handlers share `lastSeenPartialPath` across calls and tasks (`LIFE-GAP-037`).
3. Tool-ID sanitization is non-injective. Distinct raw IDs can collapse to one persisted ID while execution keeps both (`LIFE-GAP-038`).

### There is no generation token

No persisted attempt or generation token separates a delayed pre-interruption completion from a valid post-resume completion of the same child (`LIFE-GAP-012`). A detached usage drain can write after abort or after a newer request starts (`LIFE-GAP-010`).

### Completion ownership is not disk-authoritative

Two hosts can hold the same task history. The completion revalidation checks status only, not the exact awaited child. A stale cross-host completion can clear a newer handoff and orphan its child (`LIFE-GAP-001`, Critical). A late message save can restore lineage that another host already abandoned (`LIFE-GAP-002`, High). Both come from lifecycle fields that have no single disk-authoritative write owner.

## Goals and non-goals

Goals:

1. Make impossible run states unrepresentable.
2. Give every task, request, tool call, and approval a stable identity.
3. Keep the checked core small enough to verify exhaustively within bounds.
4. Preserve the persisted reducers and the model-check suite as the regression oracle.
5. Migrate incrementally with each step reversible.

Non-goals:

1. A from-scratch v4 rewrite.
2. Concurrent sibling fan-out in the baseline.
3. Proof of the full TypeScript program. Kernel-level verification only.
4. A flag-day change of the public event payloads.

## Constraints and assumptions

Constraints:

1. VS Code isolates webviews. The host and the webview communicate only by message passing. Two webviews must not share state ([VS Code webview guide](https://code.visualstudio.com/api/extension-guides/webview)).
2. Persisted history files must stay backward compatible. New fields are optional. Downgrade readers must ignore unknown fields.
3. CI must complete quickly. The model-check suite has explicit state budgets.

Assumptions (stated so reviewers can challenge them):

1. The current risks are finite safety properties over a small state machine, not liveness or fairness. The model-check suite records this same assumption.
2. Per-file locks give effective mutual exclusion within one host. Cross-host atomicity is not assumed. The cross-host ownership fix adds an ownership revalidation under the disk lock. It does not assume a cross-host transaction.
3. Most user-visible bugs come from unscoped mutable state, not from the persisted reducers.

## Product requirements

These requirements close the business-logic audit gap (#27). The core maintainer, @edelauna, stated them on 2026-09-25 after a code-grounded review of each question. Each requirement names the design element or the ticket that meets it.

| ID   | Requirement                                                                                                                                                                                                                                                                                 | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                         | Owner                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| PR-1 | A user cancel records the cancelled request. The request row keeps the tokens and the cost known so far and shows as cancelled. That cost counts in the task total and in the auto-approve max-cost check. A cancel waits at most 3 seconds for a hung stream (PR-2).                       | Today the cancel skips `abortStream` (`Task.ts:3487`), and resume deletes the unmarked row (`Task.ts:2339-2352`). Totals and the cost cap sum the rows (`consolidateTokenUsage.ts:41-63`, `AutoApprovalHandler.ts:99-107`).                                                                                                                                                                                                      | Follow-up bug, outside the kernel                          |
| PR-2 | Every instance has the same cancel timing. The `cancelTask` wait behaves the same whether or not an earlier stream failure happened in the instance. It usually ends in milliseconds, because `cancelTask` cancels the HTTP request first. It lasts up to 3 seconds only for a hung stream. | `cancelCurrentRequest` runs before the wait (`ClineProvider.ts:3579`). Today an instance with an earlier stream failure skips the wait on a stale `didFinishAbortingStream` (`Task.ts:3225`), because the per-request reset block does not clear it (`Task.ts:3228-3245`). After that skipped wait, the old loop can still save messages after the rebuild, because `saveClineMessages` has no abandoned guard (`Task.ts:1376`). | RSK-17                                                     |
| PR-3 | The first abort reason wins. A cancel that lands during failure cleanup keeps `user_cancelled`.                                                                                                                                                                                             | Race R-4 (`Task.ts:3706-3718`).                                                                                                                                                                                                                                                                                                                                                                                                  | RSK-19                                                     |
| PR-4 | A completed instance takes no more input. Resume builds a new instance. If the user continues a completed task, its persisted status must leave `completed`, or the work must move to a linked task.                                                                                        | `completed` has no outgoing transition (`taskLifecycle.ts:10`), so the continued task keeps the stored status `completed` (`Task.ts:2406-2423`). The message save only carries the stored status forward (`Task.ts:1410-1411`).                                                                                                                                                                                                  | `LIFE-GAP-039`, block LIFE-BLK-P1-039                      |
| PR-5 | `TaskAborted` means "this instance is torn down". It is not a user-cancel signal. A later payload adds the cause: cancelled, delegated, replaced, or disposed.                                                                                                                              | Emitted on every teardown (`Task.ts:2710`). The only consumers are e2e helpers. The removed upstream evals used it only for a timestamp. No user issue concerns its meaning.                                                                                                                                                                                                                                                     | P6 (#1694)                                                 |
| PR-6 | An ask response applies only to the ask it names, by `askTs`. A queued message or a timer answers an ask only when auto-approve allows that ask type. A superseded approval never runs its tool and returns an explicit tool result.                                                        | #998 (commands run without approval, or the task hangs), #937, Roo #11445. The single `askResponse` slot is not tied to an ask.                                                                                                                                                                                                                                                                                                  | P5 (#1693) with #998. The kernel carries `askTs` (RSK-10). |
| PR-7 | One task instance is live per window in the baseline. Code that holds a task reference across an await re-reads it before it acts.                                                                                                                                                          | Delegation disposes the parent. Footguns: stale references, state that is only in memory (`LIFE-GAP-031`, `035`), per-window scope (`LIFE-GAP-001`), and the scheduler capacity (`LIFE-GAP-014`).                                                                                                                                                                                                                                | Baseline invariant, RSK-13 mailbox rule                    |
| PR-8 | No ask row posts after abort.                                                                                                                                                                                                                                                               | Race R-3. `ask` checks abort only at entry (`Task.ts:1447`).                                                                                                                                                                                                                                                                                                                                                                     | RSK-20                                                     |

## Proposed design: target-state architecture

### Overview

Split task state into two machines with a clear boundary.

1. Persisted lifecycle. Keep the existing reducers and status enum. Harden them with disk-authoritative ownership and an attempt-generation token.
2. In-memory run state (the run-state kernel). Replace the boolean flags with orthogonal regions, latches, and a pure transition function.

Wrap each live task in an actor. The actor owns its run-state kernel. It accepts messages through a serialized mailbox. It rejects a message that is not legal in the current state. The provider routes messages and sends the run-state view to the webview as its own small webview message. Only one task is open at a time. Delegation disposes the parent and persists it as `delegated`, so there is no live parent-child actor pair in memory.

```
Component view (extension host)

  [ClineProvider]  router + webview post owner
      |  owns the single open task
      v
  [Task actor]
      |   - RunState (orthogonal regions, pure transitions)
      |   - identity: taskId, generation (in memory)
      v
  [taskLifecycle reducers] (pure) -> [TaskHistoryStore] -> disk
      ^
      | delegated parent and returning child cross here on disk, not in memory
```

### The run-state kernel

Replace the flag set with a small statechart. The run state has three orthogonal regions and one set of latches. A turn sub-machine sits beside them ([Harel statecharts](https://paperswelove.org/papers/statecharts-a-visual-formalism-for-complex-systems-46a2275a/)). The regions overlap in time in the code, so a single sequence of phases cannot represent them. For example, tool dispatch runs inside the chunk loop while the stream is live (`Task.ts:3459`), and finalized tool calls run again after the stream ends (`Task.ts:3810, 3830, 4029`).

Each region is a discriminated union, so an illegal value inside a region is unrepresentable. The bounded checker proves the constraints across regions as invariants. The design comes from the traced runtime flows below, not from the flag declarations.

```ts
type AbortReason = ClineApiReqCancelReason // "streaming_failed" | "user_cancelled"

type Phase = "uninitialized" | "running" | "completed"

type Stream = { tag: "none" } | { tag: "live"; generation: number; cleanupFinished: boolean }

type Ask =
	| { tag: "none" }
	| { tag: "approval"; askTs: number; toolCallId?: string; approvalId?: string }
	| { tag: "completion"; askTs: number }
	| { tag: "other"; askTs: number }

type Latches = {
	abort: boolean
	abandoned: boolean
	disposed: boolean
	reason?: AbortReason
}

type RunState = {
	phase: Phase
	generation: number
	stream: Stream
	ask: Ask
	latches: Latches
	lastCompletionAskTs?: number
}

type RunEvent =
	| { tag: "initialized" }
	| { tag: "streamStarted" }
	| { tag: "streamCleanupFinished" }
	| { tag: "streamEnded" }
	| { tag: "askStarted"; ask: Exclude<Ask, { tag: "none" }> }
	| { tag: "askSettled"; askTs: number }
	| { tag: "completionAccepted"; askTs: number }
	| { tag: "reasonSet"; reason: AbortReason }
	| { tag: "abortRequested"; abandoned: boolean }
	| { tag: "abandonRequested" }
	| { tag: "disposeRequested" }

type Transition = { ok: RunState } | { rejected: RunState }

function nextRunState(state: RunState, event: RunEvent): Transition
```

`nextRunState` returns a symmetric tagged result. A caller must read `.ok` or `.rejected`. The persisted reducers export the transition data and throw on an illegal move (`taskLifecycle.ts:6-25`). The kernel returns a value instead, because the actor must drop a rejected event without unwinding the stack. ADR-0001 records this choice. That ADR is not written yet (see Architecture decisions).

Idle is not a state. A task is idle when `phase` is `running`, `stream` is `none`, and `ask` is `none`. There is no `awaitingChild` state. Delegation disposes the parent instance, so the delegated relationship lives only in the persisted layer.

Queued user input is out of scope for the kernel. The queued-input bugs (#1308, #1574, #1170) come from `Task#ask` answering a pending ask directly (`Task.ts:1462, 1647, 1661`). Fix them there.

#### Observed flows

1. Start and resume. After `resumeAfterDelegation`, the loop starts a model request without user input (`Task.ts:2874-2931`). Resume can also ask for tool approval before a stream starts (`resumePendingTaskAction`, `Task.ts:2392, 2595`). `isInitialized` is set before that ask (`Task.ts:2391`).
2. Asks during and after a stream. Tool dispatch runs inside the chunk loop while `isStreaming` is true (`Task.ts:3459`). Finalized tool calls run again after the stream ends (`Task.ts:3810, 3830, 4029`). The loop then waits on `userMessageContentReady` (`Task.ts:4049`). So an ask can start with the stream live or with no stream.
3. Ask identity and guard. `ask` throws when `abort` is set (`Task.ts:1447`). It checks only at entry. It then awaits `getState` and `checkAutoApproval` (`Task.ts:1460, 1470`). A blocking ask gets its identity `askTs` when it sets `lastMessageTs` (`Task.ts:1529, 1550, 1568`). A partial ask never waits. It throws `AskIgnoredError` at once (`Task.ts:1499, 1507`). A blocking ask exits in one of three ways: the abort throw (`Task.ts:1679`), `AskIgnoredError("superseded")` when a newer ask has replaced it (`Task.ts:1682-1689`), or the return (`Task.ts:1714`). Back-to-back asks happen, for example with `command_output`.
4. User cancel. `cancelTask` sets `abortReason = "user_cancelled"` (`ClineProvider.ts:3572`). Then it calls `abortTask()` and sets `abandoned = true` in the same tick (`ClineProvider.ts:3585-3588`, issue #560). When the chunk loop resumes, it sees both latches and skips the drain (`Task.ts:3487`). So a user cancel never runs `abortStream`. The `cancelTask` wait (`ClineProvider.ts:3589-3600`) exits when `getCurrentTask()` is undefined, when `isStreaming` is false, when `didFinishAbortingStream` is true, when `isWaitingForFirstChunk` is true, or after 3 seconds.
5. Eviction and replacement. `removeClineFromStack` calls `abortTask(true)` (`ClineProvider.ts:631`). Delegation uses it to dispose the parent (`ClineProvider.ts:3988`). `createTaskWithHistoryItem` aborts the old task with `abortTask(true)` (`ClineProvider.ts:1389`). A checkpoint-restore delete calls `abortTask()` with abandoned false (`checkpointRestoreHandler.ts:34`). Its abandon comes later, through `createTaskWithHistoryItem`.
6. Abort starts disposal. `abortTaskOnce` calls `dispose()` (`Task.ts:2713`). `disposeOnce` sets `abort = true` at `Task.ts:2770` with no await before it.
7. Abort drain. The chunk loop sees `abort`. If the task is not abandoned, the loop calls `abortStream` (`Task.ts:3492`). Only a non-abandoned abort reaches this call, for example a checkpoint-restore delete or a dispose. `abortStream` sets `didFinishAbortingStream` (`Task.ts:3225`). The `finally` block clears `isStreaming` (`Task.ts:3756`).
8. Stream failure. A stream error without `abort` also calls `abortStream("streaming_failed")` (`Task.ts:3714`), which sets `didFinishAbortingStream` (`Task.ts:3225`). Then the loop retries. It does not abort. The per-request reset block (`Task.ts:3228-3245`) does not reset `didFinishAbortingStream`. Only `resumeAfterDelegation` resets it (`Task.ts:2884`). So the field stays true across later requests (race R-1 below).
9. Completion. `attempt_completion` asks `completion_result` during the turn (`AttemptCompletionTool.ts:221`). The ask is usually still pending after the stream ends. On accept the task ends. On feedback the loop continues.
10. New instance. `reopenParentFromDelegation` builds a new instance and calls `resumeAfterDelegation` (`ClineProvider.ts:4357, 4404`). Latches are per instance. No path reuses an aborted instance. The resets at `Task.ts:2881-2886` write the default values on the new instance.

#### Transitions

Each event has a guard and an effect. If the guard fails, the event returns `rejected` with the state unchanged. An effect changes only the fields it names.

| Event                   | Guard                                                              | Effect                                                                                        |
| ----------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `initialized`           | phase is uninitialized                                             | phase = running                                                                               |
| `streamStarted`         | phase is running, stream is none                                   | generation + 1, stream = live(generation, cleanupFinished false), lastCompletionAskTs = empty |
| `streamCleanupFinished` | stream is live                                                     | stream.cleanupFinished = true                                                                 |
| `streamEnded`           | stream is live                                                     | stream = none                                                                                 |
| `askStarted`            | phase is running, abort is false                                   | ask = the new ask. lastCompletionAskTs = its askTs if it is a completion ask, else empty      |
| `askSettled`            | none                                                               | if ask.askTs equals the event askTs, ask = none. Else no change                               |
| `completionAccepted`    | phase is running, abort is false, askTs equals lastCompletionAskTs | phase = completed, ask = none                                                                 |
| `reasonSet`             | none                                                               | if reason is empty, reason = the new reason. Else no change                                   |
| `abortRequested`        | none                                                               | abort = true. If the event has abandoned true, abandoned = true                               |
| `abandonRequested`      | abort is true                                                      | abandoned = true                                                                              |
| `disposeRequested`      | none                                                               | abort = true, disposed = true                                                                 |

Transition notes:

1. `streamStarted` needs no user input, so a resumed task leaves idle (flow 1).
2. `askStarted` is legal with or without a live stream (flows 1, 2, 9). It is not legal after `abort` (PR-8). Drive it where a blocking ask sets `lastMessageTs`, right after the abort check that RSK-20 adds, and carry that `askTs`. Do not drive it for a partial ask. A new ask replaces a pending ask. The replaced ask later exits as superseded, and its `askSettled` carries the old `askTs`. That settle changes nothing, so the view keeps the newer ask (race R-6). A stale settle is a no-op, not a rejection, so the comparison does not count it.
3. An approval does not change the generation. One model request keeps one generation across its asks. The `LIFE-GAP-010` guard therefore accepts the late writes of that request.
4. `streamCleanupFinished` needs only a live stream. It covers both the abort drain and the failure cleanup (flows 7, 8). The field lives on the live stream, so the next stream starts with it false (PR-2).
5. Latches are monotone per instance. No event sets a latch back to false. `abandonRequested` is legal in any phase after `abort`, including after the stream ends, so `abandoned` always latches (flows 4, 5).
6. `abortRequested` and `disposeRequested` are legal in every phase, including `uninitialized` and `completed`. Drive `disposeRequested` at `Task.ts:2770`, where the field is set. Dispose does not change `reason`.
7. `reasonSet` is the only writer of `reason`. The first write wins (PR-3). A later write is a no-op, not a rejection. Until RSK-19 merges, the code still overwrites the reason in race R-4.
8. `completionAccepted` does not read the ask region. The completion ask settles in the `finally` block of `Task#ask` before `AttemptCompletionTool` reads the answer, so the ask is already `none` when the accept arrives (RSK-10). The event carries the `askTs` of the completion ask it answers, and the guard compares it with `lastCompletionAskTs` (PR-6). A new ask or a new stream clears `lastCompletionAskTs`. So a late accept for the old completion ask is rejected once the next ask or stream starts after feedback. The accept also sets `ask = none`, so an accept that arrives before `askSettled` cannot leave a completed task with a pending ask.

#### Abort sources and reasons

| Source                                                                                     | Events                                                   | `reason`                                                    |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------- | ----------------------------------------------------------- |
| `cancelTask` (`ClineProvider.ts:3572, 3585-3588`)                                          | `reasonSet`, `abortRequested(false)`, `abandonRequested` | user_cancelled                                              |
| Chunk-loop catch (`Task.ts:3706-3719`)                                                     | `reasonSet`, `abortRequested(false)`                     | user_cancelled. Before RSK-19, streaming_failed in race R-4 |
| Abort during retry backoff (`Task.ts:3738`)                                                | `reasonSet`, `abortRequested(false)`                     | user_cancelled                                              |
| Checkpoint-restore delete (`checkpointRestoreHandler.ts:34`)                               | `abortRequested(false)`                                  | unchanged                                                   |
| `removeClineFromStack` (`ClineProvider.ts:631`), used by eviction and delegation (`:3988`) | `abortRequested(true)`                                   | unchanged                                                   |
| `createTaskWithHistoryItem` (`ClineProvider.ts:1389`)                                      | `abortRequested(true)`                                   | unchanged                                                   |
| `abortTaskOnce` disposal and `dispose` (`Task.ts:2713, 2770`)                              | `disposeRequested`                                       | unchanged                                                   |

`abortReason = "streaming_failed"` is written only in race R-4. So the rehydrate branch at `ClineProvider.ts:423` is reachable today, but only in that race. After RSK-19, no code writes `streaming_failed`, and RSK-19 deletes that branch. The kernel keeps `AbortReason = ClineApiReqCancelReason` so the type matches the field it replaces.

#### Known code races

The code often checks `abort`, then awaits, then writes run state without a second check. The kernel sees these windows as rejections or divergence. Each window has one decision. RSK-05 uses this list as its ignore list, in the pattern of [GitHub Scientist ignored mismatches](https://github.com/github/scientist#ignoring-mismatches).

| ID  | Window                                                                                                                                                                          | Kernel result without a fix                                                       | Decision                                                                                                                                                                                                                                                                                                                              | Owner  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| R-1 | A failure cleanup sets `didFinishAbortingStream`, and no per-request reset clears it (`Task.ts:3225, 3228-3245`).                                                               | The field and `stream.cleanupFinished` diverge.                                   | Fix the code (PR-2). Reset the field in the per-request block. An instance with an earlier failure then waits like every other instance, usually for milliseconds. The read flip in RSK-16 makes the same change, so RSK-17 makes it explicit and tested first.                                                                       | RSK-17 |
| R-2 | Abort between the loop check (`Task.ts:2996`) and `isStreaming = true` (`:3269`). The code awaits rate limiting, environment details, and the model fetch in between.           | None, because `streamStarted` does not check abort.                               | Allow in the kernel. No code change. The request guard (`Task.ts:4615`) throws before any model call. The chunk-loop catch then marks the `api_req_started` row cancelled, saves it, and sets the reason. An earlier throw would skip that work for a checkpoint delete and for a provider-shutdown dispose (`ClineProvider.ts:830`). | none   |
| R-3 | Abort after the `ask` entry guard (`Task.ts:1447`) and before the ask row posts (`:1529, 1550, 1568`).                                                                          | `askStarted` is rejected.                                                         | Fix the code (PR-8). Check `abort` again right before the ask sets `lastMessageTs`, and throw the same error as `:1448`. Drive `askStarted` after that check, with no await in between.                                                                                                                                               | RSK-20 |
| R-4 | Cancel during failure cleanup. The reason is computed at `Task.ts:3706`, the code awaits at `:3714`, and `:3718` writes `streaming_failed` over `user_cancelled`.               | The field and `latches.reason` diverge, because `reasonSet` is first-writer-wins. | Fix the code (PR-3). Change `:3718` to `this.abortReason ??= "user_cancelled"`.                                                                                                                                                                                                                                                       | RSK-19 |
| R-5 | Abandon while a drain already runs: a checkpoint delete calls `abortTask()`, then `createTaskWithHistoryItem` calls `abortTask(true)` (`ClineProvider.ts:1389`) before `:3225`. | None, because `streamCleanupFinished` has no abandon guard.                       | No action.                                                                                                                                                                                                                                                                                                                            | none   |
| R-6 | A newer ask replaces a pending ask. The older ask exits as superseded (`Task.ts:1682-1689`) while the newer ask still waits.                                                    | None, because `askSettled` matches on `askTs`.                                    | No code change. Carry `askTs` on both ask events.                                                                                                                                                                                                                                                                                     | RSK-10 |

A rejection in the comparison is allowed only while its race ID is in the ignore list and its owner has not merged. Any other rejection blocks the read flip for that field.

#### Invariants

The bounded checker (RSK-02) must prove these in every reachable state:

1. `abandoned` implies `abort`.
2. `disposed` implies `abort`.
3. No latch returns to false.
4. After `abort`, no new ask starts.
5. After `completed`, no new stream starts, and `ask` is none.
6. `generation` never decreases.
7. If `ask` is not none, its `askTs` is the newest `askTs` that `askStarted` has carried.

The kernel does not assert that no stream starts after `abort`. The code does that in race R-2, and the request guard (`Task.ts:4615`) stops the model call.

`cleanupFinished` lives on the live stream. It resets with each new stream by construction, so it needs no invariant.

#### Getters

| Getter                    | Derivation                                           |
| ------------------------- | ---------------------------------------------------- |
| `abort`                   | `latches.abort`                                      |
| `abandoned`               | `latches.abandoned`                                  |
| `abortReason`             | `latches.reason`                                     |
| `didFinishAbortingStream` | `stream.tag === "live"` and `stream.cleanupFinished` |
| `isStreaming`             | `stream.tag === "live"`                              |
| `isInitialized`           | `phase !== "uninitialized"`                          |

`isStreaming` stays true until `streamEnded`, which maps to the `finally` block at `Task.ts:3756`. An abandon does not clear it. After RSK-17, the `cancelTask` wait has one timing for every instance (PR-2). A user cancel never runs a cleanup (flow 4), so the wait ends when the current task is gone, when the stream loop exits, when the first-chunk state holds, or after 3 seconds. Before RSK-17, an instance with an earlier stream failure exits that wait at once on the stale field.

The `didFinishAbortingStream` getter is false after the stream ends. The only reader is that `cancelTask` wait, and the wait also accepts `isStreaming` false. So the getter does not change the wait once RSK-17 has fixed the field.

#### Turn sub-machine

The turn sub-machine holds five within-turn fields: `isWaitingForFirstChunk`, `didRejectTool`, `didAlreadyUseTool`, `didToolFailInCurrentTurn`, and `didCompleteReadingStream`. A turn is one request iteration of the loop. It starts at the per-request reset block (`Task.ts:3228-3245`), before `streamStarted`. It ends when the next iteration starts. It is independent of the stream region, because the loop writes these fields after the stream ends (`Task.ts:3768, 3810, 3830, 4029`).

#### External writers

`ClineProvider` writes `abortReason` (`:3572`) and `abandoned` (`:3588`) directly. It calls `abortTask` at `:631` and `:1389`. `checkpointRestoreHandler` calls `abortTask` (`:34`). RSK-06 routes every one of these writes through events before any read flips.

#### Fields subsumed by the kernel

Counts are Task-owned references in `src` at the audited commit. Tests and comment lines are excluded. The `abort` count excludes `.abort()` method calls on controllers and processes. The `isInitialized` count excludes 6 references on other classes (code index, checkpoint service, terminal registry).

| Field                                      | Writes | Reads | Home                     |
| ------------------------------------------ | ------ | ----- | ------------------------ |
| `abort`                                    | 3      | 41    | `latches.abort`          |
| `abandoned`                                | 3      | 22    | `latches.abandoned`      |
| `abortReason`                              | 4      | 4     | `latches.reason`         |
| `didFinishAbortingStream`                  | 2      | 1     | `stream.cleanupFinished` |
| `isInitialized`                            | 4      | 3     | `phase`                  |
| `isStreaming`                              | 3      | 2     | `stream`                 |
| `isWaitingForFirstChunk`                   | 4      | 1     | turn sub-machine         |
| `didRejectTool`                            | 10     | 6     | turn sub-machine         |
| `didAlreadyUseTool`                        | 2      | 3     | turn sub-machine         |
| `didToolFailInCurrentTurn`                 | 54     | 1     | turn sub-machine         |
| `didCompleteReadingStream`                 | 2      | 2     | turn sub-machine         |
| `presentAssistantMessageLocked`            | 5      | 1     | `DispatchState`          |
| `presentAssistantMessageHasPendingUpdates` | 3      | 1     | `DispatchState`          |
| `isPaused`                                 | 0      | 1     | remove                   |

The set is 11 run fields, 2 dispatch locks, and 1 dead field. Most turn-field writes are in `src/core/tools`.

#### State vocabularies

`RunState` is the in-memory run state. It is not the persisted status. The persisted status (`active`, `completed`, `delegated`, `interrupted`) stays authoritative on disk. The webview reads it from the store (`ClineProvider.ts:3021`). Do not derive persisted status from `RunState`. The two can disagree on purpose:

- A delegating parent is abandoned in memory while the disk says `delegated`.
- A resumed child runs in memory while the disk still says `interrupted`, because `interrupted → completed` is the only legal move.
- Until LIFE-BLK-P1-039 lands, a continued completed task runs while the disk says `completed` (`LIFE-GAP-039`).

Use `RunState` only for the run-state view, and as a consistency check against the store. The no-inference rule is LIFE-BLK-P6-029 in the remediation blocks. The persisted-status type is owned by LIFE-BLK-P3-013 (`LIFE-GAP-013`). `TaskStatus` (`running`, `interactive`, `resumable`, `idle`, `none`, `packages/types/src/task.ts:99`) stays a separate projection of the ask markers (`Task.ts:5343`). Do not fold it into `RunState`.

### Actor per task and message passing

One actor per task node. The actor holds the run-state kernel. It communicates by messages, not shared flags. This matches VS Code isolation and the existing provider-as-orchestrator shape ([Roo architecture](https://deepwiki.com/RooCodeInc/Roo-Code/1.1-system-architecture-overview)).

The extension host is single-threaded. A synchronous `nextRunState` call is already atomic ([MDN event loop](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Execution_model)). The real hazard is interleaving between await points, for example the abort-then-abandon window in `cancelTask` (`ClineProvider.ts:3585-3600`). Define the actor as a serialized mailbox. The mailbox processes one event at a time. State the rule: an await inside a handler does not hold the mailbox, so a handler must re-read state after each await. The repo already has this pattern in the per-key promise queue `runDelegationTransition` (`ClineProvider.ts:148-172`) and the `abortPromise ??=` guard (`Task.ts:2687`). Reuse them, do not invent a new lock.

The provider stays the source of the webview view. It keeps the existing partial-post optimizations. It omits `taskHistory` from most posts for payload size (`ClineProvider.ts:2438-2452`). It omits `clineMessages` from non-chat posts so a stale post cannot overwrite newer streamed messages (`:2476-2491`, `clineMessagesSeq`). The run-state view does not ride on that post. The provider sends it as its own small webview message when the run state changes (RSK-14). This keeps the full post from growing, and it follows the delta pattern that #630 proposes for `clineMessages`. It does not replace the existing optimizations and it does not become a single full snapshot on every change.

### Identity and generation as first-class

Identity spans two owners. The run-state kernel holds only `generation`, an in-memory counter that `streamStarted` increments. The other identities are P4 and P5 work and are out of scope for the run-state kernel epic. The kernel stores `toolCallId` and `approvalId` on the approval ask as optional opaque strings. They stay empty until P4 and P5 supply them. RSK does not derive or validate them.

1. `taskId`: the task node.
2. `generation`: an in-memory counter per model request. The gap report calls it the request generation. It lives on the run state. `streamStarted` increments it. Asks inside one request do not change it. A late drain may account usage but cannot mutate a newer generation (`LIFE-GAP-010`). It is per instance. It does not cross delegation, because delegation disposes the instance.
3. `toolCallId`: one collision-resistant identity for a tool call, owned by P4 (`LIFE-GAP-038`, #1692). Reject or disambiguate collisions before indexing and persistence.
4. `actionId`: the approval action, owned by P5 (`LIFE-GAP-036`, #1693). Carry it through proposal, edit, approval, and settlement. This document uses the gap report's name `actionId` for P5's approval identity. The kernel stores the same value as `approvalId`, to avoid a collision with the persisted `pendingAction.actionId` (see the warning below).

Warning: the persisted `pendingAction.actionId` (`history.ts:51`) is a different field. The code derives it from `sanitizeToolUseId(toolCallId)` (`NewTaskTool.ts:105`). A change to the canonical tool-call identity for `LIFE-GAP-038` changes that persisted key. The kernel therefore names its field `approvalId`, not `actionId`, so the two do not collide. The canonical identities are P4 and P5 scope, not RSK.

Persist an attempt-generation token so the reducers can reject a stale completion and accept a resumed one (`LIFE-GAP-012`). The token is an optional field, so a downgrade reader ignores it (constraint 2). That reader cannot reject a stale pre-interruption completion. The `LIFE-GAP-012` guard holds only for upgraded readers. On a mixed-version host the old reader re-admits the bug the token fixes. The P1 spec defines the reader behavior for a record or completion with no token, and the lazy-migration read path (`task-lifecycle-persisted-ownership-model.md`, LIFE-BLK-P1-012). This is P1 scope, not RSK.

Replace the process-global tool state with keyed state. Key partial-call state by `(taskId, toolCallId)` (`LIFE-GAP-037`). Key approval state by `(taskId, actionId, toolCallId)` (`LIFE-GAP-036`), the same key as the gap analysis table. The webview message must carry the key. `updateTodoList` (`webviewMessageHandler.ts:2183`) carries none today, so this needs a webview schema change. P5 owns it.

### The verification boundary

Draw one line. The checked core is verified. The periphery is ordinary code.

1. Checked core: the seven baseline checkers in `pnpm lifecycle:model-check` (task lifecycle, task store concurrency, provider handoff and scheduler, cleanup protocol, parser scope, completion persistence, and delegated mode readers), plus the pure `nextRunState`. Bounded model-checkers explore these exhaustively within the state budget. This is the "conservative abstraction that keeps only state-relevant information" pattern that AWS uses with formal methods ([How Amazon Web Services uses formal methods](https://cacm.acm.org/research/how-amazon-web-services-uses-formal-methods/)).
2. Periphery: streaming, filesystem, webview, and provider I/O. Focused tests and E2E cover these. No exhaustive proof is claimed.

The run-state kernel is a new in-memory submodel. It is not a persisted lifecycle mutation, so it does not live in the shared reducers that `AGENTS.md` pins to `taskLifecycle.ts`. It uses the independent-submodel pattern (`task-lifecycle-model.md`, Extending the model). Add a boundary mapping before any claim spans two submodels (`task-lifecycle-model.md`, introduction). The abort and dispose ordering is already model-checked in `task-cleanup-protocol-model.md`. Map the kernel latches to that model rather than re-proving them:

| Kernel                     | Cleanup model (`scripts/check-task-cleanup-protocol.ts`)                                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `abortRequested`           | `abort`, `shutdown-abort`                                                                                                                                                  |
| `disposeRequested`         | `dispose`, `abort-starts-disposal`, `shutdown-dispose`                                                                                                                     |
| `latches.abort` is true    | the task `abort` field is not `idle`, or its `disposal` field is not `idle`                                                                                                |
| `latches.disposed` is true | the task `disposal` field is not `idle`                                                                                                                                    |
| no kernel event            | `reject-abort`: `abortTask` sets the latch synchronously before its promise (`Task.ts:2685`)                                                                               |
| no kernel event            | `reject-disposal-start`: the start fails before `Task.ts:2770`, so `disposeRequested` never fires                                                                          |
| not modeled in the kernel  | `complete-abort`, `skip-final-save`, `complete-disposal`, `settle-reversion`, `reject-reversion`, `settle-cleanup`, `reject-cleanup`, `start-shutdown`, `advance-shutdown` |

The kernel records only that abort and disposal started. The cleanup model owns their settlement. Stream cleanup (`stream.cleanupFinished`) is outside the cleanup model. The kernel checker owns it. Update `AGENTS.md` to name the run-state submodel and its location.

The checked core stays small enough to verify within bounds.

## Gap analysis

Each row is one concern. Current state cites a symbol. Target state names the design element. The gap links to the `LIFE-GAP` IDs it closes. Severity follows the gap report register: Critical, High, Medium-high, Medium.

| Concern                         | Current state                                       | Target state                                                                   | Gap and severity                                     | Closes                      | Remediation                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run-state representation        | 11 run fields and 2 dispatch locks on `Task`        | `RunState` of orthogonal regions with pure `nextRunState` plus derived getters | Illegal states representable, High                   | new                         | Add the union and the transition function. Delete flags one at a time                                                                                                                                                                                                                                                                                                                                                                          |
| Dispatch re-entrancy            | `presentAssistantMessageLocked` boolean             | Orthogonal `DispatchState` region                                              | Serial/parallel lock ambiguity, High                 | #374, #325                  | Independent track. #374 depends on #373. Keep behavior the same                                                                                                                                                                                                                                                                                                                                                                                |
| Approval ownership              | Process-global `approvedTodoList`                   | State keyed by `(taskId, actionId, toolCallId)`                                | Cross-task edit contamination, High                  | LIFE-GAP-036                | Correlate proposal, edit, approval, and settlement. Reject stale edits                                                                                                                                                                                                                                                                                                                                                                         |
| Partial-call state              | Singleton `BaseTool.lastSeenPartialPath`            | State keyed by `(taskId, toolCallId)`                                          | Cross-call stabilization errors, Medium-high         | LIFE-GAP-037                | Instantiate per call, or key the map by identity                                                                                                                                                                                                                                                                                                                                                                                               |
| Tool-call identity              | Non-injective ID sanitization                       | One collision-resistant `toolCallId`                                           | History/execution divergence, High                   | LIFE-GAP-038                | Reject or disambiguate collisions before indexing                                                                                                                                                                                                                                                                                                                                                                                              |
| Completion generation           | No attempt/generation token                         | Persisted generation on the record                                             | Stale completion accepted, Medium                    | LIFE-GAP-012                | Reject a stale generation. Accept a resumed generation                                                                                                                                                                                                                                                                                                                                                                                         |
| Request generation              | Detached drain writes ungoverned                    | `generation` on stream writes                                                  | Stale UI/message mutation, Medium                    | LIFE-GAP-010                | Guard late writes by generation                                                                                                                                                                                                                                                                                                                                                                                                                |
| Cross-host completion ownership | Disk revalidation checks status only                | Lock-time ownership check (P1 spec, LIFE-BLK-P1-001)                           | Orphaned newer child, Critical                       | LIFE-GAP-001                | Run the lock-time ownership check in the parent write of the pair path (`atomicUpdatePair`) and in the delegation write (`atomicReadAndUpdate`). Run the lock-time generation check in the child write (P1 spec, LIFE-BLK-P1-001 and P1-012). A parent check before the child write narrows the write-order window but does not close it. LIFE-BLK-P2-004 owns that recovery, which rolls forward from the committed child. Add two-host tests |
| Stale message save              | A late message save restores abandoned lineage      | Disk-authoritative owner for lifecycle fields, or a tombstone                  | Restored lineage after abandonment, High             | LIFE-GAP-002                | Give lifecycle fields one write owner that routes through `assertValidTransition`                                                                                                                                                                                                                                                                                                                                                              |
| Completed-task continuation     | A continued completed task saves status `completed` | A transition out of `completed`, or a linked successor task                    | Delegation from a continued task is rejected, Medium | LIFE-GAP-039                | Decide the continuation in LIFE-BLK-P1-039                                                                                                                                                                                                                                                                                                                                                                                                     |
| Status vocabulary               | Union copied in six places                          | One exported schema-derived type                                               | Silent drift, Medium                                 | LIFE-GAP-013                | Import one owner. Add a static ratchet                                                                                                                                                                                                                                                                                                                                                                                                         |
| Webview state sync              | Ad hoc updates                                      | Run-state view sent as its own small webview message                           | Stale/dropped view state, Medium                     | supports #1065, #1536, #630 | Send the run-state delta. Keep the partial-post optimizations                                                                                                                                                                                                                                                                                                                                                                                  |

## Verification strategy

1. Keep the bounded model-check suite. It gives exhaustive bounded safety proofs with shortest-witness counterexamples. Extend it to the new `nextRunState` function. Do not replace it.
2. Use orthogonal regions of discriminated unions and a pure reducer for the in-memory run-state kernel. Do not add xstate to the baseline. xstate model-based testing gives path coverage of the model, not a proof. Dynamic context can make the traversed space infinite ([xstate graph docs](https://stately.ai/docs/graph)). xstate is a runtime model and a test generator, not a verifier. Reconsider it only as a test generator, or for orthogonal regions if fan-out ships.
3. Optional later step: specify the persisted kernel in TLA+ and check it with TLC. TLC explores every reachable state and returns a counterexample trace ([TLA+ high-level view](https://lamport.azurewebsites.net/tla/high-level-view.html)). Do not verify the TypeScript itself. Bridge it with trace validation: log implementation transitions and check the traces against the spec ([trace validation](https://pron.github.io/files/Trace.pdf)). The model-check suite already names this upgrade path.

## Cross-cutting concerns

1. Observability. Log each accepted and rejected run-state transition with `taskId` and `generation`. This supports later trace validation.
2. Error handling. A rejected event must never mutate state. The actor drops it or returns an error.
3. Backward compatibility. New persisted fields are optional. Public event payloads change through adapters, not a flag day.
4. Performance. The run-state kernel is pure. The actor boundary adds message dispatch, not I/O.
5. Speed. This design does not target speed. The one speed-related change in scope is that the run-state view goes to the webview as its own small webview message, not on the full state post (RSK-14, #630). The main speed costs are in the per-message save and in the per-chunk `messageUpdated` post. A separate speed epic will own them.

## Alternatives considered

1. Greenfield v4 rewrite around xstate. Rejected. It discards the model-check suite and the gap report. It reintroduces fixed edge cases. A full rewrite carries more risk ([Things You Should Never Do](https://www.joelonsoftware.com/2000/04/06/things-you-should-never-do-part-i/)). It does not remove one hard problem. Identity, generation, and ownership all reappear.
2. Targeted fixes only. Rejected as the complete answer. It fixes current bugs. It keeps the representation that produces new illegal states.
3. Grow the model to cover all runtime state. Rejected. Every new adapter multiplies the state space past the CI budget (constraint 3). The gap audit records this, and `LIFE-GAP-015` keeps the checkers explicitly local (task-lifecycle-model.md, gap audit).
4. Move the persisted lifecycle to xstate. Rejected. For the protocol layer it replaces bounded exhaustive checking with path coverage. Path coverage proves less.

The chosen design keeps the model-check suite. It applies the union to the run state.

## Risks and technical debt

1. Migration risk. Extracting the run-state kernel touches hot paths in `Task.ts`. Mitigation: land RSK-12 and RSK-04 first as behavior-preserving changes. Guard every step with the model-checkers and E2E.
2. Persisted compatibility risk. The generation token changes the record. Mitigation: optional field, lazy migration, downgrade-safe readers. A downgrade reader stays crash-safe but drops the stale-completion guard, because it ignores the token. The guard is available only after the reader upgrades.
3. Scope creep risk. Fan-out could pull the run-state kernel toward parallel state early. Mitigation: fan-out stays frozen until the serial baseline ratchets green (`LIFE-GAP-014`).
4. Deliberate shortcut. The run-state kernel stays a single-actor model per task. When fan-out ships, add orthogonal parallel regions.

## Migration plan

Use a strangler migration. Do not rewrite everything at once. Rewrite the bounded run-state kernel behind a stable interface. Route `Task` and `ClineProvider` through it. Retire the flags one module at a time ([Strangler Fig](https://martinfowler.com/bliki/StranglerFigApplication.html)).

Follow the existing critical path from the gap report: P1, P7, P2, P5, P6. Run P4 beside P1. Run P3 and P8 in parallel.

1. P1: persisted ownership and generation. Add the persisted attempt-generation token (LIFE-GAP-012) and disk-authoritative ownership (LIFE-GAP-001, 002).
2. P4: request, stream, and tool identity. Guard detached usage writes with the kernel `generation` (LIFE-GAP-010). This depends on RSK-10 (#1804), which routes the writes that maintain `generation`. Add the canonical `toolCallId` (LIFE-GAP-038) and call-scoped partial state (LIFE-GAP-037). Start P4 beside P1.
3. P7: ratchet the serial scheduler baseline against P1.
4. P2: durable operation and crash recovery.
5. P5: tool-owned task state and queueing. Add approval identity (LIFE-GAP-036) and durable child initialization (LIFE-GAP-035).
6. P6: event and ingress contracts.

Run P3 (schema, path, and vocabulary) and P8 (verification and traceability platform) in parallel. The names match the P3 and P8 tables in the remediation blocks.

The run-state kernel is a separate epic beside these P-blocks. It runs on the RSK tickets. See [task-lifecycle-run-state-kernel-tickets.md](./task-lifecycle-run-state-kernel-tickets.md). #374 `DispatchState` is an independent track. The kernel does not use `DispatchState`, so no RSK ticket waits on it. #374 depends on #373, which is open and unassigned under Epic 4 (Parallel Tool Execution). Name an owner for #373 before RSK-03 starts. Fix code races R-1, R-3, and R-4 (RSK-17, RSK-20, RSK-19) before the reads that depend on them flip. See Product requirements for PR-1 to PR-8. Run RSK beside P4. Order RSK-15 (the run-state to persisted-status consistency check) after P3-013, because P3 owns the persisted-status type. Keep fan-out (`FANOUT-BLK-*`) outside the baseline.

## Architecture decisions

Record each major choice as a numbered ADR in Nygard format (Status, Context, Decision, Consequences). Store ADRs under `docs/architecture/adr/` and link them here. The directory holds ADR-0003 and ADR-0005. The other ADRs below are not written yet. Do not inline them ([ADR](https://martinfowler.com/bliki/ArchitectureDecisionRecord.html)). Proposed first ADRs:

1. ADR-0001: Represent run state as orthogonal regions with a value-returning `nextRunState`, not a throwing reducer.
2. ADR-0002: One actor per task node with a serialized mailbox.
3. [ADR-0003](./adr/0003-attempt-generation.md): Attempt generation, increment at resume, and replay settlement. Proposed.
4. ADR-0004: Keep bounded model-checking. Do not add xstate to the baseline.
5. [ADR-0005](./adr/0005-pair-write-roll-forward.md): Roll forward a half-finished pair write. Proposed.

## Glossary

- Run-state kernel: the in-memory task state machine. Pure. Checked.
- Persisted lifecycle: the on-disk status protocol and its reducers.
- Actor: a task node that owns its run state and communicates by messages.
- Discriminated union: a type whose variants carry only the data legal in that variant.
- Orthogonal region: one part of the run state that changes independently of the other parts, as in a Harel statechart.
- Latch: a boolean field that changes from false to true once per instance and never changes back.
- Generation: an in-memory counter per model request, held on the run state (LIFE-GAP-010). The gap report calls it the request generation.
- Attempt-generation token: a persisted token on the task record that separates a stale completion from a resumed one (LIFE-GAP-012).

## References

- Google design docs: https://www.industrialempathy.com/posts/design-docs-at-google/
- Effective design docs: https://refactoringenglish.com/excerpts/write-an-effective-design-doc/
- Architecture Decision Records: https://martinfowler.com/bliki/ArchitectureDecisionRecord.html
- arc42 and C4: https://www.archyl.com/blog/arc42-vs-c4-model
- Make impossible states unrepresentable: https://incrementalelm.com/make-impossible-states-impossible/
- Statecharts (Harel): https://paperswelove.org/papers/statecharts-a-visual-formalism-for-complex-systems-46a2275a/
- xstate graph and testing: https://stately.ai/docs/graph
- How AWS uses formal methods: https://cacm.acm.org/research/how-amazon-web-services-uses-formal-methods/
- TLA+ high-level view: https://lamport.azurewebsites.net/tla/high-level-view.html
- Trace validation: https://pron.github.io/files/Trace.pdf
- Strangler Fig: https://martinfowler.com/bliki/StranglerFigApplication.html
- Things You Should Never Do: https://www.joelonsoftware.com/2000/04/06/things-you-should-never-do-part-i/
- VS Code webview guide: https://code.visualstudio.com/api/extension-guides/webview
