# Task lifecycle persisted ownership and generation model

This document is the specification deliverable for the P1 workstream, "Persisted ownership and generation" (tracked by [#1689](https://github.com/Zoo-Code-Org/Zoo-Code/issues/1689) under umbrella [#1688](https://github.com/Zoo-Code-Org/Zoo-Code/issues/1688)). It discharges the documentation/formal-model scope of five remediation blocks from the [remediation block register](./task-lifecycle-remediation-blocks.md):

- `LIFE-BLK-P1-001` for `LIFE-GAP-001` (stale cross-host completion ownership);
- `LIFE-BLK-P1-002` for `LIFE-GAP-002` (stale message save restoring detached lineage);
- `LIFE-BLK-P1-012` for `LIFE-GAP-012` (attempt/generation identity for completion);
- `LIFE-BLK-P1-017` for `LIFE-GAP-017` (mutable store cache reads);
- `LIFE-BLK-P1-020` for `LIFE-GAP-020` (stale-cache and convergence histories).

Like the parent [gap report](./task-lifecycle-gap-report.md), this is a documentation and formal-model artifact. It does not change production behavior, and completing these blocks does not close any parent `LIFE-GAP`: every closure criterion below names production evidence that belongs to a later implementation PR. Where a closure criterion names interruption, stale-write, or recovery evidence, the required tests are deterministic fault-injection tests — interruption at each persistence step with rollback verification — never timing-based sleeps or smoke tests.

## Shared ownership vocabulary

All five blocks use one vocabulary, established here so that dependent workstreams (P2 recovery, P7 serial baseline) can reference it without re-deriving it.

- **Authoritative record.** Each task's `history_item.json` file on disk is the authoritative record. Every extension host's `TaskHistoryStore` cache is a replica that may lag disk (stale) and may contain fields no peer has committed.
- **Stale snapshot.** A `HistoryItem` captured from a host cache, or rebuilt from a live `Task`, before a peer host's latest commit. Completion (`ClineProvider.reopenParentFromDelegation`) and message saves (`Task.saveClineMessages`) build writes from stale snapshots by construction: the snapshot is taken outside the per-file disk lock.
- **Lock-time revalidation.** The check executed inside `safeWriteJson`'s merge callback while holding the per-task advisory file lock, implemented by `mergeHistoryDelta` (`src/core/task-persistence/taskStoreConcurrency.ts`). Today it enforces only status-transition legality (`VALID_TASK_STATUS_TRANSITIONS`) plus `childIds` union semantics. It does not check exact-child ownership.
- **Lifecycle-owned fields.** The fields whose authoritative writer is the lifecycle layer: `status`, `rootTaskId`, `parentTaskId`, `delegatedToId`, `childIds`, `awaitingChildId`, `completedByChildId`, `completionResultSummary`, and `pendingAction`. The block-level ownership table is under LIFE-BLK-P1-002 below.
- **Attempt generation.** A monotonically increasing per-task token distinguishing one execution attempt of the same task ID from the next after interruption and resume. No such persisted token exists today; `PendingTaskAction.actionId` is pending-approval identity, not attempt identity (see LIFE-BLK-P1-012).

## LIFE-BLK-P1-001 — authoritative awaited-child revalidation (GAP-001)

**Bounded property.** In every reachable two-host history, a child completion may mutate the parent record only while the authoritative (on-disk) parent record awaits that same child. Exclusions: crash atomicity of the pair write itself (`LIFE-BLK-P2-004`), more than two hosts, advisory-lock implementation semantics, and power-loss durability.

**Production symbols and ownership boundary.** `ClineProvider.reopenParentFromDelegation` captures the parent and child from the host cache outside the disk lock, then calls `TaskHistoryStore.atomicUpdatePair`. Inside `atomicUpdatePair`, each `writeTaskFile` call runs `mergeHistoryDelta` under that file's advisory lock. The stale-completion window is the gap between the unlocked snapshot and the lock-time merge.

**Model boundary.** The `revalidate` phase of the shared-store checker (`scripts/check-task-store-concurrency.ts`) is the faithful model of this boundary: it executes the production `mergeHistoryDelta` against current disk state while holding the modeled per-file lock. The checker's `stale completion ownership` scenario drives host A's completion of `child-a` against host B's re-delegation to `child-b`.

- **Lock-time ownership check (named, required).** When a delta writes lifecycle fields that assume the parent awaits child `c` — the completion pair produced by `completeDelegatedChild` — lock-time revalidation must verify `disk.parent.awaitingChildId === c` (with the recovery-compatible `active` parent carve-out already recognized by the production reducer) and reject the delta otherwise. Today's check verifies only status-transition legality, which is exactly why the witness below exists. This check is the disk-authoritative ownership guard named by `LIFE-GAP-001`'s dependency column.
- **Witness (retained).** The checker's `#1469` known-unsafe witness — the exact 14-action shortest trace ending in `complete-a.commit(parent)` after `redelegate-b.commit(parent)` — remains the ratchet. CI fails if the witness's causal order changes or disappears without promotion.
- **Bounds.** Two hosts, three task slots, depth ≤ 32, ≤ 100,000 states, six scenarios; all seven phases and three semantic landmarks must remain reachable. These bounds are unchanged by this block.
- **Production test required for promotion.** A deterministic two-store test (the `TaskHistoryStore.crossInstance.spec.ts` pattern, two real stores on one storage path): store A captures a stale completion snapshot for `child-a`, store B completes the interrupt-and-redelegate sequence to `child-b`, then store A's `atomicUpdatePair` completion attempt must be rejected at lock-time revalidation and must leave B's committed handoff intact (parent still `delegated` to `child-b`, `child-b` active and linked). Only after that test exists and passes may the checker witness be promoted to a universal invariant.

**Model/checker change.** None in this PR, by design: encoding the ownership check as a model transition now would specify behavior production does not implement, violating the suite's faithfulness rule. The witness stays a witness until the production guard lands; this block names the boundary, check, bounds, and promotion test so the later implementation PR has an objective target.

## LIFE-BLK-P1-002 — lifecycle-owned fields versus metadata writes (GAP-002)

**Bounded property (monotonic detachment).** Once a detach commit lands — `abandonDelegatedChild` clears the child's `parentTaskId`/`rootTaskId` — no later write whose lineage fields derive from a pre-detach snapshot may reintroduce them. This property is **currently violated in production**; this block makes the invariant and its ownership contract explicit and claims no present safety.

**Field ownership table.** Authoritative-writer assignment for every `historyItemSchema` field (`packages/types/src/history.ts`):

| Field                                                                     | Owner                                                           | Metadata writers may write?                                      |
| ------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------- |
| `status`                                                                  | Lifecycle reducers via `atomicReadAndUpdate`/`atomicUpdatePair` | Preserve current value only (`Task.saveClineMessages` does this) |
| `rootTaskId`, `parentTaskId`                                              | Lifecycle reducers (`delegateTaskToChild` chain, abandonment)   | **No** — today `taskMetadata` writes them from live `Task` state |
| `delegatedToId`, `awaitingChildId`                                        | Lifecycle reducers only                                         | No                                                               |
| `childIds`                                                                | Lifecycle reducers; merge unions concurrent additions           | No                                                               |
| `completedByChildId`, `completionResultSummary`                           | `completeDelegatedChild` (and reconciliation repair)            | No                                                               |
| `pendingAction`                                                           | Delegation/completion paths (create/finish subtask actions)     | No                                                               |
| `id`, `number`, `ts`, `task`                                              | Creation-time identity                                          | Creation only                                                    |
| `tokensIn`, `tokensOut`, `cacheWrites`, `cacheReads`, `totalCost`, `size` | Metadata (`taskMetadata` accounting)                            | Yes                                                              |
| `workspace`, `mode`, `apiConfigName`                                      | Metadata (`taskMetadata`, mode/profile updates)                 | Yes                                                              |

Administrative repair paths (`reconcileDelegationStateCore`, `repairActiveDelegation`, migration) write lifecycle fields with `skipTransitionCheck: true`; they are lifecycle-owned writes, not metadata writes.

**Current deviation and witness.** `Task.saveClineMessages` rebuilds `rootTaskId`/`parentTaskId` from the live `Task` via `taskMetadata`, preserving only `status` from the store (`Task.ts`: the `existingStatus` spread). `computeHistoryDelta` therefore includes lineage fields whenever the live snapshot diverges from cache, and `mergeHistoryDelta` applies them last-writer-wins. The shared-store checker's `#1021` known-unsafe witness (`stale save detachment`, the exact 11-action shortest trace through `A.refresh` into `stale-save-a.commit(child-a)`) shows a stale save re-attaching abandoned lineage while preserving the newer `interrupted` status. The witness stays ratcheted until the closure criteria below are met.

**Model/checker change.** None in this PR: the field ownership table and monotonic-detachment invariant are the deliverable, and the checker already retains the exact witness. The later implementation PR must either strip lifecycle fields from metadata deltas at the `taskMetadata`/`updateTaskHistory` boundary or make lock-time revalidation reject stale lineage deltas (tombstone or generation), then promote the witness to a universal invariant. Depends on the LIFE-BLK-P1-001 vocabulary above — satisfied within this document.

**Test evidence required for closure (deterministic fault injection).** Interrupt a save at each persistence step of `Task.saveClineMessages` (message write, metadata build, `updateTaskHistory` upsert) with an interleaved abandonment commit, and assert that after every interruption point the detached lineage is never restored and any partial write rolls back or is superseded by the authoritative record.

## LIFE-BLK-P1-012 — attempt-generation state (GAP-012)

**Bounded property.** A completion produced by attempt `g` of a child may be accepted only while the persisted attempt generation of that child is `g`. A delayed pre-interruption completion (generation `g0`) arriving after resume (generation `g1`) must be rejected; the post-resume completion (`g1`) must be accepted. Exclusions: wall-clock timing, pending-action replay identity (`LIFE-BLK-P4-038`), and cross-host visibility of the generation, which is owned by the LIFE-BLK-P1-001 lock-time check once the field exists.

**Production symbols and boundary.** `PendingTaskAction.actionId` (`packages/types/src/history.ts`) correlates one pending create/finish approval and is cleared on settlement; it is not an attempt identity and does not survive into the resumed attempt. The interruption, resume, and completion paths are the `interruptDelegatedChild` reducer, webview/API/IPC resume into `resumeTask`/rehydration, and `completeDelegatedChild` via `reopenParentFromDelegation`.

**Specified generation semantics.** One future optional persisted field, `attemptGeneration`, on the child record (lazy optional-field migration per the gap report's planning assumptions; downgrade readers ignore it):

- Delegation (first attempt) establishes generation `g0`.
- Interruption preserves the interrupted attempt's generation — the interrupted record still names `g0`, so a late `g0` completion remains attributable.
- Resume of an interrupted child increments to `g1` before the new attempt can produce completion.
- Completion carries the producing attempt's generation; reducers and lock-time revalidation accept it only when it equals the persisted generation.

**Acceptance/rejection landmarks.** Two named landmarks must be reachable in the future checker: `stale-generation-completion-rejected` (a `g0` completion offered after resume created `g1` is rejected at both the reducer and the lock-time boundary) and `resumed-generation-completion-accepted` (a `g1` completion moves child → `completed`, parent → `active`).

**Bounded future checker shape.** Extend `scripts/check-task-lifecycle.ts` — not the shared-store checker — with a per-child generation counter and one new action `resume(child)` (enabled when the child is `interrupted`; bumps the generation and returns the child toward `active` under the existing re-delegation rules). `complete(child, g)` becomes enabled only when `g` equals the modeled current generation. Keep the existing three task slots; depth may rise to at most 14 to cover one interrupt/resume/complete cycle per child; the 10,000-state budget and landmark reachability rules apply unchanged. Bounds cannot truncate silently: the existing frontier check already fails on any unseen successor.

**Model/checker change.** None in this PR, justified: no persisted generation token exists in `historyItemSchema`, so there is no faithful production boundary to import, and adding generation state to the checker now would model unimplemented behavior — the same reason the lifecycle model page documents this exclusion today. This specification is the dependency input for `LIFE-BLK-P2-006` (completion commit phases) and `LIFE-BLK-P6-009`/`P6-033` (event and resume-ingress contracts).

## LIFE-BLK-P1-017 — immutable store read semantics (GAP-017)

**Bounded property.** A caller that mutates an object returned by `TaskHistoryStore.get`, `getAll`, or `getByWorkspace` cannot alter the cache or disk state of the store. Exclusions: consumers of downstream serialized copies (webview and IPC payloads are already structured-cloned at the message boundary) and the `onWrite` write-through callback, which receives a freshly built array per mutation.

**Current behavior.** `get` returns the live cache object by reference; `getAll` and `getByWorkspace` allocate a new array containing those same live objects. The store's own atomic updaters are safe (`atomicReadAndUpdate`/`atomicUpdatePair` pass `structuredClone` snapshots to updaters), but the public read surface is not.

**Direct-caller inventory (exhaustive over `src/`, `packages/`, `apps/` at the authoring commit).** `TaskHistoryStore` is constructed per `ClineProvider` instance (one per extension-host view) and reached as `provider.taskHistoryStore`.

| Caller                                                                                                                                                | Use of returned record                                                               | Mutates?              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------- |
| `ClineProvider` (~25 sites: delegation guards, completion, abandonment, eviction, mode/profile updates, webview/API state, broadcasts, write-through) | Reads fields; every write path spreads into a new object first                       | No                    |
| `ClineProvider.getTaskWithId`                                                                                                                         | Returns the cached reference onward to its own callers (which spread before writing) | No (shared reference) |
| `Task.clearPendingActionAfterDurableResult`                                                                                                           | Assigns the nested `pendingAction` object to an in-memory field                      | No                    |
| `Task.saveClineMessages`                                                                                                                              | Reads `status` to preserve it in the rebuilt item                                    | No                    |
| `extension/api.ts` `getTaskHistoryItem`                                                                                                               | Returns `structuredClone(item)` — already defensive                                  | No                    |
| `extension/api.ts` `TaskCompleted` listener                                                                                                           | Reads `parentTaskId`                                                                 | No                    |
| Test suites (`TaskHistoryStore.*.spec.ts`, provider and delegation specs)                                                                             | Read-only assertions, setup upserts, or stubbed mocks                                | No                    |

`getByWorkspace` has no production callers (only a `TaskHistoryStore.spec.ts` suite exercises it); `packages/` and `apps/` contain no `TaskHistoryStore` usage. No current caller, production or test, mutates a returned record. The risk is latent: the API hands out live references, so any future or unspotted mutator bypasses the store lock entirely.

**Immutable read semantics (decision to implement).** Records must leave the store as immutable snapshots. Evaluate in the implementation PR, in order of preference: (a) deep-freeze records at cache-write time and return the frozen references — zero per-read cost and turns mutation into a strict-mode `TypeError`; (b) `structuredClone` on read — strongest isolation, per-read cost on the hot `getStateToPostToWebview` path; (c) type-level `ReadonlyDeep` plus lint — no runtime safety, weakest. Option (a) with (c)'s types is the recommended combination given the all-read-only inventory.

**Clone/freeze test criteria (store tests).** A focused `TaskHistoryStore` test must obtain a record via `get`/`getAll`, attempt to mutate a scalar field and the nested `childIds` array, and assert that a second `get` and a subsequent `reconcile` from disk both show the unmutated record; under the freeze option the mutation attempt must throw in strict mode (or no-op) with the record unchanged. Compatibility exclusions recorded: webview/IPC serialization is unaffected; the `onWrite` array contract is unaffected; `getByWorkspace` may be removed or receive identical semantics; no test-suite rewrites beyond the new mutation-regression test are anticipated.

**Model/checker change.** Not applicable: this is a read-side API contract, not a transition protocol, and no faithful model boundary exists for object-reference mutability in the explicit-state explorers. The evidence is the caller inventory above plus the specified mutation-regression test.

## LIFE-BLK-P1-020 — stale-cache and convergence histories (GAP-020)

**Bounded property.** Watch/reconcile convergence is eventual and failure-tolerant, not coherent. For any finite, quiescing sequence of peer writes, a host whose next `reconcile()` completes successfully converges its cache to disk for every task ID. During the stale window there is no coherence guarantee: same-field conflicts remain last-writer-wins at the `mergeHistoryDelta` boundary. Exclusions: repeated reconcile failure (no convergence bound), network filesystems, process crash/power loss mid-write (`LIFE-BLK-P2-004`), and lock-implementation semantics.

**Observable histories (named, bounded).**

1. **Watcher-refresh history.** Peer commit → `fs.watch` event → 500 ms debounce → `reconcile()` → cache updated. Stale-read window bound: debounce interval plus one reconcile pass, when the watcher fires.
2. **Missed-watch history.** `fs.watch` error or platform unreliability (handled in `startWatcher`, which logs and falls back) → no event → cache stays stale until the periodic reconcile (`RECONCILE_INTERVAL_MS`, 5 minutes) or an explicit refresh. Stale-read window bound: one periodic interval plus one reconcile pass, when reconciles succeed.
3. **Explicit-refresh history.** `invalidate(taskId)` (used by `delegateParentAndOpenChild` and the `reopenParentFromDelegation` continuation before reading authoritative state) or webview-triggered `invalidateAll()` + `reconcile()` (`webviewMessageHandler`) → cache re-read from disk inside the store lock. Window bound: zero for the invalidated entry once the call resolves.

`reconcile()`'s mtime skip is exact for this property because `taskFileMtimes` records the last observed mtime per task; the lock-file liveness fallback keeps a task live across a peer's atomic rename window instead of evicting it.

**Objective convergence evidence (existing).** `TaskHistoryStore.crossInstance.spec.ts` covers peer create/delete/update detection through reconciliation and invalidation visibility with two real stores; `TaskHistoryStore.realConcurrency.spec.ts` exercises the real `proper-lockfile` plus rename path; `TaskHistoryStore.reconciliation.spec.ts` covers drift repair. These are focused production tests, not exhaustive interleavings.

**Additional test evidence required for closure (deterministic, no timing sleeps).**

- _Missed-watch:_ construct a store whose watcher is stubbed to error or never fire, commit a peer write through a second real store, advance fake timers past the periodic interval (or invoke `reconcile()` directly), and assert byte-level convergence with disk.
- _Missed-watch with concurrent update:_ during the stale window, perform a local delta write and assert the peer's fields survive (delta merge preserves fields absent from the delta), then assert convergence after the next successful reconcile.
- _Reconcile-failure injection:_ inject a reconcile failure inside the window and assert only that the stale window extends — never that state diverges — with a successful reconcile restoring convergence. Rollback verification: after each injected failure, the cache must equal either the pre-write or post-write disk state, never a partial merge.

**Shared-store landmarks.** The existing `stale-cache-newer-disk` semantic landmark already requires a reachable state where a host cache diverges from newer disk state; this block names the histories that produce and resolve it. No checker change in this PR: the watcher, debounce, and timers are environment effects, and the explicit-state explorer models `refresh` as an environment action already; a timing-faithful watcher model would require the temporal semantics the suite deliberately defers (see the lifecycle model page's tooling rationale). Depends on the LIFE-BLK-P1-001 vocabulary — satisfied within this document.

## Traceability

| Block           | GAP | Delivered here                                                                   | Closure evidence deferred to implementation PR                         |
| --------------- | --- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| LIFE-BLK-P1-001 | 001 | Lock-time ownership check named; witness, bounds, and promotion test specified   | Disk-authoritative guard, two-store regression test, witness promotion |
| LIFE-BLK-P1-002 | 002 | Field ownership table; monotonic-detachment invariant; stale-save witness linked | Owner enforcement or tombstone/generation; fault-injection save tests  |
| LIFE-BLK-P1-012 | 012 | Two-generation semantics, landmarks, bounded future checker shape                | Persisted generation field; reducer/store/API rejection; restart E2E   |
| LIFE-BLK-P1-017 | 017 | Exhaustive caller classification; immutable-read decision; test criteria         | Freeze/clone implementation plus mutation-regression test              |
| LIFE-BLK-P1-020 | 020 | Named stale-cache/convergence histories; bounded properties; test criteria       | Missed-watch and fault-injection convergence tests                     |

No block in this document claims its parent GAP is closed or that current production behavior is safe against the named witnesses.
