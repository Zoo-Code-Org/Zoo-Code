# Transcript transport: ownership and bounded verification

Run the focused checker with **pnpm transcript-transport:model-check**. It also runs as the seventh independent submodel in **pnpm lifecycle:model-check**, wired in [package.json](../../package.json). It does not change persisted task lifecycle reducers or workflow files.

## Production boundary

[`TranscriptTransport`](../../src/core/webview/transcriptTransport.ts:213) owns generation, task-scoped sequence allocation, instance-scoped FIFO job descriptors, snapshot progress, and one physical-send barrier. [ClineProvider.ts](../../src/core/webview/ClineProvider.ts) supplies current task and instance focus and the webview post callback. Resync additionally accepts optional client sequence diagnostics for metadata-only logging; they never select or modify the authoritative snapshot revision.

[`TranscriptRequest.taskInstanceId`](../../src/core/webview/transcriptTransport.ts:6) is optional for legacy fixtures, while every [`TranscriptJob`](../../src/core/webview/transcriptTransport.ts:11) retains its originating instance, including an absent value. The constructor preserves its first three arguments and adds a fourth focused-instance callback defaulting to an absent value. Identity comparisons are exact: an unscoped request cannot adopt a live instance, and an identified request cannot match absent focus. Production must provide the actual instance callback and the originating instance on requests. Every wire frame, including append/update and snapshot start/chunk/end, copies the descriptor's instance through [`transcriptFrameMessage()`](../../src/core/webview/transcriptTransport.ts:185); it never derives identity from later focus.

The driver and the explorer both call [reduceTranscriptTransport](../../src/core/webview/transcriptTransport.ts) for admission, allocation, invalidation, task-sequence pruning, send initiation, and settlement. They also share the production frame-to-message conversion. This is not a separate queue specification that only resembles production.

Payloads and caller resolvers live in driver-owned maps, outside the pure state. Invalidation synchronously removes all waiting jobs and their payload references, releases the active snapshot's unsent suffix, and resolves discarded waiting callers. There is no retained chain of old-generation closures. A physical post already invoked remains the sole in-flight owner until its Promise settles; its caller settles at that boundary. New-generation or new-instance jobs may queue but cannot send until that barrier is released. Every later delta, snapshot start, chunk, or end initiation rechecks generation, task ID, and task instance. Rejection terminates that job, rejects its caller, logs the failure, and permits the next job to run.

The driver intentionally **deep-clones at enqueue time**. Tasks mutate message objects and nested arrays while a post is waiting; shallow copying or cloning at drain time would pair an earlier sequence with later content. Generation, task, and instance guards run before cloning and before allocating either a sequence or snapshot ID. A second reducer admission check protects the captured payload's ownership, including reentrant focus replacement during cloning.

**Empty append/update arrays return before capture or reducer admission.** They allocate no captured request, cloned payload, sequence, job/snapshot ID, frame, or payload/caller-map entry and leave protocol state unchanged. This is not a claim that returning an already-resolved Promise entails zero JavaScript runtime allocation. The reducer independently rejects zero-total deltas without changing state or producing effects. Empty snapshots remain valid and send start/end markers without chunks.

The provider tests in [ClineProvider.spec.ts](../../src/core/webview/__tests__/ClineProvider.spec.ts) hold real post callbacks rather than injecting a private Promise queue. They retain focus-only and generation-only cancellation, CLI behavior, snapshot/delta ordering, deep snapshot isolation, and exact-boundary checks. The queued append/update regression mutates nested image arrays. The 401-message regression compares all three chunks to the exact corresponding original slices. Repeated-resync tests retain a held start or chunk, discard 26 waiting jobs, assert immediate payload/caller release, and prove one physical send and no stale end.

The production Task adapters pass the producer's own instance on all append/update calls (including deferred partial updates) and on overwrite/start/resume snapshots. The provider never fills an absent producer identity from current focus; absent identity only matches legacy absent focus. Resync is a controller operation and explicitly captures current focus. Stack publication/removal and in-place replacement invalidate transport and immediately post the new scope before awaiting cleanup or preparation, without resetting the physical-send barrier. The dedicated [`clineMessagesFocus`](../../packages/types/src/vscode-extension-host.ts:40) message publishes only task/instance ownership: it shares receiver scope-reset logic with metadata but cannot trigger generic settings hydration, reopen setup, or clear the legacy CLI's resume flag. Generic state retains its captured instance through asynchronous assembly; the final post boundary drops a mismatching task/instance rather than retagging stale metadata. Unscoped partial metadata and CLI transcript state remain supported.

