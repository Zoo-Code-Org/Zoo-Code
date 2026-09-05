# Task lifecycle model-check suite

Zoo Code checks task lifecycle protocols through one compositional verification suite. Run the complete suite locally with:

```sh
pnpm lifecycle:model-check
```

The command runs four independent bounded submodels in sequence:

1. the persisted task delegation lifecycle;
2. shared-store concurrency across task-history hosts;
3. the task cleanup protocol; and
4. request-stream parser scoping.

This umbrella command is the single model-check entry point in the `compile` CI job after type checking. Command-level composition does not merge the submodels' state spaces: each checker retains its own bounds, transitions, invariant ownership, reachability requirements, and counterexample format. In particular, parser state is not part of the persisted lifecycle graph. The focused parser checker remains directly runnable with `pnpm parser-scope:model-check` for debugging.

An individual checker fails if it finds an invariant violation, a modeled action becomes unreachable, or exploration exceeds its declared state budget. A lifecycle violation includes the shortest breadth-first event trace, every intermediate state, and the active bounds so the sequence can be replayed as a focused regression test.

Executable cross-model composition should be added only when a correctness claim genuinely spans two or more submodels and there is an explicit, production-grounded boundary mapping between their events or state. That composition must state a bounded joint exploration strategy and own cross-model invariants that cannot be proved within either child model alone. Shared command orchestration or conceptual adjacency is not sufficient reason to multiply independent state spaces.

## Why an executable TypeScript model

The initial model uses a small explicit-state explorer rather than adding Quint, TLA+/TLC, or Alloy. This is deliberate:

- Zoo's current risks are finite safety properties over a small persisted state machine, not yet temporal liveness or fairness properties.
- The explorer calls the production transition functions in `src/core/task-persistence/taskLifecycle.ts`. `ClineProvider` uses those same functions inside serialized and atomic store operations, reducing specification drift.
- Breadth-first exploration gives a deterministic, shortest-by-event counterexample with no Java or separate specification toolchain.
- Bounds and budget exhaustion are explicit. CI never reports a truncated exploration as a pass.

