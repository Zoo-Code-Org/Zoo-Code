# Agent evals fixture substrate

This directory holds the reusable, trusted fixture execution substrate. One
controller runs a registered fixture inside one isolated VS Code extension
host and writes a versioned, metadata-only structured trace. It carries no
knowledge of any provider, task solution, or grading rule.

## Layout

| File                               | Purpose                                                                                                                                            |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`contract.ts`](./contract.ts)     | Fixture contract and validation: identity, version, workspace files, prompt, tool policy, execution limits, settings projection, settings builder. |
| [`registry.ts`](./registry.ts)     | Trusted in-memory registry. Fixtures enter only through validated registration from repo code. No file, URL, or dynamic loading exists.            |
| [`runner.ts`](./runner.ts)         | Execution controller: startup correlation, bounded event buffering, request accounting, bounded teardown.                                          |
| [`trace.ts`](./trace.ts)           | Trace schema version 1, request accountant, stable digests, fixed notes.                                                                           |
| [`launcher.ts`](./launcher.ts)     | The single VS Code launcher: download, isolated spawn, IPC client, atomic artifact writes, run identity.                                           |
| [`isolation.ts`](./isolation.ts)   | Child environment allowlist and launch arguments.                                                                                                  |
| [`task-start.ts`](./task-start.ts) | Correlated StartNewTask waiter.                                                                                                                    |

## Fixture contract

A fixture is trusted in-repo data. The contract has no executable hooks, no
URLs, and no paths outside the declared workspace files. The only function is
`buildConfiguration(credential)`, which maps one credential to extension
settings. Validation rejects path traversal, drive letters, oversized files,
missing limits, and non-boolean tool allowances. The launcher repeats the
workspace containment check at write time.

Execution limits are enforced, not decorative. The controller applies the
activation, task start, task run, usage drain, and teardown step limits, and
the trace records the measured durations.

## Structured trace

Each run writes `trace.json` with `traceSchemaVersion: 1`. The trace is
metadata only. Prompts, model output, reasoning, tool arguments, error
payloads, and storage paths are excluded. Provider settings appear only as
the explicit nonsecret projection in `settings`.

Accounting rules:

- Request rows upsert by message timestamp across created and updated
  `api_req_started` messages.
- Usage snapshots come from extension events. The trace keeps the latest
  snapshot only and never sums cumulative snapshots.
- Zero token or cost values can be defaults from the adapter or the task
  layer. The trace labels event-sourced numbers and never claims a provider
  measured a zero.
- `contextTokens` is an extension context estimate.
- `apiReqRetriedMarkers` counts retry marker messages. It is not an HTTP
  retry count.
- Missing values carry a reason, such as `notReported` or
  `noUsageEventsObserved`. They are never filled with zero.
- The settings digest is SHA-256 over an explicit nonsecret projection. The
  run fails closed before launch if the projection contains the credential.
- Execution result, accounting completeness, and teardown status are three
  separate sections. A teardown failure never changes an execution code.

Events that arrive before the task start acknowledgment are buffered with a
fixed cap. After acceptance the controller replays only events that belong to
the accepted task and counts the rest as foreign or malformed. After an
extension-reported completion the controller drains late usage events for the
bounded drain window.

## Terminal code semantics

The trace carries two different completion signals. Reviewers must not merge
them:

- `COMPLETED` requires the extension `taskCompleted` event. The extension emits
  it only after the completion result is accepted, or a delegated subtask hands
  back, and the turn is persisted. A stop request, teardown, or a later session
  loss never changes this code.
- `execution.completionMessageSeen` records the final `completion_result`
  message for the accepted task. That message is model output, not acceptance.
  It never produces `COMPLETED`.
- `STOPPED` with `adapterStopAfterCompletionMessage` names an observer stop
  after that message. `STOPPED` with `adapterStop` names an observer stop
  without it. `TASK_RUN_TIMEOUT` is the bounded run window expiry. A seen
  message still appears in `completionMessageSeen`.
- `SESSION_LOST` covers disconnects and interrupts. A manual stop after
  completion output stays `SESSION_LOST`.
- The usage drain runs after a `taskCompleted` event and after an observer stop
  that followed the final `completion_result` message. It stays inside the
  bounded drain window. A plain stop, a run timeout, and a session loss get no
  drain.

## Checks

```sh
pnpm test:agent-evals:unit
pnpm agent-evals:check-types
```

Both run offline. No check spawns VS Code or touches a provider.

## Coding evaluation framework

