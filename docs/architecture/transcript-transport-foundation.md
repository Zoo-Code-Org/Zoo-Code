# Transcript transport foundation

## Staged delivery

This is the independently testable foundation extracted from [PR #1360](https://github.com/Zoo-Code-Org/Zoo-Code/pull/1360), related to [issue #630](https://github.com/Zoo-Code-Org/Zoo-Code/issues/630). It adds the transport implementation, additive wire declarations, driver tests, and a bounded model checker. **It does not activate the transport.** Task producers, provider ownership, renderer disposal, focus publication, resync handling, and the React receiver remain integration work in #1360. Existing state and legacy message delivery are unchanged.

The split preserves the reviewed transport implementation rather than removing safety checks or weakening mutation limits. Against the extraction base, the foundation contains 262 changed executable extension lines; after it lands unchanged, #1360's extension contribution falls from 567 to 305. A separate commit or an unmerged prerequisite does not reduce #1360's scope against main. Both PRs require validation against their actual integration bases, and line scope passing does not establish mutation execution or review acceptance.

## Ownership and protocol

[`TranscriptTransport`](../../src/core/webview/transcriptTransport.ts:274) owns captured payloads and caller resolvers. Its pure [`reduceTranscriptTransport()`](../../src/core/webview/transcriptTransport.ts:92) owns generation, task/instance-scoped job descriptors, task-keyed sequence allocation, snapshot progress, and a physical-send barrier. The driver and bounded explorer share that reducer and [`transcriptFrameMessage()`](../../src/core/webview/transcriptTransport.ts:227); the checker is not a second queue implementation.

- Requests must match the current generation, task, and originating instance before deep cloning. Reducer admission checks ownership again after capture. An absent instance cannot adopt a live instance.
- Append/update requests increment the task's sequence and carry complete captured message values. Empty deltas are rejected without capture or allocation. Snapshots optionally bump the sequence and send start, bounded chunks of 200 messages, and end; empty snapshots send start/end only.
- Invalidation releases queued payloads and the active snapshot's unsent suffix, settling discarded waiting callers. It does not reset the physical-send barrier: an already-started send settles before the next generation can send.
- Renderer shutdown closes admission, releases all owned work, settles pending callers, clears callbacks, and detaches the physical completion slot. Late completion cannot pump a replacement renderer. Reopen installs fresh callbacks and advances generation without resetting IDs or sequences.
- Task-sequence pruning is explicit. Sequence monotonicity is not global across removed/recreated task lifetimes. Snapshot identity is opaque and distinct from the transcript revision.

The additive fields in [`ExtensionMessage`](../../packages/types/src/vscode-extension-host.ts:30) describe dedicated frames only. They do not remove legacy transcript state or implement consumer validation. The future adapter must supply exact task/instance focus and bind sends to the originating renderer. The future receiver must publish focus before accepting frames, reject stale scopes, validate revisions and contiguous snapshot ranges, and apply snapshots atomically.

## Verification

Run the focused checker with **pnpm transcript-transport:model-check**. It is also included in **pnpm lifecycle:model-check** through [`package.json`](../../package.json:16), without changing persisted lifecycle transitions. Run the focused Vitest suite from the extension package: **pnpm --dir src exec vitest run core/webview/**tests**/transcriptTransport.spec.ts**.

[`transcriptTransport.spec.ts`](../../src/core/webview/__tests__/transcriptTransport.spec.ts:1) verifies admission, exact chunk boundaries, deep capture, failure recovery, held physical sends, repeated invalidation, same-task instance replacement, shutdown/reopen, callback detachment, and successful or rejected late completions. It also runs scenario coverage and one exhaustive check per injected fault, with unchanged test timeouts and exploration bounds.

The deterministic breadth-first [`explorer`](../../src/core/webview/__tests__/transcriptTransport.model.ts:1) checks ten scenarios with two task IDs plus no task, at most two instances of the first task, at most five admitted jobs, two invalidations, two shutdown calls and one reopen, snapshots up to four messages with chunk size two, and at most one failed physical send per trace. Each scenario has a 30,000-state budget and depth limit 40. Exceeding either budget fails closed. The extraction's diagnostics are 40,099 states and 61,303 transitions, with all 27 actions and 34 named landmarks reached. Twenty-four test-only reducer, wire, and receiver-policy faults must yield their expected shortest counterexamples.

Invariants cover scope ownership, a single physical send per renderer, immediate release of obsolete work, exactly-once caller settlement, monotonic allocation within retained task scope, exact captured ranges, atomic snapshot application in the independent receiver oracle, and isolation of retired renderer completions. The [`CLI checker`](../../scripts/check-transcript-transport.ts:1) reports scenario counts, action/landmark coverage, bounds, and fault witnesses.

## Limits and integration obligations

An already-initiated physical send cannot be revoked. A same-instance end marker started before invalidation may still complete; the guarantee is that no later stale post is initiated. Shutdown detaches ownership but does not cancel an editor-owned operation or prove immediate garbage collection.

The receiver is an independent oracle, not the React implementation. The model assumes ordered successful delivery at settlement and no delivery for rejection. It does not prove browser timers, real delivery acknowledgements, provider focus/metadata ordering, persistence, rendering, restart behavior, or adapter callback binding. Driver tests verify concrete callback detachment; the full provider and UI integration tests remain in #1360.

There is no fairness or unbounded liveness claim. A held physical send blocks that renderer until settlement or shutdown. The bounded model does not prove arbitrary queue lengths, sequence overflow, unlimited instance replacement or renderer cycles, instance-ID collision resistance, or arbitrary payload values. It neither imports nor modifies persisted task lifecycle reducers or scheduler transitions.