The adapter regressions in [Task.persistence.spec.ts](../../src/core/task/__tests__/Task.persistence.spec.ts) instantiate real distinct Tasks sharing one task ID and use the real provider constructor, registry, producer methods, and transport. They hold all five frame types, check publication before both old-task cleanup and replacement preparation, release obsolete queued callers while a send is held, reject delayed old producers even with the current generation, and recover through new-instance snapshots and deltas. Provider tests additionally hold an awaited authentication lookup after generic task metadata capture, then replace focus and prove the obsolete post is dropped for both generic-state methods in browser and CLI modes. The resync race pins the exact winning generation before and after release of the older state-post boundary. These tests supply the concrete adapter evidence that the independent model does not claim to prove.

## Exhaustive bounded state space

The [explorer](../../src/core/webview/__tests__/transcriptTransport.model.ts) uses deterministic breadth-first search with canonical state deduplication. It explores every enabled ordering in seven bounded scenarios; this is not randomized scheduling or a hand-selected trace list. A producer and controller retain their own program order, while admission, send initiation, send success/failure, focus publication, and invalidation may interleave at every enabled boundary.

| Scenario                          | Producer order                                     | Controller order                                | Reachable states | Transitions | Maximum shortest depth |
| --------------------------------- | -------------------------------------------------- | ----------------------------------------------- | ---------------: | ----------: | ---------------------: |
| Queued deltas / repeated resync   | snapshot, append, update                           | resync, resync                                  |           13,292 |      19,281 |                     33 |
| Task switch / clear               | snapshot, append, snapshot                         | switch to second task, clear                    |            7,523 |      10,334 |                     33 |
| Invalidation / recovery           | snapshot, update, snapshot                         | invalidate, resync                              |            6,030 |       8,149 |                     31 |
| Focus before sync / stale request | snapshot, append, update                           | focus second task, resync, stale snapshot       |            5,746 |      10,330 |                     24 |
| Same-task instance / snapshot     | snapshot, stale-instance append                    | replace instance, sync instance, append, update |            2,998 |       5,927 |                     24 |
| Same-task instance / deltas       | append, update, stale-instance snapshot            | replace instance, sync instance                 |            1,317 |       2,034 |                     15 |
| Empty deltas / valid recovery     | empty append, empty update, append, empty snapshot | none                                            |               21 |          23 |                     10 |

These totals are diagnostics, not hard-coded ratchets: 36,927 states across independently explored scenarios and 56,078 examined transitions. Bounds are **two task IDs plus no task, at most two instances of the first task (one replacement), up to five admitted jobs, two invalidations, four messages per snapshot, chunk size two, and at most one failed physical send per trace**. Standalone producer snapshots bump the sequence; resync and instance-sync snapshots retain the current sequence. Empty, exact-boundary, and multi-chunk snapshots arise within the bounds. Production uses chunk size 200; the provider regression checks 401 messages at the real chunk size.

Each scenario has an unchanged **30,000-state budget and depth limit 40**. The checker fails on the first unseen successor beyond either bound, missing required action/landmark coverage, or any invariant violation. There is no truncated success. Every failure reports its scenario, bounds, shortest action trace, intermediate states, and the violating state. Mutants select the shortest witness across all seven scenario graphs with stable tie ordering.

The model exposes a scheduling point between settlement and the next pump, and between enqueue and pump. The production driver performs these synchronously within its continuation. This is a conservative scheduling over-approximation, not a claim that every model event boundary corresponds to an independently schedulable JavaScript callback.

The replacement action publishes the same task ID with a new instance to both producer focus and the receiver, clearing receiver staging/visible state and applied sequence. It is separate from the later instance-sync action, which invalidates and admits the new snapshot. An explicitly delayed old-instance producer then attempts append or snapshot admission using the **current generation**, before or after sync; stale identity alone must reject it. Ordinary producer events represent fresh current-focus work. Old physical start/chunk/end/delta sends may settle on either side of replacement and sync. Splitting snapshot and delta races preserves the original bounds while requiring both late-end and late-delta receiver rejection, followed by acceptance of new-instance snapshots and deltas.

## Invariants and scope