The coding framework layers an evaluation on the substrate. It grades runs,
repeats them, and compares two exact commits. It stays independent from any
release process: a maintainer runs it locally or on demand.

| File                   | Purpose                                                                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `coding-fixtures.ts`   | Five frozen coding fixtures. Each ships a known-good workspace, one prompt, a tool policy, limits, hidden acceptance tests, and two reference solutions. |
| `coding-suite.ts`      | Suite identity `coding-basic-v1`, registration, and the suite content digest.                                                                            |
| `coding-workspace.ts`  | The immutable initial-state digest, fresh workspace builds, and fresh grading copies.                                                                    |
| `coding-grader.ts`     | The grader contract, version, driver invocation, and the local subprocess runtime.                                                                       |
| `grader-driver.mjs`    | The acceptance-test driver. Runs the workspace tests and writes one result JSON file.                                                                    |
| `container-runtime.ts` | The default grading runtime. Builds and runs the locked-down container invocation.                                                                       |
| `coding-outcomes.ts`   | Outcome rules: `correct`, `incorrect`, `timed out`, `grading failure`, `infrastructure failure`.                                                         |
| `coding-pricing.ts`    | The operator-maintained price table and the run cost estimate.                                                                                           |
| `coding-metrics.ts`    | Per-run metrics: requests, usage, tool calls, cost, unavailable telemetry, cost per successful task.                                                     |
| `coding-run.ts`        | One repetition: substrate run, final-workspace capture, grading, outcome, metrics.                                                                       |
| `coding-pins.ts`       | Pinned comparison inputs and the incompatibility check.                                                                                                  |
| `coding-stats.ts`      | Three repetitions, success rates with Wilson intervals, paired differences.                                                                              |
| `coding-report.ts`     | The self-contained JSON report and the Markdown renderer.                                                                                                |
| `coding-compare.ts`    | The comparison orchestration and the side result shape.                                                                                                  |
| `coding-side.mts`      | One comparison side: all fixtures times N repetitions on the evaluated root, graded, with pinned inputs.                                                 |
| `coding-compare.mts`   | Two-commit comparison driver. Writes `comparison-report.json` and `comparison-report.md`.                                                                |
| `coding-trust.ts`      | The comparison trust policy: approved full commit SHAs, resolution, the approval gate, and the side environment allowlist.                               |
| `fs-atomic.ts`         | Atomic file publication through same-directory temp files and renames.                                                                                   |

### Grading

- The grader is model-free and credential-free. It judges the final workspace state only.
- The final workspace is captured as bounded file data and rebuilt as a fresh copy. Hidden acceptance tests enter only that copy, so the agent can never read or change them, and one run can never inherit another run's files.
- The default runtime executes the driver in a uniquely named disposable container with no network, no capabilities, no privilege escalation, a read-only root filesystem, and fixed CPU, memory, and process limits. No environment variable passes through. Only trusted repo code runs with the provider credential. Fixtures and extension code from outside pull requests never do.
- The grader has its own wall-clock limit. On expiry the runtime removes the container by name and verifies the removal before it deletes any output. A grader that hangs, crashes, or loses its runner is a `grading failure`. It is never an `incorrect` solution. The image pull happens before the timed run and never consumes grading time. The runtime resolves the immutable grader image digest from the local engine and the side records it in the comparison pins; it never fabricates one.
- The driver's result file is untrusted data: it is written inside the container where agent-written test code executes. The host reads it with a size bound and validates shape, bounds, and internal consistency. An invalid or inconsistent result is a `grading failure`, never a verdict.
- Each fixture ships two reference solutions. The known-correct solution must pass. The deliberately incorrect one passes the visible tests and must fail. Unit tests enforce both on every fixture.
- `createLocalSubprocessGradingRuntime` runs the same driver directly on the host. It does not give container isolation. It exists for unit tests and explicit local checks only and must never back a recorded comparison.
- The live `coding-evals:side` and `coding-evals:compare` entry points reject `--allow-unisolated-grading` instead of ignoring it. A recorded comparison always grades in the container runtime.
- The driver publishes its result file atomically: the content lands in a unique same-directory temp file and is renamed into place. A failed write or rename removes the temp file, and the host treats a missing or invalid result as a grading failure.

### Comparisons

A paired comparison pins both commit SHAs, the suite digest, the settings digest, the model identifier, the grader version, the resolved grader image digest, and the runner environment on both sides. Any difference in a pinned value marks the pair incompatible. The report records the values and flags the pair instead of dropping it.

