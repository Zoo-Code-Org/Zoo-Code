# Task lifecycle remediation blocks

## One story point in this report

One story point (1 SP) is a small, independently reviewable **modeling or documentation increment**, not a time estimate. A 1-SP block owns one bounded behavior or property and must include:

- an explicit production symbol or boundary mapping;
- one model/checker change when a faithful model boundary exists, otherwise an explicit reason no checker is appropriate;
- focused test or CI evidence references;
- objective acceptance criteria and declared exclusions.

Completing one block does not close its `LIFE-GAP` unless the parent GAP closure criteria are also satisfied. Blocks may depend on shared primitives or earlier evidence, so story-point size does not imply scheduling independence.

## Ownership rules

- Every `LIFE-GAP-001` through `LIFE-GAP-038` has exactly one primary block below.
- A block owns exactly one GAP ID. Dependencies may reference other blocks but do not duplicate ownership.
- Block IDs are stable: `LIFE-BLK-P<workstream>-<gap number>`.
- Baseline blocks describe current serial production behavior. Optional fan-out is isolated under `FANOUT-BLK-*` and does not own a baseline `LIFE-GAP`.
- Each block is documentation/formal-model scope. Runtime work named in acceptance criteria belongs in a later implementation PR.

## P1: Persisted ownership and generation

| Block           | GAP | 1-SP increment                                                                                                        | Production/model/test mapping                                                                                                | Depends on                  | Acceptance                                                                                               |
| --------------- | --- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------- |
| LIFE-BLK-P1-001 | 001 | Encode authoritative awaited-child revalidation as a model boundary and retain the shortest stale-completion witness. | `TaskHistoryStore.atomicUpdatePair`, `ClineProvider.reopenParentFromDelegation`; shared-store checker; cross-instance tests. | None                        | Model names lock-time ownership check, witness, bounds, and production test required for promotion.      |
| LIFE-BLK-P1-002 | 002 | Specify lifecycle-owned lineage fields versus metadata writes and the stale-save witness.                             | `Task.saveClineMessages`, `taskMetadata`, `mergeHistoryDelta`; shared-store checker.                                         | P1-001 ownership vocabulary | Field ownership table and monotonic-detachment invariant are explicit; no claim of current safety.       |
| LIFE-BLK-P1-012 | 012 | Add attempt-generation state and stale-versus-resumed completion scenarios to the specification.                      | `PendingTaskAction.actionId`, interruption/resume/completion reducers; lifecycle checker exclusion.                          | P1-001                      | Two generations and acceptance/rejection landmarks are specified with a bounded future checker shape.    |
| LIFE-BLK-P1-017 | 017 | Inventory mutable cache read consumers and define immutable read semantics.                                           | `TaskHistoryStore.get/getAll`; store tests.                                                                                  | None                        | Every direct caller is classified; clone/freeze test criteria and compatibility exclusions are recorded. |
| LIFE-BLK-P1-020 | 020 | Define observable stale-cache and convergence histories.                                                              | watcher, `invalidate`, `reconcile`; shared-store landmarks and cross-instance tests.                                         | P1-001                      | Missed-watch and explicit-refresh histories have bounded properties and objective convergence evidence.  |

## P2: Durable operation and crash recovery

| Block           | GAP | 1-SP increment                                                             | Production/model/test mapping                                           | Depends on                 | Acceptance                                                                                  |
| --------------- | --- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------- |
| LIFE-BLK-P2-004 | 004 | Enumerate pair-write interruption points and legal recovered states.       | `atomicUpdatePair`; pair-failure landmark/tests.                        | P1-001                     | Every pre/post-write cut has one legal outcome and required fault-injection assertion.      |
| LIFE-BLK-P2-005 | 005 | Map delegation create/persist/publish/start cuts and rollback obligations. | `delegateParentAndOpenChild`; provider handoff model/tests.             | P1-001, P2-004             | Transition table covers every cut without claiming child/parent atomicity.                  |
| LIFE-BLK-P2-006 | 006 | Specify completion message/lifecycle commit phases and replay outcomes.    | `reopenParentFromDelegation`; completion and shared-store models.       | P1-012, P2-004             | Result visibility and lifecycle state are mapped for each injected failure point.           |
| LIFE-BLK-P2-021 | 021 | Define store close/drain semantics and post-dispose write exclusion.       | `TaskHistoryStore.dispose`, write lock; store tests.                    | P2-004 recovery vocabulary | A bounded close-state machine and deterministic pending-write test criteria are documented. |
| LIFE-BLK-P2-023 | 023 | Specify deletion unlink failure and reconciliation histories.              | `delete/deleteMany`, task directory/checkpoint cleanup; deletion tests. | P2-004                     | False-success and resurrection outcomes are explicit with tombstone/retry closure choices.  |

