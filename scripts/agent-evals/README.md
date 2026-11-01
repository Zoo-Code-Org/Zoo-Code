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
- The usage drain runs only after a `taskCompleted` event. It stays inside the
  bounded drain window.

## Checks

```sh
pnpm test:agent-evals:unit
pnpm agent-evals:check-types
```

Both run offline. No check spawns VS Code or touches a provider.

## Follow-up milestones

The substrate supports these planned steps. None of them exist in this
change:

1. Five frozen, real coding task fixtures with known-good workspaces.
2. Independent credential-free graders that judge workspace state only.
3. Paired exact trusted commit comparisons on the same fixtures.
4. Repeated runs with uncertainty reporting.
5. Advisory release integration aligned to the actual release workflows.
