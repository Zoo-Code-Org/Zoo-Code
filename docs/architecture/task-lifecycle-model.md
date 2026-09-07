# Task lifecycle model-check suite

Zoo Code checks task lifecycle protocols through one compositional verification suite. Run the complete suite locally with:

```sh
pnpm lifecycle:model-check
```

The command runs five independent bounded submodels in sequence:

1. the persisted task delegation lifecycle;
2. the provider handoff transaction;
3. shared-store concurrency across task-history hosts;
4. the task cleanup protocol; and
5. request-stream parser scoping.

This umbrella command is the single model-check entry point in the `compile` CI job after type checking. Command-level composition does not merge the submodels' state spaces: each checker retains its own bounds, transitions, invariant ownership, reachability requirements, and counterexample format. In particular, parser state is not part of the persisted lifecycle graph. The focused parser checker remains directly runnable with `pnpm parser-scope:model-check` for debugging.

An individual checker fails if it finds an invariant violation, a modeled action becomes unreachable, or exploration exceeds its declared state budget. A lifecycle violation includes the shortest breadth-first event trace, every intermediate state, and the active bounds so the sequence can be replayed as a focused regression test.

Executable cross-model composition should be added only when a correctness claim genuinely spans two or more submodels and there is an explicit, production-grounded boundary mapping between their events or state. That composition must state a bounded joint exploration strategy and own cross-model invariants that cannot be proved within either child model alone. Shared command orchestration or conceptual adjacency is not sufficient reason to multiply independent state spaces.

## Why an executable TypeScript model

The checker uses a small explicit-state explorer, not Quint, TLA+/TLC, or Alloy. The choice is deliberate.

The current risks are finite safety properties over a small persisted state machine, not temporal liveness or fairness properties. The checker calls the production transition functions in `src/core/task-persistence/taskLifecycle.ts`. `ClineProvider` uses those same functions in serialized and atomic store operations. This reduces drift between the model and the code.

Breadth-first exploration gives a deterministic, shortest-by-event counterexample. It requires no Java and no separate specification toolchain. Bounds and budget exhaustion are explicit. CI never reports a truncated exploration as a pass.

