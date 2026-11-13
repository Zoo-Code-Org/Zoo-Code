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

Two launch options are off by default. `testsPath` adds `--extensionTestsPath`
to the VS Code launch; that module's `run()` must never settle, because VS Code
exits once it does. `holdBeforeTeardownMs` holds the finished task on screen
for that window after the completion message, before teardown starts.

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
| `coding-side.mts`      | One comparison side: rebuilds the evaluated tree, then all fixtures times N repetitions on it, graded, with pinned inputs.                               |
| `coding-compare.mts`   | Two-commit comparison driver. Writes `comparison-report.json` and `comparison-report.md`.                                                                |
| `coding-trust.ts`      | The comparison trust policy: approved full commit SHAs, resolution, the approval gate, and the side environment allowlist.                               |
| `fs-atomic.ts`         | Atomic file publication through same-directory temp files and renames.                                                                                   |

### Grading

- The grader is model-free and credential-free. It judges the final workspace state only.
- The final workspace is captured as bounded file data and rebuilt as a fresh copy. Hidden acceptance tests enter only that copy, so the agent can never read or change them, and one run can never inherit another run's files.
- The default runtime executes the driver in a uniquely named disposable container with no network, no capabilities, no privilege escalation, a read-only root filesystem, and fixed CPU, memory, and process limits. No environment variable passes through. Only trusted repo code runs with the provider credential. Fixtures and extension code from outside pull requests never do.
- Hidden acceptance tests execute solution functions in separate permission-restricted processes and validate returned values in the trusted test process. Solution imports cannot replace the acceptance assertions. The grader has its own wall-clock limit. On expiry the runtime removes the container by name and verifies the removal before it deletes any output. A grader that hangs, crashes, or loses its runner is a `grading failure`. It is never an `incorrect` solution. The image pull happens before the timed run and never consumes grading time. The runtime resolves the immutable grader image digest from the local engine, and each graded run records its own identity. The container launches by that resolved identity rather than the mutable tag, and grading fails if no immutable identity is available. The side records that identity in the comparison pins and refuses to publish if run identities differ; it never fabricates a digest.
- The driver's result file is untrusted data: it is written inside the container where agent-written test code executes. The host reads it with a size bound and validates shape, bounds, and internal consistency. An invalid or inconsistent result is a `grading failure`, never a verdict.
- Each fixture ships two reference solutions. The known-correct solution must pass. The deliberately incorrect one passes the visible tests and must fail. Unit tests enforce both on every fixture.
- `createLocalSubprocessGradingRuntime` runs the same driver directly on the host. It does not give container isolation. It exists for unit tests and explicit local checks only and must never back a recorded comparison.
- The live `coding-evals:side` and `coding-evals:compare` entry points reject `--allow-unisolated-grading` instead of ignoring it. A recorded comparison always grades in the container runtime.
- The driver consumes structured Node test events. A trusted no-op after hook initializes per-file summaries for visible files. A naturally empty visible file contributes no test result; hidden tests still determine correctness. An explicit early exit lacks that completion summary and fails closed. stdout and stderr never supply verdict counts. Every literal test declaration in the frozen acceptance files must finish; a file-level pass or early successful exit is insufficient. Test children can read the grading workspace but cannot write files or launch processes.
- The driver publishes its result file atomically: the content lands in a unique same-directory temp file and is renamed into place. A failed write or rename removes the temp file, and the host treats a missing or invalid result as a grading failure.

### Comparisons

A paired comparison pins both commit SHAs, the suite digest, the settings digest, the model identifier, the grader version, the resolved grader image digest, and the runner environment on both sides. Any difference in a pinned value marks the pair incompatible. The report records the values and flags the pair instead of dropping it.

The default is three repetitions per fixture per commit. Reports show success rates with Wilson 95% intervals and paired differences. They make no significance claim: three repetitions can show large regressions, not small improvements.

Paired outcome, duration, and cost deltas report the sample standard error of the mean candidate-minus-baseline difference. This estimate is unavailable with fewer than two measured pairs. With small samples it can be unstable, including zero for identical deltas. It is not a significance test.

Runs with incomplete token or cost accounting are flagged and excluded from aggregate cost comparisons. Missing token or cost values stay missing. Each request records provider-reported input tokens and a separately labeled context estimate. When the trace has no per-request context estimate, that value is unavailable; the last cumulative context estimate is never substituted. The report states the price-table identifier and date and how cache reads and writes are priced. Cost per successful task divides the total attempt cost by the number of `correct` runs. It is unavailable when no run is correct, when a correct run lacks complete cost data, or when any attempt, including a failed one, lacks complete cost data. Duplicate-call detection and HTTP retry counts are reported as unavailable.

### Trust policy for comparisons

A comparison runs the extension code of two commits with the provider credential. A commit runs only when its full 40-hex SHA is listed in an explicit trust policy file. Ref names are resolved first and checked against the policy before any worktree is created or any process starts. A policy entry is a full SHA; short SHAs and ref names are rejected.

```json
{ "version": 1, "approvedCommits": ["<full-40-hex-commit-sha>"] }
```

The comparison driver, fixtures, grader, and report builder all run from the trusted checkout that invokes `coding-evals:compare`. Only the extension host loads an evaluated worktree. Worktree construction uses a private bare repository that borrows only Git objects. Source repository filters and hooks cannot run during checkout. The side process receives only the allowlisted environment plus the one named credential variable. The driver creates each side's fresh detached worktree of the approved commit. Each side then constructs its own fresh detached worktree of that same commit, installs the frozen lockfile dependencies and builds inside it, and launches every host against it, so each side runs only its own compiled extension of the approved commit. The install and the build consume the side's own wall clock (`--side-timeout-minutes`, default 120).