The default is three repetitions per fixture per commit. Reports show success rates with Wilson 95% intervals and paired differences. They make no significance claim: three repetitions can show large regressions, not small improvements.

Runs with incomplete token or cost accounting are flagged and excluded from aggregate cost comparisons. Missing token or cost values stay missing. The report states the price-table identifier and date and how cache reads and writes are priced. Cost per successful task divides the total attempt cost by the number of `correct` runs. It is unavailable when no run is correct, when a correct run lacks complete cost data, or when any attempt, including a failed one, lacks complete cost data. Duplicate-call detection and HTTP retry counts are reported as unavailable.

### Trust policy for comparisons

A comparison runs the extension code of two commits with the provider credential. A commit runs only when its full 40-hex SHA is listed in an explicit trust policy file. Ref names are resolved first and checked against the policy before any worktree is created or any process starts. A policy entry is a full SHA; short SHAs and ref names are rejected.

```json
{ "version": 1, "approvedCommits": ["<full-40-hex-commit-sha>"] }
```

The comparison driver, fixtures, grader, and report builder all run from the trusted checkout that invokes `coding-evals:compare`. Only the extension host loads an evaluated worktree. The side process receives only the allowlisted environment plus the one named credential variable. Each side installs dependencies from its own worktree's frozen lockfile and builds its own exact commit, so each side runs its own compiled extension. Each side has its own wall clock (`--side-timeout-minutes`, default 120).

The side script runs the same gate on its own inputs. It requires `--trust-file`, resolves the full commit of its `--evaluated-root`, and rejects an unapproved or unreadable commit before it creates a host or reads the credential. It also rejects an evaluated root whose tracked or untracked files differ from that commit, because the approval describes the commit and not the working tree. The check has one trust limit: ignored files, such as dependency installs and build outputs, stay outside commit identity and outside the check, so the approval never attests them. A recorded comparison closes that gap by loading only a fresh detached worktree built from the approved commit. The `--credential-env` name must come from the supported provider variable allowlist; an arbitrary name can never forward an unrelated parent secret. Worktree install and build children also receive only an allowlisted environment, so the driver's secrets never reach them.

Every driver child, preparation steps and the side alike, runs detached in its own process group and is tracked by one guard. A SIGINT or SIGTERM that reaches only the driver terminates the tracked group through a bounded SIGTERM-then-SIGKILL escalation, and the worktree cleanup waits for that escalation before it removes any tree.

### Output publication contract

Artifacts are published atomically: content lands in a same-directory temp file and is renamed into place. A reader never sees a partial file.

A side run invalidates its output directory first. Before the first repetition executes, the side removes any previous `side-results.json` and the whole `artifacts` tree, so stale results from an earlier rerun can never survive. `side-results.json` is the completion marker: it appears only after every repetition of the current invocation finished, and consumers must require it and treat its absence as a failed side. A side rerun that cannot remove a stale artifact fails before any repetition runs.

The side process arms one flag when it receives SIGINT or SIGTERM. The flag starts no further repetition and blocks the completion marker, so an interrupted side exits with the conventional signal code and publishes nothing.

The comparison reports are published as one generation. `comparison-report.json` and `comparison-report.md` carry the report's `generatedAt` stamp, and `comparison-report.complete` holds that stamp; it is written last. Consumers must require the marker and match its stamp against the report files. `readPublishedComparisonReport` enforces this: it returns the report only when the marker exists and its stamp matches both files. The marker is removed before publication starts, so a crash between the two file publications leaves a detectable incomplete generation instead of a mixed one. A thrown failure rolls both files back; a failed comparison leaves no report files.

### Commands

```sh
# Unit tests and type checks. Offline. No VS Code, no provider, no containers.
pnpm test:agent-evals:unit
pnpm agent-evals:check-types

# One comparison side against the real provider. Requires the trust policy,
# the credential environment variable, and the container runtime for grading.
pnpm coding-evals:side --reps 3 --out /tmp/side-out --trust-file trust-policy.json

# Full paired comparison of two approved commits.
pnpm coding-evals:compare --baseline <sha> --candidate <sha> --trust-file trust-policy.json --reps 3 --out /tmp/compare-out
```

### Follow-up milestones

1. Release integration: trigger runs, store baselines, and promote them. See issue #2085.
2. Later suites: repository navigation, debugging, and cost stress, toward the 21-task set.
3. Optimization experiments: per-request context instrumentation, non-progress loop detection, tool-output filtering, compaction strategies, and dynamic tool-schema loading.