The model follows the initial-state, next-state, reachable-state, invariant structure from the [TLA+ high-level view](https://lamport.azurewebsites.net/tla/high-level-view.html) and [Quint's model-checker documentation](https://quint-lang.org/docs/model-checkers). Quint's [model-based testing guidance](https://quint-lang.org/docs/model-based-testing) notes that checking a specification alone does not show that production code implements it.

Use TLA+/PlusCal or Quint with TLC when the lifecycle needs temporal properties, fairness assumptions, unbounded queues, or refinement between protocol layers. Use Alloy when relational ownership structure is harder to reason about than event ordering. Alloy analyses are bounded by scope; see the [Alloy tutorial](https://alloytools.org/tutorials/online/maintext-FS-1.html).

Randomized model-based testing can complement, but not replace, the bounded exhaustive check when a production adapter is available. [fast-check](https://fast-check.dev/docs/advanced/model-based-testing/) documents command models and [controlled Promise scheduling](https://fast-check.dev/docs/advanced/race-conditions/). For distributed persistence behavior, use Jepsen-style history checking; see Jepsen's [consistency model overview](https://jepsen.io/consistency).

## Production mapping

| Model concept             | Production concept                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------ |
| Task record and status    | `HistoryItem` persisted by `TaskHistoryStore`                                        |
| `delegate(parent, child)` | `ClineProvider.delegateParentAndOpenChild`                                           |
| `interrupt(child)`        | cancellation or eviction through `markDelegatedChildInterrupted`                     |
| `complete(child)`         | `ClineProvider.reopenParentFromDelegation`                                           |
| `abandon(child)`          | `ClineProvider.abandonSubtask`                                                       |
| Atomic event step         | `atomicReadAndUpdate`, `atomicUpdatePair`, and per-parent delegation transition lock |
| Event interleaving        | Competing completion, cancellation, abandonment, and new delegation calls            |

The model has three fixed task slots. This covers competing siblings and a nested parent-child-grandchild chain. The checker explores every reachable interleaving to depth 12 and deduplicates canonical states.

Representative checks also test rejected operations that do not create a new state. These include: a second concurrent delegation while the first child is active, stale completion after re-delegation, late completion after abandonment, completion after interruption, and nested completion. Named semantic landmarks require the graph to keep interrupted-child re-delegation and nested delegation even when the raw state total changes.

Production completion also accepts a recovery-compatible `active` parent that still awaits the returning child. It then clears the stale pointers. Normal model transitions never create that intermediate state. A focused reducer test covers it instead of admitting it as a generally valid reachable state.

## Provider handoff refinement model

The same command runs `scripts/check-provider-handoff.ts`. This is a bounded model of the delegation handoff transaction. The transaction protocol is a pure, secret-free state machine in `src/core/task-persistence/providerHandoff.ts`. `ClineProvider.delegateParentAndOpenChild` advances it at semantic landmarks. The checker explores it exhaustively. The model imports the production reducer, handoff policy, and profile decision functions. Its persistence step calls `delegateTaskToChild` instead of duplicating the persisted transition.

The full delegation transition runs inside the per-parent `runDelegationTransition` lock. The transition covers validation, preparation, parent removal, child creation, commit, reconciliation, rollback, activation, and child start. Completion and abandonment use the same lock. Two same-parent delegations, or a completion/abandonment racing a delegation, can never interleave.

Each transition holds an opaque owner token for its parent. Paths that run while the lock is already held — parent restoration after child creation failure, rollback restoration, `reopenParentFromDelegation` — pass the token through `createTaskWithHistoryItem` or `evictCurrentTask`. A same-parent interruption triggered by that eviction runs its unlocked core instead of re-acquiring the lock it already owns. Transitions for other parents and every external eviction still acquire locks normally. Reentrancy is explicit and per-parent, never a global lock bypass.

Production order is prepare-before-remove.

While the parent is still the current task, handoff preparation is read-only. It runs off the provider profile mutation queue. Preparation captures the requested mode, an explicit profile projection intent (`preserve | set{name} | clear`), and a deep-cloned API configuration into one context. It performs zero writes. A hung or timed-out queued mutation can never block delegation preparation.

If preparation rejects, delegation aborts fail-closed. The parent stays current.

After preparation, the parent is removed. The paused child is created from the prepared all-or-none execution context. The context is validated for completeness at runtime in `ClineProvider` and the `Task` constructor. The delegation is then durably committed through `TaskHistoryStore.atomicReadAndUpdate`.

That atomic commit is the single lifecycle commit boundary. Legacy global state, the profile store, and publication are best-effort projections. They run strictly after the commit. They can never undo the commit or block the child from starting.

The child is derived entirely from the resolved handoff configuration. This includes profile-derived constructor inputs such as `consecutiveMistakeLimit`. The pre-handoff global configuration can never leak into child execution.

After the commit, context activation moves execution-context authority to the child. The child's task-local mode, sticky profile, and API configuration are then authoritative. A stale legacy projection cannot change them.

The child starts immediately. It never waits for the legacy projection. The post-commit projection runs as fire-and-forget background work outside the per-parent delegation lock and outside the child-start critical path. A handled promise reports one named result per operation, in one of three boundaries: `profile-store` (durable profile reads/writes), `context-proxy` (legacy global state), or `queue` (the bounded queue abandoned the batch before completion).

Completion or failure updates the generation-stamped stale-projection marker. It emits the mode-change signal only while the projection's mutation generation is still current. A superseded projection's completion is inert. On failure, the marker makes publication derive child values from the prepared context. A later successful mode/profile mutation carries a higher generation, supersedes the marker, and publication returns the user's values.

The profile projection intent is explicit. Three values are possible:

- `set`: the identity is written to the durable profile store and legacy global state.
- `preserve`: a locked handoff (workspace profile pinning) never rewrites the pinned identity.
- `clear`: the child's sticky profile stays `undefined`. The durable store identity is removed. Legacy global `currentApiConfigName` is written as `undefined`, never skipped. Publication shows the explicit absence instead of falling back to the `"default"` identity.

`getState` and `getStateToPostToWebview` preserve that explicit clear for the current child and for a stale cleared projection. Legacy behavior outside an explicit clear is unchanged.

Failure handling is coarse and labeled.

Preparation failure aborts cleanly. Nothing needs to be undone. Child-creation failure rolls back by restoring the parent. Rollback failures (`child-cleanup`, `parent-restoration`) are recorded on a degraded-abort terminal.

A failed commit attempt has ambiguous durability. The write may have persisted before the failure appeared. Production reconciles this while still holding the per-parent lock. Before the update attempt, the checker captures the commit-owned parent fields as a preimage: `status`, `awaitedChildId`, `childIds`, and `pendingAction` ownership. After a rejection, the parent record is re-read strictly from disk through `TaskHistoryStore.readFresh`. This call distinguishes `found`, definitively missing, and unreadable or incompatible records. It does not collapse every read failure into a cache miss.

Child history is optional at this boundary. A parent record durably delegated to the attempted child is observed committed even with no child record. A present child record that contradicts the lineage degrades the observation.

A parent record that exactly matches the safe preimage is observed uncommitted. The rollback then proceeds to a clean abort.

Every other observation is incoherent: a delegation to a different child (`other-child`), a contradictory child record (`contradictory-child`), a record that matches neither the delegation nor the preimage (`drifted`), a missing parent (`missing`), or an unreadable one (`unreadable`). An incoherent terminal degrades without any destructive step. The child stays paused. The parent record is never restored over potentially committed lineage. The caller receives an `AggregateError` that keeps the original error first.

The labels are diagnostics only. Safety depends solely on continuing for `exact` and rolling back for `unchanged`. Rollback steps run at most once and never before the durability observation.

Rejected orderings include: remove-before-prepare, create-before-remove, commit-before-child, context authority before commit, publication before a durable commit plus activation plus start, rollback during an unresolved commit, and any rollback after a committed delegation.

Queue liveness is bounded with an admission fence. Queue ownership distinguishes admission from execution. A caller whose operation times out after 30 seconds is always released.

If the timeout fires before the queued function was admitted, the cancellation aborts the signal. The abandoned function performs zero writes when it eventually runs. The queue tail advances only to the previous tail. Later operations still wait for every earlier started write.

If the timeout fires after the function started, the queue tail stays owned until the underlying operation settles. Existing storage writes are not cancellable. Releasing the queue would let a newer write interleave with, or physically serialize behind, the still-running older one. Later profile writes stay serialized behind a started hung write. The caller timeout is a liveness guarantee for callers, not for the queue.

Every queued function checks its abort signal before each write. An abandoned (cancel-before-start) operation performs no writes. A late completion after abort is inert: its outcome is discarded and it cannot clear a newer generation's marker.

The model covers a sole live parent and a nested parent whose removal exposes an unrelated root task. Each path covers saved, unsaved, and workspace-locked profile states.

Invariants require: no pre-commit projection mutation, exactly one commit, one prepared generation binding child creation and authority, no unrelated-root mutation, and no empty or intermediate publication.

An injected legacy driver keeps the pre-fix remove-then-prepare flow with implicit-current-task targeting. The checker requires shortest counterexamples for both the empty publication after removing a sole parent and mutation of an exposed root. These are regression ratchets, not generally allowed states.

Responsibilities are split explicitly. The shared reducer defines the protocol and validates ordering. `ClineProvider` advances it at observable landmarks. The reducer never persists, never throws into the delegation flow, and never drives rollback. The checker explores the outcomes the reducer permits.

Settlement publication is asynchronous and policy-gated outside the delegation method. It stays model-only. The model keeps profile identities as opaque names/IDs. It does not model API secrets, provider construction, VS Code transport latency, filesystem durability, scheduler fairness, or crash/restart consistency.

A commit observed committed through reconciliation keeps the durable delegation and the running child in the model exactly as production does. Child history is modeled as absent in that case. An incoherent reconciliation appears as a labeled non-destructive degraded-abort. Recovery after a restart is not claimed here. The user-facing reopen flow and store-level guards handle that.

Started projection queue ownership is represented minimally. A started write is never modeled as cancelled. The child may start and publication may settle while the projection is still unresolved. The bounded queue's admission/execution distinction is enforced by the production tests in `src/__tests__/ClineProvider.delegation.spec.ts`, not re-modeled here.

That distinction is implemented once, centrally. A queued callback whose caller timed out, or whose provider is disposing, is rejected at admission before `fn` is called. Provider disposal aborts queued admissions, stops post-dispose marker/event updates, waits for started writes only to a bounded deadline, then detaches the queue with handled promises. Those bounds are production-test assertions, not model claims.

## Shared-store concurrency model

The same `pnpm lifecycle:model-check` command runs a second bounded explorer over two `TaskHistoryStore` hosts. It imports the production `computeHistoryDelta` and `mergeHistoryDelta` functions. Its semantics match the store. It does not assume coherent caches or transactional pair writes:

- each host has an independent cache and host-local mutex;
- store read/update operations hold the host mutex, while live-task snapshots used by completion and message saves may outlive it;
- a write delta is computed relative to that host's cache;
- revalidation under the per-file disk lock checks only status-transition legality;
- fields absent from the delta preserve the current disk value, `childIds` are unioned, and other same-field conflicts are last-writer-wins;
- `atomicUpdatePair` commits its files in order, with another host able to act between file commits;
- successful pair-operation cache entries publish together after both file writes; if the second write fails, the cache publishes only the first committed record;
- cache refresh is explicit and may occur after an external live-task snapshot was captured.

There is no production record version or compare-and-swap token. The model does not invent one. It checks host-mutex and file-lock ownership, whole-file delta rejection, disk-field preservation, `childIds` union, and pair write order.

Six scenarios must remain reachable without exceeding the state/depth budgets. These include distinct-task writes from [#920](https://github.com/Zoo-Code-Org/Zoo-Code/issues/920) and a second-write pair failure. All seven phases must remain reachable: `read`, `prepare`, `revalidate`, `commit`, `refresh`, `reject`, and `fail`. Positive semantic landmarks also require a stale cache beside newer disk state, the first pair write committed while the second is pending, and the same committed prefix kept after the second write fails.

`TaskHistoryStore.readFresh` is lock-aware. It takes the same per-file advisory `proper-lockfile` lock that `safeWriteJson` acquires for the same path, through the shared `withAdvisoryFileLock` helper. It runs behind the store's in-process write lock and follows the same lock order writers use. It therefore waits out an in-flight cross-host write. It can never observe the write's backup/commit rename gap as a transient `missing`.

`readFresh` is also identity-strict. A parsed record whose own `id` differs from the requested task ID is `incompatible` and is never cached under the requested key.

The bounded cross-host filesystem-lock behavior is not claimed by either model. It is proven by the production tests in `src/core/task-persistence/__tests__/TaskHistoryStore.spec.ts` (gated advisory-lock writer, two-instance read-under-write) and the real-lockfile smoke test below.

Two desired properties are currently false. They are tracked as issue-keyed shortest-witness ratchets, not silently allowed assertion failures:

- [#1469](https://github.com/Zoo-Code-Org/Zoo-Code/issues/1469): an old completion can commit after a newer handoff and clear it. Disk revalidation checks status legality, not exact-child ownership.
- [#1021](https://github.com/Zoo-Code-Org/Zoo-Code/issues/1021): after abandonment and cache refresh, a stale live-task save can keep the new interrupted status while restoring old lineage fields.

CI fails if the exact causal witness or violation class changes, a witness disappears without becoming a universal invariant, a named semantic landmark or modeled phase becomes unreachable, a new safety violation appears, or exploration truncates. Raw reachable-state totals are printed as diagnostics, not used as ratchets. Harmless representation changes can alter them without weakening protocol coverage.

The known-unsafe witnesses compare exact shortest action sequences. This is simple and reviewable, but brittle to harmless action renames or serialization refactors. A causal partial-order comparator would reduce that brittleness. It would also add a second trace-equivalence protocol to maintain. Update an exact witness only after confirming the terminal violation class and required causal ordering are unchanged.

`TaskHistoryStore.realConcurrency.spec.ts` complements the abstract interleavings with one synchronized integration smoke check through the real `proper-lockfile` and filesystem rename path. Broader VS Code E2E remains reserved for restart and extension-host behavior.

## Task cleanup protocol model

The umbrella command also runs a separate bounded model for in-memory abort, disposal, and provider-shutdown ordering. The model treats cleanup settlement and rejection as environment transitions. It makes no filesystem, editor Promise, fairness, or timing-liveness claim. See [Task cleanup protocol model check](./task-cleanup-protocol-model.md).

## Invariants

The checker currently enforces:

1. A delegated parent has exactly one `awaitingChildId`, and `delegatedToId` matches it.
2. The awaited child exists, links back to the parent, is not completed, and remains in `childIds`. A delegated child may itself await a nested child.
3. Non-delegated parents retain no active delegation pointer.
4. Every active or delegated linked child is the child its parent currently awaits. An interrupted prior child may retain lineage after re-delegation but cannot complete back into that parent.
5. Parent-child lineage is acyclic.
6. Completed task records cannot be changed by later lifecycle events.
7. Active-child re-delegation, stale completion after ownership moves to another child, duplicate/late completion, and abandonment of a live child are rejected by the shared production guards.

These are safety claims within the documented bounds. The check does not claim liveness, fairness, crash consistency, filesystem-lock correctness, API history correctness, or exhaustive coverage of arbitrary task counts. It also does not distinguish a delayed pre-interruption completion from a legitimate post-resume completion for the same child ID. That requires a persisted attempt/generation token before it can become a sound invariant.

## Open-issue traceability

The following table separates issue observations from the architectural interpretation encoded here. Open issues can change after this document is written. Follow each link for current status.

| Issue and directly observed evidence                                                                                                                                                                                                                                                                              | Derived protocol rule                                                                                                                                                                           | Production transition and current check                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#1469](https://github.com/Zoo-Code-Org/Zoo-Code/issues/1469): the issue report states that a barrier-controlled two-host run reproduced an old child completion clearing a newer handoff 25/25 times.                                                                                                            | Completion is conditional on the parent still awaiting that exact child; a live-linked child must remain owned by its parent.                                                                   | `completeDelegatedChild` rejects stale authoritative input. The lifecycle explorer checks that reducer rule, while the shared-store explorer reproduces the cross-host stale-cache counterexample with an exact causal witness.                                                                                                                                                                                                       |
| [#1021](https://github.com/Zoo-Code-Org/Zoo-Code/issues/1021): an in-flight `saveClineMessages` can restore parent/root IDs after abandonment cleared them.                                                                                                                                                       | Detachment should be monotonic: later lifecycle work must not reattach an abandoned child.                                                                                                      | `abandonDelegatedChild` clears both sides. The shared-store explorer proves the detach commit occurs, then reproduces a refreshed-cache delta that preserves interrupted status while restoring stale live-task lineage.                                                                                                                                                                                                              |
| [#1453](https://github.com/Zoo-Code-Org/Zoo-Code/issues/1453), under user report [#1279](https://github.com/Zoo-Code-Org/Zoo-Code/issues/1279): CI observed `TaskCompleted` before restart-visible API history once; 120 local repetitions did not reproduce it, while an Alloy abstraction permits the ordering. | A completion/readiness contract must define whether completion implies restart visibility. This is a liveness/durability boundary, not only a `HistoryItem` safety transition.                  | Not claimed by this checker. #1279 is resolved: `reopenParentFromDelegation` reads both UI and API history and saves them under the per-file advisory lock before the lifecycle transition, so the histories are durable before `TaskDelegationCompleted` fires. `restart-persistence.test.ts` is the controlled barrier test; move to temporal model checking if eventual readiness and failure handling become protocol guarantees. |
| [#921](https://github.com/Zoo-Code-Org/Zoo-Code/issues/921): delegation across parallel tabs lacks coverage for different view-local mode/profile state.                                                                                                                                                          | Delegation must bind an explicit immutable execution-context snapshot rather than read whichever view is focused later.                                                                         | The persisted ownership transition is covered; mode/profile snapshot isolation is outside this state model and belongs in a production adapter/model-based test.                                                                                                                                                                                                                                                                      |
| [#920](https://github.com/Zoo-Code-Org/Zoo-Code/issues/920): issue analysis identifies a missing cross-instance history-update test and potential lost writes.                                                                                                                                                    | Distinct task writes must not overwrite one another, and same-task conflicts need an explicit merge/ownership rule.                                                                             | The shared-store explorer checks distinct-task writes and same-record independent deltas. Cross-instance store tests retain production API coverage, and the synchronized real-filesystem smoke test exercises the actual lock/write path without claiming exhaustive filesystem proof.                                                                                                                                               |
| [#369](https://github.com/Zoo-Code-Org/Zoo-Code/issues/369) and [#372](https://github.com/Zoo-Code-Org/Zoo-Code/issues/372): planned fan-out keeps a parent live while a child runs and requires completion routing by explicit parent ID, single-writer result readiness, permit release, and orphan cleanup.    | Persisted `delegated` status is ownership, not proof that the parent instance is suspended. Completion must route by IDs; scheduler resources and live-instance state need separate invariants. | Nested and sibling lifecycle ownership are covered. Scheduler permits, live/suspended parent selection, orphan cancellation, and single-writer message readiness must be added when fan-out lands; they should not be folded into `HistoryItem` fields prematurely.                                                                                                                                                                   |
| [#1468](https://github.com/Zoo-Code-Org/Zoo-Code/issues/1468): a late chunk from one request combined tool identity with arguments from another request; rerun passed.                                                                                                                                            | Every stream accumulator needs a request/task generation key, and late events cannot mutate another scope.                                                                                      | Separate protocol. The [native tool-call parser request-scope model](./native-tool-call-parser-scoping-model.md), whose source of truth is `scripts/check-native-tool-call-parser-scoping.ts`, exhaustively replays bounded production-parser interleavings without adding fields to this lifecycle model.                                                                                                                            |
| [#612](https://github.com/Zoo-Code-Org/Zoo-Code/issues/612): the CLI copied a status union and omitted `interrupted`.                                                                                                                                                                                             | Lifecycle vocabulary should have one type owner.                                                                                                                                                | `HistoryItemStatus` is derived from `HistoryItem`, and production/checker transitions share `taskLifecycle.ts`; consumers should import rather than copy the union.                                                                                                                                                                                                                                                                   |

The issue-derived cases map to bug classes rather than issue-specific flags. In particular, stale event ownership, monotonic terminal/detached state, explicit scope, and single-writer boundaries generalize to future concurrent task work.

## Extending the model

When production lifecycle behavior changes:

1. Define or update the pure transition in `taskLifecycle.ts`, then call it from the production operation.
2. Model the corresponding enabled event in `scripts/check-task-lifecycle.ts`.
3. Encode an invariant for the bug class, or a representative rejected-event scenario when the event intentionally leaves state unchanged.
4. Increase depth or task slots only when the new scenario requires it. Keep the state budget explicit and make sure CI completes quickly.
5. Convert any discovered counterexample into a focused production regression test and keep the architectural invariant.

Do not weaken bounds or remove an invariant to make CI pass. If state growth becomes hard to control, split independent protocols or move the model to TLC/Quint with an implementation trace adapter. Do not silently sample the state space.

Parser request scoping is one such independent bounded submodel within the umbrella suite. Extend `scripts/check-native-tool-call-parser-scoping.ts` and its focused architecture document instead of adding parser state or transitions to `taskLifecycle.ts` or the persisted lifecycle state graph.

## Test layering

Keep reducer permutations in this model and focused Vitest suites. The real VS Code extension-host suite uses a mocked provider in `apps/vscode-e2e/src/suite/subtasks.test.ts`. It covers boundaries the pure explorer cannot: task creation and rehydration, persisted parent-child state, cancellation during a delayed provider stream, interrupted-child resume, abandonment followed by a real resume/save/completion cycle, pending approvals across leave/return, and scheduler-driven resume. `restart-persistence.test.ts` separately verifies completion history through a fresh extension host.

Add E2E coverage only when a lifecycle change crosses one of those runtime boundaries or introduces a new one. For example, #1453 persistence-readiness semantics require a controlled fresh-host test. #369/#372 fan-out requires scheduler permit, live-parent routing, orphan cleanup, and task-scoping E2E. Do not add E2E cases solely to replay reducer orderings already exhausted here. Those increase fixture and timing cost without strengthening the proof claim.