## P3: Schema, path, and vocabulary

| Block           | GAP | 1-SP increment                                                               | Production/model/test mapping                                                  | Depends on | Acceptance                                                                               |
| --------------- | --- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------- | ---------------------------------------------------------------------------------------- |
| LIFE-BLK-P3-013 | 013 | Publish the canonical persisted-status owner and copied-union inventory.     | `historyItemSchema`, task metadata, Task, CLI/history reader; typecheck/tests. | None       | Every copy is listed with replacement/static-ratchet criteria.                           |
| LIFE-BLK-P3-018 | 018 | Define normal-read validation and quarantine outcomes for malformed history. | `readTaskFile`, reconciliation, shared Zod schema; fixtures.                   | None       | Missing/invalid/legacy records have distinct expected outcomes and test fixtures.        |
| LIFE-BLK-P3-019 | 019 | Inventory every task-ID-to-path entry and one shared safe-ID contract.       | store paths, imports, deletion, checkpoints; traversal tests.                  | P3-018     | All path constructors are mapped and separator/traversal acceptance tests are specified. |

## P4: Request, stream, and tool identity

| Block           | GAP | 1-SP increment                                                             | Production/model/test mapping                                                        | Depends on                 | Acceptance                                                                                  |
| --------------- | --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------- |
| LIFE-BLK-P4-008 | 008 | Add transform-to-parser cases for argument-only deltas and absent indices. | Responses transform, parser APIs/tests.                                              | None                       | Two-call bounded schedules and expected isolated reconstruction are specified.              |
| LIFE-BLK-P4-010 | 010 | Define request-generation ownership for detached usage writes.             | Task request/drain paths; delayed-stream tests.                                      | P4-038 identity vocabulary | Old/new generation mutations and allowed accounting-only updates are explicit.              |
| LIFE-BLK-P4-024 | 024 | Map parser cleanup on success, abort, provider error, and replacement.     | parser scope plus Task request terminal paths.                                       | P4-010                     | Every terminal path owns cleanup; late-event exclusions are stated.                         |
| LIFE-BLK-P4-025 | 025 | Specify listener lifetime for one chunk race and long streams.             | `nextChunkWithAbort`; listener-count tests.                                          | None                       | Both race outcomes remove listeners and a bounded stream cannot accumulate them.            |
| LIFE-BLK-P4-026 | 026 | Model a true wall-clock deadline around pending iterator reads.            | detached usage drain; fake-timer tests.                                              | P4-010                     | Permanently pending `next()` has a terminal deadline transition and no stale mutations.     |
| LIFE-BLK-P4-030 | 030 | Define duplicate-start/run-promise identity.                               | `Task.start/run`, scheduler callback; Task tests.                                    | P4-010                     | Repeated starts share the actual settlement and cannot bypass scheduler ownership.          |
| LIFE-BLK-P4-037 | 037 | Specify call-scoped partial path state and two-call interleavings.         | `BaseTool.lastSeenPartialPath`, editing tool singletons; focused tests.              | P4-038, P4-010             | Equal/different path interleavings and sibling-safe cleanup are bounded and reachable.      |
| LIFE-BLK-P4-038 | 038 | Define canonical raw-to-durable call identity and collision witnesses.     | tool-ID utility, parser, Task history, results, pending actions; duplicate-ID tests. | None                       | Adversarial IDs preserve or explicitly reject one-to-one call/result/replay correspondence. |

