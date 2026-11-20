# Evaluation output publication

The coding evaluation feature has two output owners. A side owns its run
artifacts and `side-results.json`. A comparison owns its JSON report, Markdown
report, and `comparison-report.complete`. Each owner must hold its output lock
through execution, publication, rollback, and final cleanup.

The common publication protocol is in
[`publishGeneration`](../../scripts/agent-evals/publication.ts). The model is
[`EvalPublication.tla`](tla/EvalPublication.tla). The model checks the protocol,
not the file system or the evaluation feature as a whole.

## Failures and invariants

| Failure                                                               | Invariant                                                                   | Code boundary                                     |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------- |
| A marker exists before the data writes finish.                        | Commit runs after all data steps.                                           | `publishGeneration` calls `commit` after `steps`. |
| An interrupt arrives during a write, but publication returns success. | Check interruption before work, before commit, and after each awaited step. | `publishGeneration` calls `check`.                |
| A write fails after it changes the output, and a marker remains.      | On failure, attempt rollback before returning or throwing.                  | `publishGeneration` calls `rollback`.             |
| Rollback fails, but the call reports a clean stop.                    | Cleanup failure throws and retains both causes.                             | `AggregateError` in `publishGeneration`.          |

The side adapter is `executeSideFlow`. Its data steps create artifact
directories, write run records, and build pinned results. Its commit writes
`side-results.json`. Its rollback attempts both result and artifact removal.

The comparison adapter is `publishComparisonReport`. It invalidates the old
marker before publication. Its data steps write JSON and Markdown. Its commit
writes the completion marker. Its rollback attempts all three removals.

The adapters keep their existing return contracts. A side returns
`completed: false` after a clean interruption. Comparison publication throws
on interruption; `executeComparisonFlow` maps the observed signal to the
comparison outcome after cleanup.

## Model boundary

The model starts after old output is invalidated and the output lock is held.
One data write represents the bounded sequence of data steps. The next write
represents commit. A write can fail at any point. A signal can arrive before,
between, or after writes, until the function returns.

Atomic writes and cleanup are oracles. A failed rollback can leave a marker,
but it must throw. The model does not claim that an interrupt removes a marker
before cleanup completes. Process crashes can also leave files. Readers must
keep using the existing generation validation rules.

Output lock acquisition, trust approval, credential isolation, child process
termination, grading, and telemetry are separate contracts. Their existing
tests still apply. This extraction does not model or change those contracts.

## Manual gate

Use the TLC command in [the spec policy](tla/AGENTS.md). Use `EvalPublicationMC.tla` as the module. Run these configs:

- `EvalPublication.cfg`: must pass.
- `EvalPublication.NoInterrupt.cfg`: must fail `SafeReturn`.
- `EvalPublication.EarlyCommit.cfg`: must fail `MarkerLast`.
- `EvalPublication.NoPreCommit.cfg`: must fail `CommitAllowed`.

Run `node --import tsx --test scripts/agent-evals/publication.test.ts`.
The property test enumerates generation sizes from one to four writes, every
interruption boundary, and every write-failure boundary. It also checks failed
rollback and an iterator that interrupts on its final `next()` call. Removing interruption checks or moving commit before the data steps
must make the property test fail.

Run `pnpm test:agent-evals:unit` and `pnpm agent-evals:check-types` after adapter
changes. Tests that use child process IPC need an environment that permits it.

For each later review finding, add the thread reference and its covered,
added, or gap result to the spec header, as the spec policy requires. Extend
this model only for publication failures. Use a separate subsystem model for
other contracts.

## Comparison review gate

The review added four models for separate source and sink contracts.
Each invariant was written after the review. These checks are review replays.
They are not independent findings. The models found no new code bug.

| Model module                 | Passing config             | Negative control and required failure                      |
| ---------------------------- | -------------------------- | ---------------------------------------------------------- |
| `EvalComparisonInputsMC.tla` | `EvalComparisonInputs.cfg` | `NoCheckKeys`: `KeysComplete`; `NoCheckTimer`: `TimerSafe` |
| `EvalOutputOwnershipMC.tla`  | `EvalOutputOwnership.cfg`  | `NoPinOutput`: `OwnedTarget`                               |
| `EvalReportReadMC.tla`       | `EvalReportRead.cfg`       | `NoRecheck`: `ReadResult`                                  |
| `EvalPreparationDrainMC.tla` | `EvalPreparationDrain.cfg` | `NoWaitClose`: `Drained`                                   |

Use the full config name, such as `EvalReportRead.NoRecheck.cfg`.
Run each config with its MC module and a state directory outside the repo:

```sh
cd docs/architecture/tla
java -XX:+UseParallelGC -cp /path/to/tla2tools.jar tlc2.TLC \
  -metadir /tmp/eval-report-read -config EvalReportRead.cfg EvalReportReadMC.tla
```

The input model checks complete fixture and repetition keys, matching metrics
keys, and the Node timer bound. Its parser and metrics values are oracles.
The ownership model checks that writes and rollback use the canonical directory
that the caller locked. It excludes movement of the canonical directory itself.
The read model checks a reader that captured marker A while a writer can remove
A and publish B. The file reads and validation results are oracles. The stamps
are unique within the model. The preparation model checks queued IPC delivery
before cleanup. Node emits `close` after that delivery; process termination is
an oracle. These models do not prove the code correct.

Run the code properties with:

```sh
node --import tsx --test scripts/agent-evals/publication.test.ts \
  scripts/agent-evals/coding-report.test.ts \
  scripts/agent-evals/coding-compare-driver.test.ts \
  scripts/agent-evals/coding-compare-script.test.ts
```

All nine new regression cases fail on the original PR head. They pass with
the fixes. The full evaluation suite passes 401 tests. The evaluation type
check and shared ESLint check pass. The `src` ESLint command excludes these
script files; it does not validate them. No suppression count changed.
The review has 0 covered findings, 7 added checks, and 4 gaps. The gaps are
the MC module layout and the README claims about container removal, commit compatibility, and missing
price metadata. The README now states the code behavior. The module layout and those prose claims
are outside these state models.

## Simplification gate

`codingRepetitionPlan` supplies the same fixture and repetition plan to the
live side and side-result validation. The fixture test uses literal expected
names and versions. It also checks order and fresh entries. It does not use
the plan builder to create its expected result. Removing one fixture from
the builder makes this test fail. Restoring the builder makes it pass.

`EvalPublication` now derives `result` from `phase`. The model has the same
25 reachable states. `Fail` includes all transitions of the former `Stop`
action, so the duplicate action is removed. All invariants and the three
negative controls retain their results.

`EvalOutputOwnership` uses one sink action for writes and rollback. The target
also records completion, so the separate operation variable is removed.
The fixed model has 4 reachable states, down from 6. `NoPinOutput` still fails
`OwnedTarget`. All five passing configs and eight negative controls retain
their expected results. The full evaluation suite passes 401 tests.