1. Generation increases exactly once per invalidation and never otherwise. Stale-generation admission allocates no job or snapshot ID. Stale-instance and empty-delta admission return identical protocol state without admission or other effects, including when the stale producer supplies the current generation.
2. No physical send overlaps another, including an old generation's or instance's held send. No old-generation, old-task, or old-instance post/commit is **initiated** after ownership changes. Descriptor, frame, and captured wire identity must equal the originating request's instance; a held wire message cannot acquire replacement identity at settlement.
3. Invalidation retains no obsolete queue or payload. Discarded waiting callers settle immediately. Each settlement must consume a registered caller exactly once. Remaining payloads correspond exactly to active/queued jobs; remaining callers correspond exactly to those jobs plus an already-initiated physical send.
4. Allocated sequences follow enqueue/capture order: deltas and bumping snapshots increment; resync retains the current value. Sent sequence is nondecreasing and never exceeds allocation. Failed snapshots never resume their suffix.
5. The independent receiver oracle rejects a wire message unless both task and instance match published focus, before staging or applying any content. This includes a complete old-instance end marker and old append/update deltas. It stages contiguous, exact snapshot payloads and exposes them only at a matching complete end marker. Start/chunks cannot change visible transcript or applied sequence. Applied sequence cannot decrease within one focused-instance scope.
6. Job totals equal captured payload lengths. Only snapshots carry snapshot identities, unique across captures. Non-chunk frame ranges are zero; chunk descriptors have contiguous starts and positive, exact lengths bounded by the captured payload and chunk size. These checks precede wire conversion, whose array slicing can otherwise hide an overlarge final count.

Sequence monotonicity is **not global across task IDs or removed/recreated task lifetimes**. The production provider prunes a task's sequence on stack removal/history deletion; the model exercises the shared pruning action on switch/clear and tags its allocation/sent oracle with a task-lifetime epoch. Same-task instance replacement itself does not reset the transport's task-keyed sequence; a new-instance snapshot establishes the receiver's baseline. A no-task snapshot has sequence zero. Receiver applied sequence resets on task/instance change or clear, as distinct from resync of the same instance. The checker does not invent a persisted generation token or silently demand globally increasing sequences after clear.

All 23 action classes are required: snapshot, append, update, resync, invalidate, switch, clear, focus, stale-snapshot, replace-instance, sync-instance, stale-instance-append, stale-instance-snapshot, empty-append, empty-update, empty-snapshot, pump, start, chunk, end, settle, fail, discard. All 26 named reachability landmarks are required:

- held-post-with-queued-delta;
- repeated-invalidation-while-held;
- cancelled-active-suffix-released;
- new-generation-waits-for-old-send;
- stale-physical-completion;
- already-initiated-stale-end-can-complete;
- task-switch-with-held-send;
- focus-changed-before-invalidation;
- clear-prunes-task-sequences;
- empty-snapshot-committed;
- multi-chunk-snapshot-committed;
- failed-post-with-queued-recovery;
- snapshot-recovery-after-failure;
- delta-applied-after-snapshot;
- same-task-instance-published-before-sync;
- instance-replacement-with-held-send;
- stale-instance-current-generation-rejected;
- stale-instance-queued-job-discarded;
- stale-instance-active-suffix-discarded;
- old-instance-end-ignored;
- old-instance-append-ignored;
- old-instance-update-ignored;
- new-instance-snapshot-committed;
- new-instance-append-applied;
- new-instance-update-applied;
- new-instance-recovers-after-old-end-rejected (one trace rejects the old end, commits a new snapshot, and applies both new deltas).

## Invariant sensitivity

Twenty test-only reducer, wire-conversion, and receiver-policy faults must produce their expected violation class through the same exhaustive explorer. The receiver policies are independent of React; these checks test the oracle's scope contract, not the production UI implementation. No mutation switch exists in production.

| Mutant                              | Shortest witness, excluding initial state                                          | Detected violation                      |
| ----------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------- |
| stale-completion-starts-end         | snapshot, pump, resync, settle                                                     | stale commit initiation                 |
| admit-stale-generation              | focus, resync, stale-snapshot                                                      | obsolete admission allocates work       |
| ignore-focus-at-post                | snapshot, focus, pump                                                              | stale-focus initiation                  |
| legacy-generation-only-invalidation | snapshot, resync                                                                   | retained obsolete jobs/payloads         |
| reset-promise-barrier               | snapshot, pump, resync, pump                                                       | overlapping physical sends              |
| commit-before-chunks                | snapshot, pump, settle, pump, settle                                               | incomplete atomic snapshot              |
| reuse-delta-sequence                | append                                                                             | incorrect allocated sequence            |
| continue-after-rejection            | snapshot, pump, fail, pump                                                         | failed snapshot resumes posting         |
| delta-snapshot-metadata             | append                                                                             | delta carries snapshot metadata         |
| non-chunk-payload-range             | snapshot, pump                                                                     | non-chunk payload range                 |
| overrun-final-chunk                 | switch, pump, settle, pump                                                         | chunk exceeds captured range            |
| settle-caller-twice                 | snapshot, resync                                                                   | settlement without owned caller         |
| admit-empty-delta                   | empty-append                                                                       | empty delta allocates work              |
| admit-stale-instance                | snapshot, replace-instance, stale-instance-append                                  | stale-instance admission allocates work |
| ignore-instance-at-post             | snapshot, replace-instance, pump                                                   | stale-instance send initiation          |
| drop-descriptor-instance            | snapshot                                                                           | descriptor loses origin identity        |
| drop-wire-instance                  | snapshot, pump                                                                     | wire loses origin identity              |
| receiver-ignores-instance           | snapshot, pump, replace-instance, settle                                           | receiver accepts stale-instance frame   |
| receiver-accepts-stale-end          | snapshot, pump, settle, pump, settle, pump, settle, pump, replace-instance, settle | receiver accepts stale-instance end     |
| receiver-accepts-stale-delta        | append, pump, replace-instance, settle                                             | receiver accepts stale-instance delta   |