## P5: Tool-owned task state and queueing

| Block           | GAP | 1-SP increment                                                                  | Production/model/test mapping                                             | Depends on | Acceptance                                                                                   |
| --------------- | --- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------- |
| LIFE-BLK-P5-003 | 003 | Map every queue consumer to claim/persist/ack or dequeue-before-submit.         | `MessageQueueService`, Task queue paths; failure tests.                   | None       | Every consumer is classified and message-retention failure evidence is specified.            |
| LIFE-BLK-P5-007 | 007 | Inventory mode-sensitive readers and authoritative task/provider source.        | handoff selector, environment/tool consumers; divergent tests.            | P4-010     | Each reader is classified; model premise is not described as reader refinement.              |
| LIFE-BLK-P5-031 | 031 | Define intentional versus accidental queue loss across task disposal/restart.   | queue service disposal and task lifecycle; E2E boundary.                  | P5-003     | Product contract, excluded durability, and restart witness are explicit.                     |
| LIFE-BLK-P5-035 | 035 | Specify durable child initialization precedence using initial todos as witness. | `NewTaskTool`, Task constructor, history/messages, rehydration, UI state. | P2-005     | Omitted, explicit-empty, initial, updated, switched, and restarted cases are mapped.         |
| LIFE-BLK-P5-036 | 036 | Model two approval identities and stale/cross-task todo edits.                  | `approvedTodoList`, webview handler, approval callbacks/tests.            | P4-038     | Two-task schedules require task/action/call correlation; current unsafe witness is explicit. |

## P6: Event and ingress contracts

| Block           | GAP | 1-SP increment                                                         | Production/model/test mapping                                                       | Depends on     | Acceptance                                                                             |
| --------------- | --- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------- |
| LIFE-BLK-P6-009 | 009 | Classify lifecycle events as awaited barriers or notifications.        | Task/provider/public emitters and listeners; event tests.                           | P1-012         | Every consequential listener has settlement and rejection semantics.                   |
| LIFE-BLK-P6-011 | 011 | Inventory `TaskCompleted` consumers and required durable observations. | completion tool, provider status, public API/IPC/telemetry; completion model/tests. | P6-009, P2-006 | Each consumer’s ordering requirement maps to focused evidence or exclusion.            |
| LIFE-BLK-P6-022 | 022 | Compare public and webview clear histories.                            | API eviction versus webview removal; provider tests.                                | P1-001         | Identical inputs produce an explicit same-or-deliberately-different persisted outcome. |
| LIFE-BLK-P6-027 | 027 | Establish one owner for delegation event emission.                     | task-level untyped and provider-level listeners; API tests.                         | P6-009         | Exactly-one source and no duplicate/dead listener are objective acceptance criteria.   |
| LIFE-BLK-P6-028 | 028 | Normalize `TaskSpawned` payload semantics in the contract map.         | task/provider/public event types and adapters.                                      | P6-027         | Parent/child fields are explicit at each boundary with compatibility requirements.     |
| LIFE-BLK-P6-029 | 029 | Document exact predicates behind `taskStatus` and `getRunning`.        | Task ask markers, registry abort flags; caller inventory.                           | None           | No caller may infer scheduler admission or persisted status without separate evidence. |
| LIFE-BLK-P6-032 | 032 | Decide supported reachability for webview abandonment.                 | protocol, handler, UI sender search; host tests.                                    | P6-022         | Add sender evidence or deprecation criteria; no unreachable feature claim remains.     |
| LIFE-BLK-P6-033 | 033 | Build a resume-ingress contract matrix.                                | webview/API/IPC resume adapters; provider/E2E tests.                                | P1-012, P6-009 | Awaiting, errors, publication, and rehydration results are explicit for each ingress.  |

## P7: Serial baseline and optional fan-out

