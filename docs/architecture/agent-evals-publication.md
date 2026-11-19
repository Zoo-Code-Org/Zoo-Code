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

| Failure                                                               | Invariant                                                                     | Code boundary                                     |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------- |
| A marker exists before the data writes finish.                        | Commit runs after all data steps.                                             | `publishGeneration` calls `commit` after `steps`. |
| An interrupt arrives during a write, but publication returns success. | Check interruption before work and after each awaited step, including commit. | `publishGeneration` calls `check`.                |
| A write fails after it changes the output, and a marker remains.      | On failure, attempt rollback before returning or throwing.                    | `publishGeneration` calls `rollback`.             |
| Rollback fails, but the call reports a clean stop.                    | Cleanup failure throws and retains both causes.                               | `AggregateError` in `publishGeneration`.          |

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

Use the TLC command in [the spec policy](tla/AGENTS.md). Run these configs:

- `EvalPublication.cfg`: must pass.
- `EvalPublication.NoInterrupt.cfg`: must fail `SafeReturn`.
- `EvalPublication.EarlyCommit.cfg`: must fail `MarkerLast`.

Run `node --import tsx --test scripts/agent-evals/publication.test.ts`.
The property test enumerates generation sizes from one to four writes, every
interruption boundary, and every write-failure boundary. It also checks failed
rollback. Removing interruption checks or moving commit before the data steps
must make the property test fail.

Run `pnpm test:agent-evals:unit` and `pnpm agent-evals:check-types` after adapter
changes. Tests that use child process IPC need an environment that permits it.

For each later review finding, add the thread reference and its covered,
added, or gap result to the spec header, as the spec policy requires. Extend
this model only for publication failures. Use a separate subsystem model for
other contracts.