[transcriptTransport.spec.ts](../../src/core/webview/__tests__/transcriptTransport.spec.ts) runs the full checker as a scenario/coverage test plus one test per injected fault, verifies deterministic shortest witnesses and both fail-closed budget paths, and exercises the actual driver with held/rejected start, chunk, end, and delta sends, plus synchronous rejection/recovery. Each fault still searches all seven scenario graphs for the shortest witness; separating the test cases avoids accumulating every exhaustive search under a single test timeout without changing that timeout or any exploration bound. The [CLI entry point](../../scripts/check-transcript-transport.ts) runs the same checks together and prints counts, action/landmark names, bounds, and mutant traces.

Focused reducer tests also check canonical descriptors for empty, exact-boundary, and partial-final chunks independently of wire output. Adversarial queued/active states retain obsolete-generation work with unchanged focus to verify the defense-in-depth pre-send guard discards it and permits current work. Such states are deliberately **not claimed reachable** through normal invalidation, which releases that work; no artificial action is added to the reachable-state explorer. A driver regression retains one held caller through two invalidations and checks both successful and failed settlement followed by recovery.

Instance regressions cover stale and absent identity before cloning, replacement reentered during cloning, queued and active pre-send rejection without invalidation, and all five held frame phases across same-task replacement with successful/failed physical settlement, with and without repeated invalidation. They check original wire identity, exactly-once caller settlement, and subsequent new-instance snapshot/delta sends. Empty-delta tests assert no cloning, capture/focus reads, state/sequence/ID/frame changes, or payload/caller insertion, then accept a valid delta and an empty snapshot. Legacy fixtures continue using absent identity on both request and focus.

## Limitations: initiation is not delivery revocation

An active physical send cannot be unsent. In particular, **an end marker initiated before invalidation may complete afterward and publish its already-complete snapshot on the same focused task instance**. The generation is provider-local, not a wire field. The named stale-end-completion landmark deliberately requires this permitted behavior; the stale-completion-starts-end mutant forbids the materially different bug of initiating a new old-generation end after invalidation. Across same-task instance replacement, the captured wire identity instead lets the receiver reject the old completion. This prevents old content from entering the replacement scope, but does not cancel the physical send or settle its caller early. The single physical barrier ensures a newer transcript's posts cannot overtake the held old one.

The receiver is an independent protocol oracle, not the React reducer. It assumes ordered, lossless successful physical delivery at settlement and no delivery for a modeled rejection; a real post can deliver before its Promise settles. It deliberately cannot prove browser timer behavior, dropped/delayed messages, resync retry diagnostics, rendering, or restart behavior. Existing UI tests own those concerns. The provider's post wrapper swallows disposed-view failures and ignores the editor's boolean delivery result; model rejection covers errors reaching the transport callback, **not delivery acknowledgement**.

Metadata state posts are outside this transcript FIFO. The integration contract requires the provider to invalidate replacement ownership and publish task/instance focus synchronously before asynchronous preparation, and to guard stale generic metadata. The model assumes receiver focus publication has happened; it does not import or prove that provider/metadata ordering. Its separate replacement-before-sync/invalidation boundary is a conservative over-approximation testing identity protection even before cleanup, not permission for production to delay publication or invalidation. A legacy request with absent identity has no same-task replacement protection unless both endpoints use explicit instances. There is no fairness/liveness claim: a permanently held physical post permanently blocks later physical transcript posts, although obsolete waiting jobs are still released on invalidation. Memory claims concern removal of owned references, not immediate garbage collection or memory retained by the editor's already-initiated post.

This bounded check does not prove arbitrary queue lengths, sequence overflow, repeated instance replacement or arbitrary task-ID reuse, instance-ID uniqueness/collision resistance, message validation, or all payload values. It assumes opaque distinct instance identities and models one replacement only. Driver/provider regressions cover concrete deep-clone behavior and runtime correspondence; UI tests own the real consumer. No persisted lifecycle reducer, status, persistence owner, or scheduler transition is changed or imported by this extension of the transport model, so composition remains at the aggregate command boundary.