This follows the same initial-state, next-state, reachable-state, invariant structure described by the [TLA+ high-level view](https://lamport.azurewebsites.net/tla/high-level-view.html) and [Quint's model-checker documentation](https://quint-lang.org/docs/model-checkers). The implementation connection is important: Quint's [model-based testing guidance](https://quint-lang.org/docs/model-based-testing) notes that checking a specification alone does not show that production code implements it.

TLA+/PlusCal or Quint with TLC becomes a better fit when the lifecycle needs temporal properties, fairness assumptions, unbounded queues, or refinement between protocol layers. Alloy is better suited if relational ownership structure becomes harder than event ordering; Alloy analyses are explicitly bounded by scope, as described in the [Alloy tutorial](https://alloytools.org/tutorials/online/maintext-FS-1.html). Randomized model-based testing can complement, but not replace, the exhaustive bounded check when a production adapter is available; [fast-check documents command models](https://fast-check.dev/docs/advanced/model-based-testing/) and [controlled Promise scheduling](https://fast-check.dev/docs/advanced/race-conditions/). Jepsen-style history checking remains useful for distributed persistence behavior, but is heavier than this in-process lifecycle protocol; see Jepsen's [consistency model overview](https://jepsen.io/consistency).

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

The model has three fixed task slots, enough to cover competing siblings and a nested parent-child-grandchild chain. It explores every reachable interleaving through depth 12, deduplicating canonical states. Representative checks also exercise rejected operations that do not create a new state: a second concurrent delegation while the first child is active, stale completion after re-delegation, late completion after abandonment, completion after interruption, and nested completion. Named semantic landmarks require the graph to retain interrupted-child re-delegation and nested delegation even when the raw state total changes.

Production completion also accepts a recovery-compatible `active` parent that still awaits the returning child, then clears the stale pointers. Normal model transitions never create that intermediate state, so it is covered by a focused reducer test rather than admitted as a generally valid reachable state.

## Shared-store concurrency model

The same `pnpm lifecycle:model-check` command also runs a second bounded explorer over two `TaskHistoryStore` hosts. It imports the production `computeHistoryDelta` and `mergeHistoryDelta` functions, so its semantics match the store rather than assuming coherent caches or transactional pair writes:

- each host has an independent cache and host-local mutex;
- store read/update operations hold the host mutex, while live-task snapshots used by completion and message saves may outlive it;
- a write delta is computed relative to that host's cache;
- revalidation under the per-file disk lock checks only status-transition legality;
- fields absent from the delta preserve the current disk value, `childIds` are unioned, and other same-field conflicts are last-writer-wins;
- `atomicUpdatePair` commits its files in order, with another host able to act between file commits;
- successful pair-operation cache entries publish together after both file writes; if the second write fails, the cache publishes only the first committed record;
- cache refresh is explicit and may occur after an external live-task snapshot was captured.

There is no production record version or compare-and-swap token today. The model therefore does not invent one. It universally checks host-mutex and file-lock ownership, whole-file delta rejection, disk-field preservation, `childIds` union, and pair write order. Six scenarios, including distinct-task writes from #920 and a second-write pair failure, and all seven phases (`read`, `prepare`, `revalidate`, `commit`, `refresh`, `reject`, and `fail`) must remain reachable without exceeding the state/depth budgets. Positive semantic landmarks additionally require a stale cache beside newer disk state, the first pair write committed while the second is pending, and the same committed prefix retained after the second write fails.

Two desired properties are currently false and remain issue-keyed shortest-witness ratchets rather than silently allowed assertion failures:

- [#1469](https://github.com/Zoo-Code-Org/Zoo-Code/issues/1469): an old completion can commit after a newer handoff and clear it because disk revalidation checks status legality, not exact-child ownership.
- [#1021](https://github.com/Zoo-Code-Org/Zoo-Code/issues/1021): after abandonment and cache refresh, a stale live-task save can preserve the new interrupted status while restoring old lineage fields.

CI fails if either exact causal witness or violation class changes, a witness disappears without being promoted to a universal invariant, a named semantic landmark or modeled phase becomes unreachable, a new safety violation appears, or exploration truncates. Raw reachable-state totals are printed as diagnostics, not used as ratchets: harmless representation changes can alter them without weakening protocol coverage.

The known-unsafe witnesses currently compare exact shortest action sequences. This is intentionally simple and reviewable, but brittle to harmless action renames or serialization refactors. A causal partial-order comparator would reduce that brittleness but would add a second trace-equivalence protocol to maintain. Until that complexity is justified, update an exact witness only after confirming the terminal violation class and required causal ordering are unchanged.

`TaskHistoryStore.realConcurrency.spec.ts` complements the abstract interleavings with one synchronized integration smoke check through the real `proper-lockfile` and filesystem rename path; broader VS Code E2E remains reserved for restart and extension-host behavior.

## Task cleanup protocol model

The umbrella command also runs a separate bounded child model for in-memory abort, disposal, and provider-shutdown ordering. It models cleanup settlement and rejection as environment transitions and makes no filesystem, editor Promise, fairness, or timing-liveness claim. See [Task cleanup protocol model check](./task-cleanup-protocol-model.md).

## Invariants

The checker currently enforces:

1. A delegated parent has exactly one `awaitingChildId`, and `delegatedToId` matches it.
2. The awaited child exists, links back to the parent, is not completed, and remains in `childIds`. A delegated child may itself await a nested child.
3. Non-delegated parents retain no active delegation pointer.
4. Every active or delegated linked child is the child its parent currently awaits. An interrupted prior child may retain lineage after re-delegation but cannot complete back into that parent.
5. Parent-child lineage is acyclic.
6. Completed task records cannot be changed by later lifecycle events.
7. Active-child re-delegation, stale completion after ownership moves to another child, duplicate/late completion, and abandonment of a live child are rejected by the shared production guards.

These are safety claims within the documented bounds. The check does not claim liveness, fairness, crash consistency, filesystem-lock correctness, API history correctness, or exhaustive coverage of arbitrary task counts. It also does not distinguish a delayed pre-interruption completion from a legitimate post-resume completion for the same child ID; that requires a persisted attempt/generation token before it can become a sound invariant.

## Open-issue traceability

The following map separates issue observations from the architectural interpretation encoded here. Open issues can change after this document is written; follow each link for current status.

| Issue and directly observed evidence                                                                                                                                                                                                                                                                              | Derived protocol rule                                                                                                                                                                           | Production transition and current check                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#1469](https://github.com/Zoo-Code-Org/Zoo-Code/issues/1469): the issue report states that a barrier-controlled two-host run reproduced an old child completion clearing a newer handoff 25/25 times.                                                                                                            | Completion is conditional on the parent still awaiting that exact child; a live-linked child must remain owned by its parent.                                                                   | `completeDelegatedChild` rejects stale authoritative input. The lifecycle explorer checks that reducer rule, while the shared-store explorer reproduces the cross-host stale-cache counterexample with an exact causal witness.                                                                            |
| [#1021](https://github.com/Zoo-Code-Org/Zoo-Code/issues/1021): an in-flight `saveClineMessages` can restore parent/root IDs after abandonment cleared them.                                                                                                                                                       | Detachment should be monotonic: later lifecycle work must not reattach an abandoned child.                                                                                                      | `abandonDelegatedChild` clears both sides. The shared-store explorer proves the detach commit occurs, then reproduces a refreshed-cache delta that preserves interrupted status while restoring stale live-task lineage.                                                                                   |
| [#1453](https://github.com/Zoo-Code-Org/Zoo-Code/issues/1453), under user report [#1279](https://github.com/Zoo-Code-Org/Zoo-Code/issues/1279): CI observed `TaskCompleted` before restart-visible API history once; 120 local repetitions did not reproduce it, while an Alloy abstraction permits the ordering. | A completion/readiness contract must define whether completion implies restart visibility. This is a liveness/durability boundary, not only a `HistoryItem` safety transition.                  | Not claimed by this checker. Add a controlled persistence barrier test after the contract decision; move to temporal model checking if eventual readiness and failure handling become protocol guarantees.                                                                                                 |
| [#921](https://github.com/Zoo-Code-Org/Zoo-Code/issues/921): delegation across parallel tabs lacks coverage for different view-local mode/profile state.                                                                                                                                                          | Delegation must bind an explicit immutable execution-context snapshot rather than read whichever view is focused later.                                                                         | The persisted ownership transition is covered; mode/profile snapshot isolation is outside this state model and belongs in a production adapter/model-based test.                                                                                                                                           |
| [#920](https://github.com/Zoo-Code-Org/Zoo-Code/issues/920): issue analysis identifies a missing cross-instance history-update test and potential lost writes.                                                                                                                                                    | Distinct task writes must not overwrite one another, and same-task conflicts need an explicit merge/ownership rule.                                                                             | The shared-store explorer checks distinct-task writes and same-record independent deltas. Cross-instance store tests retain production API coverage, and the synchronized real-filesystem smoke test exercises the actual lock/write path without claiming exhaustive filesystem proof.                    |
| [#369](https://github.com/Zoo-Code-Org/Zoo-Code/issues/369) and [#372](https://github.com/Zoo-Code-Org/Zoo-Code/issues/372): planned fan-out keeps a parent live while a child runs and requires completion routing by explicit parent ID, single-writer result readiness, permit release, and orphan cleanup.    | Persisted `delegated` status is ownership, not proof that the parent instance is suspended. Completion must route by IDs; scheduler resources and live-instance state need separate invariants. | Nested and sibling lifecycle ownership are covered. Scheduler permits, live/suspended parent selection, orphan cancellation, and single-writer message readiness must be added when fan-out lands; they should not be folded into `HistoryItem` fields prematurely.                                        |
| [#1468](https://github.com/Zoo-Code-Org/Zoo-Code/issues/1468): a late chunk from one request combined tool identity with arguments from another request; rerun passed.                                                                                                                                            | Every stream accumulator needs a request/task generation key, and late events cannot mutate another scope.                                                                                      | Separate protocol. The [native tool-call parser request-scope model](./native-tool-call-parser-scoping-model.md), whose source of truth is `scripts/check-native-tool-call-parser-scoping.ts`, exhaustively replays bounded production-parser interleavings without adding fields to this lifecycle model. |
| [#612](https://github.com/Zoo-Code-Org/Zoo-Code/issues/612): the CLI copied a status union and omitted `interrupted`.                                                                                                                                                                                             | Lifecycle vocabulary should have one type owner.                                                                                                                                                | `HistoryItemStatus` is derived from `HistoryItem`, and production/checker transitions share `taskLifecycle.ts`; consumers should import rather than copy the union.                                                                                                                                        |

The issue-derived cases intentionally map to bug classes rather than issue-specific flags. In particular, stale event ownership, monotonic terminal/detached state, explicit scope, and single-writer boundaries generalize to future concurrent task work.

## Extending the model

When production lifecycle behavior changes:

1. Define or update the pure transition in `taskLifecycle.ts`, then call it from the production operation.
2. Model the corresponding enabled event in `scripts/check-task-lifecycle.ts`.
3. Encode an invariant for the bug class, or a representative rejected-event scenario when the event intentionally leaves state unchanged.
4. Increase depth or task slots only when the new scenario requires it. Keep the state budget explicit and ensure CI completes quickly.
5. Convert any discovered counterexample into a focused production regression test as well as retaining the architectural invariant.

Do not weaken bounds or remove an invariant merely to make CI pass. If state growth becomes difficult to control, split independent protocols or move the model to TLC/Quint with an implementation trace adapter rather than silently sampling the state space.

Parser request scoping is one such independent bounded submodel within the umbrella suite. Extend `scripts/check-native-tool-call-parser-scoping.ts` and its focused architecture document instead of adding parser state or transitions to `taskLifecycle.ts` or the persisted lifecycle state graph.

## Test layering

Keep reducer permutations in this model and focused Vitest suites. The real VS Code extension-host suite using a mocked provider in `apps/vscode-e2e/src/suite/subtasks.test.ts` already covers the boundaries the pure explorer cannot: task creation and rehydration, persisted parent-child state, cancellation during a delayed provider stream, interrupted-child resume, abandonment followed by a real resume/save/completion cycle, pending approvals across leave/return, and scheduler-driven resume. `restart-persistence.test.ts` separately verifies completion history through a fresh extension host.

Add E2E coverage only when a lifecycle change crosses one of those runtime boundaries or introduces a new one. For example, #1453 persistence-readiness semantics require a controlled fresh-host test, and #369/#372 fan-out requires scheduler permit, live-parent routing, orphan cleanup, and task-scoping E2E. Do not add E2E cases solely to replay reducer orderings already exhausted here; they increase fixture and timing cost without strengthening the proof claim.
