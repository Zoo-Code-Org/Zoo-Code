# Task lifecycle model-check suite

Zoo Code checks task lifecycle protocols through one umbrella command for independent bounded checks. Run the complete suite locally with:

```sh
pnpm lifecycle:model-check
```

The command runs seven independent bounded submodels in sequence:

1. the persisted task delegation lifecycle;
2. shared-store concurrency across task-history hosts;
3. production-backed handoff reducers with an abstract provider/scheduler protocol;
4. the task fan-out protocol;
5. the task cleanup protocol;
6. request-stream parser scoping; and
7. completion persistence.

This umbrella command is the single model-check entry point in the `compile` CI job after type checking. Command-level composition does not merge the submodels' state spaces: each checker retains its own bounds, transitions, invariant ownership, reachability requirements, and counterexample format. In particular, parser state is not part of the persisted lifecycle graph. The focused parser checker remains directly runnable with `pnpm parser-scope:model-check` for debugging.

An individual checker fails if it finds an invariant violation, a modeled action becomes unreachable, a named semantic landmark disappears, or exploration exceeds its declared state budget. A lifecycle violation includes the shortest breadth-first event trace, every intermediate state, and the active bounds so the sequence can be replayed as a focused regression test.

A checker printing `passed` means only that its configured bounded invariants, expected witnesses, reachability requirements, and state budget succeeded. It does not close a linked issue, prove arbitrary-task correctness, or establish refinement for production consumers that the checker does not execute.

Executable cross-model composition should be added only when a correctness claim genuinely spans two or more submodels and there is an explicit, production-grounded boundary mapping between their events or state. That composition must state a bounded joint exploration strategy and own cross-model invariants that cannot be proved within either child model alone. Shared command orchestration or conceptual adjacency is not sufficient reason to multiply independent state spaces.

## Why an executable TypeScript model

The models use small explicit-state explorers rather than adding Quint, TLA+/TLC, or Alloy. This is deliberate:

- Zoo's current risks are finite safety properties over a small persisted state machine, not yet temporal liveness or fairness properties.
- The delegation and shared-store explorers call production transition functions from `src/core/task-persistence`. `ClineProvider` uses those same functions inside serialized and atomic store operations, reducing specification drift for those protocols.
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

There is no production record version or compare-and-swap token today. The model therefore does not invent one. It checks host-mutex and file-lock ownership, whole-file delta rejection, disk-field preservation, `childIds` union, and pair write order in every state reachable within six bounded scenarios. Those scenarios include distinct-task writes from #920 and a second-write pair failure, and all seven phases (`read`, `prepare`, `revalidate`, `commit`, `refresh`, `reject`, and `fail`) must remain reachable without exceeding the state/depth budgets. Positive semantic landmarks additionally require a stale cache beside newer disk state, the first pair write committed while the second is pending, and the same committed prefix retained after the second write fails.

Two desired properties are currently false and remain issue-keyed shortest-witness ratchets rather than silently allowed assertion failures:

- [#1469](https://github.com/Zoo-Code-Org/Zoo-Code/issues/1469): an old completion can commit after a newer handoff and clear it because disk revalidation checks status legality, not exact-child ownership.
- [#1021](https://github.com/Zoo-Code-Org/Zoo-Code/issues/1021): after abandonment and cache refresh, a stale live-task save can preserve the new interrupted status while restoring old lineage fields.

CI fails if either exact causal witness or violation class changes, a witness disappears without being promoted to a universal invariant, a named semantic landmark or modeled phase becomes unreachable, a new safety violation appears, or exploration truncates. Raw reachable-state totals are printed as diagnostics, not used as ratchets: harmless representation changes can alter them without weakening protocol coverage.

The known-unsafe witnesses currently compare exact shortest action sequences. This is intentionally simple and reviewable, but brittle to harmless action renames or serialization refactors. A causal partial-order comparator would reduce that brittleness but would add a second trace-equivalence protocol to maintain. Until that complexity is justified, update an exact witness only after confirming the terminal violation class and required causal ordering are unchanged.

`TaskHistoryStore.realConcurrency.spec.ts` complements the abstract interleavings with one synchronized integration smoke check through the real `proper-lockfile` and filesystem rename path; broader VS Code E2E remains reserved for restart and extension-host behavior.

## Task cleanup protocol model

The umbrella command also runs a separate bounded child model for in-memory abort, disposal, and provider-shutdown ordering. It models cleanup settlement and rejection as environment transitions and makes no filesystem, editor Promise, fairness, or timing-liveness claim. See [Task cleanup protocol model check](./task-cleanup-protocol-model.md).

## Provider handoff and scheduler model

`scripts/check-provider-handoff-scheduler.ts` is a separate bounded adapter model for the runtime boundary that the persisted lifecycle graph does not represent. Its breadth-first explorer normalizes provider-keyed records and owner arrays before deduplicating canonical states, then exhaustively explores enabled action orderings through depth 15 with a 20,000-state budget. It imports `selectHandoffExecutionContext` and the existing `delegateTaskToChild` and `completeDelegatedChild` reducers. A direct saved, unsaved, and locked-profile matrix checks task-local configuration selection within those cases. Stale provider lookup is caught before this pure selector, so focused provider tests check the failed lookup, contextual log, and fallback. The protocol state then models two provider instances, their claims and parent snapshots, authoritative parent/child records, current task publication, commit/start ownership, the child scheduler permit, queued and resumed parent state, and one bounded redelegation generation.

Provider locking, paused-child/current-task publication, and semaphore admission/release are explicit model abstractions rather than imported production code. Focused provider and `TaskScheduler` tests cover those concrete adapters. Lifecycle commits and completion use the real reducers. Parent publication and its queued continuation share an explicit transition owner: the fixed policy retains that ownership through matching resume invocation, then models the resumed run settling outside transition ownership. This permits a new delegation generation to begin while the prior resumed run remains active without allowing a stale continuation to start across the newer transition. The fixed policy checks every successor for continuous publication, one child start and commit per generation, exact commit-before-start ownership, permit release before parent resume or redelegation, matching parent transition/continuation ownership at resume invocation, and consistent final child/parent publication. It also requires both resume phases, every other action, and named semantic landmarks to remain reachable and fails if the depth boundary has an unseen successor.

Six injected legacy transition policies must produce deterministic shortest counterexamples through the same explorer: start before commit, resume before permit release, redelegation before permit release, empty current-task publication, two stale provider commits from competing snapshots, and releasing parent-transition serialization immediately after publication. The last witness must causally include first-child completion and parent publication, a second-child commit, release of the first child's scheduler permit, and then the stale first-child continuation. The checker prints the distinct reachable-state count, complete scenario/action/landmark coverage, bounds, and each named counterexample trace. It deliberately does not add a WAL, global profile projection, or scheduler state to persisted `HistoryItem` records.

For #921, the execution-context matrix checks saved, unsaved, and locked profile selection at the handoff boundary. For that bounded matrix, it establishes only that delegation writes the requested task-local mode and cloned configuration into the child context. It does not prove that every downstream consumer reads that context. The checker retains a divergent-mode witness in which the child task mode differs from the shared provider mode so reader refinements can demonstrate that choosing the wrong source is observable.

Issue #1623 exposed that missing refinement: `getEnvironmentDetails`, `presentAssistantMessage` tool validation, and custom-tool execution still read shared provider mode after the handoff snapshot became task-local. PR #1625 owns the production fix and adds a dedicated delegated-mode reader check plus focused adapter tests. Until that runtime PR is merged, the selector model establishes the write-side premise and the divergent-mode witness traces the unresolved read-side obligation; it must not be cited as complete #921 coverage by itself.

## Task fan-out protocol model

`scripts/check-task-fanout-protocol.ts` is a separate bounded protocol model for the #369/#372 fan-out safety contract. It explores a live parent with two sibling slots, a two-permit scheduler, independent result readiness, explicit child-to-parent delivery, parent loss, orphan cancellation, and permit release. It checks scheduler capacity and exact permit ownership, one writer and at-most-once delivery per child, readiness before delivery, and no result routing after parent loss. Named landmarks require concurrent siblings beneath a live parent, out-of-order result delivery, parent loss while work is running, and complete orphan cleanup to remain reachable. Injected unsafe states confirm those invariants reject wrong writers, early and duplicate delivery, post-parent-loss routing, and scheduler over-allocation.

This model checks the intended abstract composition boundary without claiming that concurrent sibling fan-out is enabled in production. `TaskScheduler` already provides bounded permits and guaranteed release, and completion APIs route by explicit parent and child IDs; focused tests cover those adapters. Raising production concurrency still requires live-parent result integration and extension-host coverage before fan-out can ship. Keeping this state space separate preserves the serial handoff checker's one-child ownership invariants.

## Completion persistence model

`scripts/check-completion-persistence.ts` models the completion-readiness protocol that protects the public `TaskCompleted` event. It starts from both standalone and delegated tasks and exhaustively interleaves:

- starting, finishing, or failing the assistant-history write;
- accepting completion before, during, or after persistence;
- scheduling a bounded retry, completing its delay, and starting the retry write;
- exhausting retries;
- cancellation or disposal at every reachable non-completed state;
- delegated parent reopen success or failure after durable child history; and
- emitting completion.

The model abstracts restart visibility as the `durable` history phase. It allows an already-started write to finish after cancellation because the filesystem operation itself is not cancellable, but it forbids starting a retry write or emitting completion after cancellation. The retry bound is two write starts (the initial attempt plus one retry), which is sufficient to cover the ordering and cancellation state classes without mirroring the production retry count.

Seven semantic landmarks keep the intended positive and negative paths reachable: delayed completion remains pending, failed completion remains pending, exhausted retries settle without completion, cancellation can win after retry delay but before persistence, delegated reopen failure emits no delegated completion, and both standalone and delegated tasks can complete after durable history. The checker explores all reachable states through depth 10 and fails rather than reporting a truncated pass if an unseen successor remains.

## Invariants

The task delegation checker currently enforces:

1. A delegated parent has exactly one `awaitingChildId`, and `delegatedToId` matches it.
2. The awaited child exists, links back to the parent, is not completed, and remains in `childIds`. A delegated child may itself await a nested child.
3. Non-delegated parents retain no active delegation pointer.
4. Every active or delegated linked child is the child its parent currently awaits. An interrupted prior child may retain lineage after re-delegation but cannot complete back into that parent.
5. Parent-child lineage is acyclic.
6. Completed task records cannot be changed by later lifecycle events.
7. Active-child re-delegation, stale completion after ownership moves to another child, duplicate/late completion, and abandonment of a live child are rejected by the shared production guards.

The completion persistence checker additionally enforces:

1. `TaskCompleted` requires accepted completion and restart-visible assistant history.
2. Delayed, failed, and retry-exhausted persistence cannot emit completion.
3. Cancellation or disposal settles the modeled readiness wait, clears pending retry state, starts no later retry write, and emits no completion.
4. Delegated completion crosses the same durability boundary as standalone completion and requires successful parent reopen.
5. A failed delegated parent reopen cannot emit the delegated completion event.

These are safety claims within the documented bounds. The checks do not claim liveness, fairness, power-loss durability, filesystem-lock correctness, or exhaustive coverage of arbitrary task counts or retry counts. The completion explorer specifies the event contract rather than importing `Task` or `AttemptCompletionTool`; focused unit tests and the restart E2E verify that concrete production paths implement the modeled guards. Delegated reopen is abstracted as one success-or-failure event after durable child history; fallback from a failed reopen into the normal standalone completion flow remains production-test coverage rather than part of this model. The lifecycle checker also does not distinguish a delayed pre-interruption completion from a legitimate post-resume completion for the same child ID; that requires a persisted attempt/generation token before it can become a sound invariant.

## Coverage audit

| Protocol area                  | Coverage status                                                              | Production/model relationship                                                                                                              | Explicit limits and open points                                                                                                                                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delegation lifecycle           | Production-backed bounded universal                                          | The explorer calls the four production reducers for three task slots through depth 12.                                                     | Excludes provider instances, persistence failures, scheduler state, most live `Task` behavior, and generation identity for delayed pre-interruption completion. Recovery-compatible active-parent completion is test-only. |
| Shared-store concurrency       | Production-backed bounded scenarios plus known-unsafe witnesses              | The explorer imports production delta/merge functions and reducers; a real-filesystem test is a smoke check.                               | Does not prove crash safety, filesystem/lock semantics, arbitrary processes, or loss-free same-field merging. #1469 and #1021 remain unsafe.                                                                               |
| Provider handoff and scheduler | Mixed: production-backed reducers/selector plus abstract bounded protocol    | Commits use production reducers; provider ownership, publication, transition locks, and permits are model abstractions through depth 15.   | Selector correctness does not refine all downstream readers. Scheduler tests cover concrete permit behavior separately.                                                                                                    |
| Fan-out                        | Planned-only abstract bounded protocol over partial shipped primitives       | The model has two sibling slots and two abstract permits; production ships a scheduler and ID-routed serial completion primitives.         | Production fan-out, live-parent result integration, concurrent sibling E2E, and orphan discovery are absent.                                                                                                               |
| Cleanup                        | Abstract bounded universal plus adapter tests                                | Abort, disposal, settlement, rejection, and provider shutdown are modeled as protocol/environment actions.                                 | No direct execution of all production cleanup methods, filesystem/editor promises, timing liveness, fairness, or arbitrary task counts.                                                                                    |
| Parser request scope           | Production-backed bounded schedule replay                                    | The checker executes production parser APIs across 924 order-preserving schedules for two scopes.                                          | Assumes callers stop invoking a finalized scope; transport behavior, arbitrary request counts, indices, and malformed histories are outside the claim.                                                                     |
| Completion persistence         | Abstract bounded universal plus production tests and one fresh-host E2E path | The model abstracts persistence as a durable phase with at most two write starts; production guards and retry paths are tested separately. | Production permits more retries; no power-loss/filesystem proof, fairness, arbitrary retry count, complete delegated fallback, provider status metadata, or downstream event-consumer model.                               |

The production mapping above names primary lifecycle transitions, not every mutation or consumer. Generic store upserts, reconciliation, repair replay, migrations, tool entry points, webview/public API abandonment, provider status updates, and public `TaskCompleted` re-emission remain outside the persisted reducer graph unless explicitly named by a submodel or focused test. For task-local mode, the consumers named under #921/#1623 are a confirmed set, not an exhaustive repository-wide inventory; other mode-sensitive tools must be audited before claiming universal reader isolation.

CI runs `pnpm lifecycle:model-check` in `.github/workflows/code-qa.yml` after lint and type checking. Extension-host subtask and restart-persistence E2E run separately; a green umbrella command therefore says nothing about an omitted E2E boundary or an unmodeled downstream consumer.

### Open audit points

- No executable refinement currently composes persisted lifecycle ownership with provider publication, parser scope, completion durability, or cleanup. Their independent checks must not be combined into a stronger end-to-end claim.
- Generic history upserts, reconciliation, repair replay, and migrations need an explicit mutation inventory before the four lifecycle reducers can be called the only status/lineage writers.
- Public `TaskCompleted` re-emission and its downstream consumers are not part of the completion-persistence state space.
- Task-local mode readers need a repository-wide consumer inventory or enforceable API boundary before universal reader isolation can be claimed; open #1623 and PR #1625 cover the confirmed regression paths only, while closed #921 records the write-side snapshot history.
- Production fan-out needs its own live-parent integration and E2E evidence before the planned abstract model can be promoted to production-backed coverage.

## Open-issue traceability

The following map contains only issues confirmed open on GitHub as of 2026-09-13 that still have a production, model-refinement, or enforcement obligation. Closed reports and their still-relevant verification limits are retained separately under [Verified history and limitations](#verified-history-and-limitations). Coverage status uses these evidence classes:

- **Production-backed bounded:** exhaustive only for the declared state space while executing production functions.
- **Abstract bounded:** exhaustive only for model-authored transitions; refinement depends on separate adapter tests.
- **Known-unsafe witness:** CI preserves a reproducible violation and does not claim the property holds.
- **Proxy/partial:** evidence covers a premise, adapter, or representative path, not the full claim.
- **Planned-only:** specifies behavior not enabled in production.
- **Type/static convention:** centralized typing or guidance without repository-wide enforcement.

| Open issue                                                                                                                                                                                                               | Coverage status                                                                                                                | Remaining production/model obligation                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#1469](https://github.com/Zoo-Code-Org/Zoo-Code/issues/1469): stale completion can clear a newer handoff across hosts.                                                                                                  | **Known-unsafe witness** plus a production-backed reducer guard.                                                               | `completeDelegatedChild` rejects stale authoritative input, but store revalidation lacks exact-child ownership. CI ratchets the shortest violation; a passing checker confirms the witness, not safety.                                   |
| [#1021](https://github.com/Zoo-Code-Org/Zoo-Code/issues/1021): an in-flight save can restore lineage after abandonment.                                                                                                  | **Known-unsafe witness** plus a production-backed detach reducer.                                                              | `abandonDelegatedChild` clears both sides, but stale tasks or hosts can reattach lineage. Monotonic detachment remains unproved and unsafe.                                                                                               |
| [#1623](https://github.com/Zoo-Code-Org/Zoo-Code/issues/1623): delegated consumers can read shared provider mode despite a correct child snapshot.                                                                       | Write-side premise: **production-backed bounded matrix**. Confirmed readers: **proxy/partial and known unsafe** pending #1625. | [PR #1625](https://github.com/Zoo-Code-Org/Zoo-Code/pull/1625) remains open and owns fixes/tests for environment, validation, and custom-tool readers. A repository-wide mode-consumer inventory or enforceable boundary is still absent. |
| [#369](https://github.com/Zoo-Code-Org/Zoo-Code/issues/369) and [#372](https://github.com/Zoo-Code-Org/Zoo-Code/issues/372): fan-out needs live-parent isolation, result ownership/routing, permits, and orphan cleanup. | **Planned-only abstract bounded** protocol with partial shipped primitives.                                                    | The two-sibling model imports no production fan-out transition. Production fan-out, rollback/isolation, live-parent injection, concurrent sibling E2E, and orphan handling remain open.                                                   |
| [#612](https://github.com/Zoo-Code-Org/Zoo-Code/issues/612): the CLI copied lifecycle status vocabulary.                                                                                                                 | Repaired symptom plus unresolved **type/static convention**.                                                                   | CLI unions now include `interrupted`, but `HistoryTrigger.tsx` still duplicates the union. No shared imported owner or repository-wide rule prevents future drift.                                                                        |

## Verified history and limitations

These closed issues remain useful provenance for regression checks and documented limits, but they are not open work items. Moving them out of open-issue traceability does not upgrade their evidence class or erase adjacent risks.

| Closed issue                                                                                                                      | Resolved/historical evidence                                                                                                                                              | Coverage and limitations retained                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#1453](https://github.com/Zoo-Code-Org/Zoo-Code/issues/1453) under [#1279](https://github.com/Zoo-Code-Org/Zoo-Code/issues/1279) | Completion readiness is guarded in production, with focused `Task`/`AttemptCompletionTool` tests and a fresh-host restart E2E. Both issues are closed.                    | The ordering model remains **abstract bounded**: at most two write starts, abstract durability/reopen, no power-loss claim, and no model of every downstream `TaskCompleted` consumer.             |
| [#921](https://github.com/Zoo-Code-Org/Zoo-Code/issues/921)                                                                       | Explicit handoff snapshots and the selector matrix cover the historical parallel-view write-side problem; the issue is closed.                                            | This is **production-backed bounded** write-side evidence, not universal consumer isolation. The distinct open reader regression is tracked by #1623 and PR #1625.                                 |
| [#920](https://github.com/Zoo-Code-Org/Zoo-Code/issues/920)                                                                       | Production delta/merge behavior, bounded cross-instance scenarios, focused tests, and a real-filesystem smoke test cover distinct-task preservation; the issue is closed. | Same-field conflicts remain last-writer-wins; crash/filesystem/lock semantics and arbitrary processes are outside scope. Concrete unsafe same-record races remain tracked by open #1469 and #1021. |
| [#1468](https://github.com/Zoo-Code-Org/Zoo-Code/issues/1468)                                                                     | The production parser is request-scoped and the checker replays 924 bounded two-scope schedules; the issue is closed.                                                     | Coverage remains **production-backed bounded** and assumes no calls after finalization; transport behavior, arbitrary indices/request counts, and malformed histories are excluded.                |

The issue-derived cases intentionally map to bug classes rather than issue-specific flags. In particular, stale event ownership, monotonic terminal/detached state, explicit scope, and single-writer boundaries generalize to future concurrent task work.

## Extending the model

When production lifecycle behavior changes:

1. Define or update the pure transition in `taskLifecycle.ts`, then call it from the production operation.
2. Model the corresponding enabled event in `scripts/check-task-lifecycle.ts`.
3. Encode an invariant for the bug class, or a representative rejected-event scenario when the event intentionally leaves state unchanged.
4. Increase depth or task slots only when the new scenario requires it. Keep the state budget explicit and ensure CI completes quickly.
5. Convert any discovered counterexample into a focused production regression test as well as retaining the architectural invariant.

Completion-readiness changes belong in `scripts/check-completion-persistence.ts`; shared-store interleavings belong in `scripts/check-task-store-concurrency.ts`; fan-out permit, result-routing, and orphan-cleanup changes belong in `scripts/check-task-fanout-protocol.ts`. Do not weaken bounds or remove an invariant merely to make CI pass. If state growth becomes difficult to control, split independent protocols or move the model to TLC/Quint with an implementation trace adapter rather than silently sampling the state space.

Parser request scoping is one such independent bounded submodel within the umbrella suite. Extend `scripts/check-native-tool-call-parser-scoping.ts` and its focused architecture document instead of adding parser state or transitions to `taskLifecycle.ts` or the persisted lifecycle state graph.

## Test layering

Keep reducer permutations in this model and focused Vitest suites. The real VS Code extension-host suite using a mocked provider in `apps/vscode-e2e/src/suite/subtasks.test.ts` already covers the boundaries the pure explorer cannot: task creation and rehydration, persisted parent-child state, cancellation during a delayed provider stream, interrupted-child resume, abandonment followed by a real resume/save/completion cycle, pending approvals across leave/return, and scheduler-driven resume. `restart-persistence.test.ts` separately verifies completion history through a fresh extension host.

Add E2E coverage only when a lifecycle change crosses one of those runtime boundaries or introduces a new one. For example, #1453 persistence-readiness semantics require a controlled fresh-host test, and #369/#372 fan-out requires scheduler permit, live-parent routing, orphan cleanup, and task-scoping E2E. Do not add E2E cases solely to replay reducer orderings already exhausted here; they increase fixture and timing cost without strengthening the proof claim.