The side script runs the same gate on its own inputs. It requires `--trust-file`, resolves the full commit of its `--evaluated-root`, and rejects an unapproved or unreadable commit before it creates a host or reads the credential. It never executes a caller-prepared tree. After the gate it constructs a fresh detached worktree of the approved commit in private scratch space, verifies that the worktree resolves to the approved commit and holds no extra content, and then installs the dependencies from the frozen lockfile and builds inside that worktree with credential-free, allowlisted children. The side downloads VS Code once into fresh private scratch space and records a SHA-256 digest of the cache contents. Before each repetition it verifies the cache, copies it into private per-run scratch, and verifies the copy before launch. Evaluated hosts never receive the reusable cache path. Side and run cleanup remove their caches. It never executes a cached VS Code binary from the caller checkout. The host loads only build output this side produced from the approved commit, so dirty files, untracked files, ignored dependencies, stale build output, and symlinks in the caller's tree can never execute. The side removes its worktree on completion, on failure, and on interruption. Downloader children receive only the process allowlist plus `npm_config_proxy`, `npm_config_https_proxy`, and `NODE_EXTRA_CA_CERTS`. Proxy credentials stay out of evaluated build, host, and grader environments and reports. The `--credential-env` name must come from the supported provider variable allowlist; an arbitrary name can never forward an unrelated parent secret. Worktree install and build children receive an allowlisted environment and a temporary HOME with isolated XDG and npm configuration. Parent package-manager configuration and registry URLs are not forwarded. The prepared tree is checked against the raw bytes in the approved commit, and tracked symlinks are rejected.

Every driver child, the side included, runs detached in its own process group and is tracked by one guard. The driver's guard tracks the side; the side's guard tracks its own worktree, install, and build. A SIGINT or SIGTERM that reaches only the driver terminates the side group through a bounded SIGTERM-then-SIGKILL escalation. The side gives its preparation children a five-second grace and waits for termination before it removes its worktree or exits. It reports the active preparation group over IPC so the comparison can terminate that group if the side cannot finish shutdown. Side scratch directories live inside the comparison scratch tree during paired runs. Parent IPC disconnects enter the same SIGTERM shutdown path as signals, including host teardown, and stop further repetitions. The side also checks the connection at execution boundaries. The driver's worktree cleanup also waits for the driver's escalation before it removes any tree.

### Output publication contract

Artifacts are published atomically: content lands in a same-directory temp file and is renamed into place. A reader never sees a partial file.

A side run acquires an exclusive lock for its canonical output directory before invalidation and holds it through execution, publication, and final cleanup. An overlapping standalone side, including a symlink alias, fails before touching results. An interrupt during final cleanup removes the published result and artifacts before releasing the lock. Side locks live beside the canonical output directory, independent of temporary-directory environment variables. A heartbeat renews ownership every 10 seconds; abandoned locks expire after 30 seconds. Output paths cannot contain an `artifacts` component, including through symlink aliases, because that name is reserved for managed artifact trees. The comparison validates its temporary parent before creating scratch or worktrees. If that parent contains `artifacts`, set `TMPDIR` to a directory outside managed artifact trees.

A side run invalidates its output directory first. Before the first repetition executes, the side removes any previous `side-results.json` and then the whole `artifacts` tree, so stale results from an earlier rerun can never survive. The authoritative result goes first, so an error or an interruption during invalidation leaves the generation incomplete, and consumers fail closed until the new atomic publication. A repetition that throws has its partial artifact directory removed before the next repetition starts. If that cleanup fails, the side removes its completion marker and artifact tree and fails without publishing. `side-results.json` is the completion marker: it appears only after every repetition of the current invocation finished, and consumers must require it and treat its absence as a failed side. A side rerun that cannot remove a stale artifact fails before any repetition runs.

The side process arms one flag when it receives SIGINT or SIGTERM. The flag starts no further repetition and blocks the completion marker, so an interrupted side exits with the conventional signal code and publishes nothing.

Comparisons acquire an exclusive lock for the canonical output directory before invalidation and hold it through publication and all failure or interrupt cleanup. An overlapping comparison (including a symlink alias of `--out`) fails before touching reports. Locks live beside the canonical output directory, independent of `TMPDIR`; after a hard crash, remove a stale lock only after verifying no comparison owns that output.

The comparison reports are published as one generation. `comparison-report.json` and `comparison-report.md` carry the report's `generatedAt` stamp, and `comparison-report.complete` holds that stamp; it is written last. Consumers must require the marker and match its stamp against the report files. `readPublishedComparisonReport` enforces this: it returns the report only when the marker exists and its stamp matches both files. The marker is removed before publication starts, so a crash between the two file publications leaves a detectable incomplete generation instead of a mixed one. A thrown failure rolls both files back; a failed comparison leaves no report files. Cleanup waits up to 35 seconds for abandoned side locks to expire, preserves live writers, and retains the original failure alongside any cleanup errors.

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

Coding fixtures run in a host VS Code process without a filesystem sandbox. Command tools are disabled in both the mode and tool policy, and command auto-approval is off. Agents can read and edit workspace files; test execution happens only in the isolated grader. Fixture prompts do not request host commands.