| Block           | GAP | 1-SP increment                                                                        | Production/model/test mapping                                           | Depends on | Acceptance                                                                                |
| --------------- | --- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------- |
| LIFE-BLK-P7-014 | 014 | Ratchet the current singular-child/one-permit baseline and its cross-host exclusions. | lifecycle reducers/checker, provider scheduler, shared-store witnesses. | P1-001     | Baseline property, bounds, scheduler assumption, and stale-write exceptions are explicit. |

Optional future fan-out blocks do not own `LIFE-GAP-014` and do not participate in baseline closure:

| Optional block | Increment                                                    | Prerequisites                 | Acceptance                                                                         |
| -------------- | ------------------------------------------------------------ | ----------------------------- | ---------------------------------------------------------------------------------- |
| FANOUT-BLK-001 | Map live-parent and two-sibling production boundaries.       | LIFE-BLK-P7-014, P1 ownership | No production claim; all missing adapters are named.                               |
| FANOUT-BLK-002 | Specify reservation, rollback, and permit-release failures.  | FANOUT-BLK-001, P2 recovery   | Every acquisition/create failure has a legal terminal state.                       |
| FANOUT-BLK-003 | Specify result writer, explicit routing, and orphan cleanup. | FANOUT-BLK-001, P4 identity   | Existing abstract model landmarks map to required production APIs/tests.           |
| FANOUT-BLK-004 | Define extension/webview task-scoping E2E matrix.            | FANOUT-BLK-001–003            | Focus, messages, profiles, results, cancellation, and orphan behavior are covered. |

## P8: Verification and traceability platform

| Block           | GAP | 1-SP increment                                                      | Production/model/test mapping                   | Depends on              | Acceptance                                                                    |
| --------------- | --- | ------------------------------------------------------------------- | ----------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------- |
| LIFE-BLK-P8-015 | 015 | Select one cross-model claim and define executable boundary events. | Two relevant checkers plus production adapters. | Owning workstream block | Joint strategy is bounded or the claim remains explicitly local.              |
| LIFE-BLK-P8-016 | 016 | Add a machine-readable GAP-to-symbol/test/checker manifest design.  | report, scripts, package, workflows.            | None                    | CI validation rules detect missing paths, duplicate ownership, and stale IDs. |
| LIFE-BLK-P8-034 | 034 | Define emitted checker metadata for bounds/actions/landmarks.       | all checker scripts and docs.                   | P8-016                  | One schema represents model metadata and docs consume or validate it.         |

## Mechanical coverage check

The primary tables above map the closed integer range `001..038` exactly once. Reviewers should verify this mechanically before changing the register:

```sh
rg -o '^\| LIFE-BLK-P[0-9]-[0-9]{3} \|' docs/architecture/task-lifecycle-remediation-blocks.md \
  | sort \
  | uniq -d
```

The command must print nothing. It matches only primary table rows, so dependency references and optional `FANOUT-BLK-*` rows are excluded.

Separately compare block suffixes with the GAP column to detect omissions or mismatches:

```sh
node -e 'const fs=require("fs");const s=fs.readFileSync("docs/architecture/task-lifecycle-remediation-blocks.md","utf8");const rows=[...s.matchAll(/^\| LIFE-BLK-P\d-(\d{3}) \| (\d{3}) \|/gm)];const gaps=rows.map(r=>r[2]);const want=Array.from({length:38},(_,i)=>String(i+1).padStart(3,"0"));if(rows.length!==38||rows.some(r=>r[1]!==r[2])||want.some(id=>!gaps.includes(id)))process.exit(1)'
```

## Block completion template

- [ ] Stable block and parent GAP IDs are in the PR description.
- [ ] One bounded behavior/property and its exclusions are stated.
- [ ] Production symbols and ownership boundary are linked.
- [ ] Model/checker change is included, or non-applicability is justified.
- [ ] Focused test, E2E, and CI evidence requirements are explicit.
- [ ] Actions/landmarks remain reachable; bounds cannot truncate silently.
- [ ] Completion does not overstate parent GAP closure.
- [ ] Dependencies are satisfied or carried as explicit blockers.
