# Project A: Solheim provider smoke

Infrastructure validation only: a real VS Code extension activates, accepts a correlated IPC task,
receives output from Solheim's OpenAI-compatible provider, and produces a completion result.
It does not read a PR, assess an answer's meaning, select checks, find defects, or post to GitHub.

The smoke is the first registered fixture of the shared substrate in
[`scripts/agent-evals`](../agent-evals/README.md). That substrate owns the fixture contract, the
trusted registry, the single VS Code launcher, startup correlation, bounded teardown, and the
metadata-only structured trace. [`run.ts`](./run.ts) is a thin adapter: it maps the shared
controller result onto the smoke evidence gates and verdict. The generic controller knows nothing
about Solheim, the prompt, or the expected completion.

The active workflow is `.github/workflows/solheim-provider-smoke.yml`. It is manual-only, restricted to
`refs/heads/main`, and checks out the exact triggering SHA. It builds trusted extension code before the
single credential-bearing step. There is one job, no PR input, no review/posting job,
and `contents: read` is the only GitHub permission. This deliberately validates the provider integration
on main, not arbitrary PR artifacts. It is not a required PR review check.

The protected environment `final-vscode-review-smoke` and its secret `FINAL_SMOKE_OPENAI_API_KEY`
retain their existing names to avoid an unnecessary repository-settings migration. The environment
requires the same reviewer approval as the `marketplace-production` deploy environment: a member of
the `Zoo-Code-Org/admins` team must approve each deployment before GitHub releases the secret. The
environment also allows deployments from one selected branch, `main`, and no tag policies. The
workflow keeps its own guard: the smoke job runs only on `refs/heads/main`. Workflow files cannot
declare reviewer rules; repository settings own both protections.

The provider endpoint and model are fixed: `https://api.solheim.ai/v1`, `qwen3.8-27b`. The task has no tool
groups; delegation, follow-ups, writes, shell and MCP are disabled. The driver opens an empty temporary
workspace with isolated VS Code storage and an allowlisted host environment. The provider credential is
supplied over IPC, not inherited by the child or passed on its command line. Temporary extension storage
can contain the configured credential while the session runs. It is removed when no child remains alive;
if termination fails, storage cleanup is skipped and `gates.childExited` reports that separately from the
original smoke failure. Storage is never uploaded.
This is process/environment isolation, not a sandbox for malicious extension code—CI runs trusted main only.

Activation and completion each have a 120-second limit; task-start acknowledgment has a 35-second limit,
in the controller. The extension awaits startup and configuration persistence without racing shared-profile
writes against a timer. If the controller times out, it tears down its isolated VS Code process rather than
trying to roll back shared settings or remove a possibly unrelated task. The live CI step has an eight-minute outer timeout.
Teardown escalates through close, terminate, and kill within independent five-second windows. A non-empty
completion and actual output-token usage must belong to the accepted task. Activation alone cannot pass.
The driver never approves dialogs or tool execution; it closes the task during teardown.

The `completionSeen` gate is the final non-empty `completion_result` message for the accepted task. That
message is model output. It is not the extension `taskCompleted` event, which fires only after a user
accepts the result. The driver never approves dialogs, so `taskCompleted` does not fire in a smoke run.
A passing smoke therefore ends with `execution.code: "STOPPED"` and
`stopReason: "adapterStopAfterCompletionMessage"` in `trace.json`. This is the expected terminal state.
It does not contradict the `OK` verdict. See
[`scripts/agent-evals/README.md`](../agent-evals/README.md) for the terminal code semantics.

The action uploads `verdict.json` (fixed failure code, boolean gates, duration and provider/model names),
`trace.json` (versioned metadata-only structured trace from the shared substrate; see
[`scripts/agent-evals/README.md`](../agent-evals/README.md) for its accounting limits), and `smoke.mp4`,
a 1280×720, 12 fps screen recording of the fresh CI virtual display. It records up to
eight minutes / approximately 120 MiB, with bounded shutdown and seven-day artifact retention. Video
contains the visible smoke UI, potentially including the fixed prompt and model answer; unlike the verdict
and the trace, it is not text-redacted. No settings screen is opened, and no host logs, storage, task
configuration or credential files are uploaded. Fragmented MP4 preserves completed fragments on abrupt
interruption.

The recorder writes ffmpeg output to a unique temporary file inside the smoke output directory, with the
MP4 muxer forced because the temporary name has no mp4 suffix. After bounded shutdown it publishes the
recording only when the file is non-empty and `ffprobe` accepts it, through an atomic same-directory
rename onto `smoke.mp4`. Every failed check removes the temporary file and leaves no final recording, and
a stale `smoke.mp4` from an earlier attempt in a reused directory is removed before recording starts.
ffmpeg exits non-zero after its graceful INT or TERM shutdown, so a recorder that was still alive at
shutdown is judged by content validation alone. A recorder that stopped on its own before shutdown must
have exited zero (the `-t` time or `-fs` size limits); any other self-chosen status fails the recording
even when the fragments would still probe. The wrapper reports failure reasons on stdout and keeps the
provider exit code unchanged. There is no separate persisted status marker: a published, non-empty
`smoke.mp4` is the only success marker, and the workflow checks exactly that.

The wrapper starts the Node driver directly, not through a package-manager wrapper, so its stop routine
signals and monitors the driver PID that owns teardown and the atomic verdict and trace writes. It sends
`TERM`, waits a budget, then escalates to `KILL` for that PID only. The budget defaults to 30 seconds and
covers the driver teardown worst case: three 5 second host termination windows plus cleanup and writes.
`SOLHEIM_SMOKE_STOP_BUDGET_S` overrides the budget for tests. A `KILL`ed driver can leave host processes
behind; no wrapper cleanup can repair that boundary.

Metadata (`verdict.json`, `trace.json`) and the video are uploaded as two separate artifacts, each with
`if-no-files-found: error`. A missing recording therefore fails its own upload step and the explicit
integrity check step, instead of hiding behind a multi-path upload. Verdict and trace evidence stay
available when the provider failed and the video is missing. Cancellation may prevent finalization and
upload.

Checks, without a provider key or network calls:

```sh
pnpm test:solheim-smoke:unit
pnpm test:solheim-smoke-ci
pnpm solheim-smoke:check-types
```

For an explicitly authorized local live run, build the extension/webview and supply `SOLHEIM_API_KEY`
through the environment, never an argument. Set `SOLHEIM_SMOKE_OUT_DIR` to a scratch directory and run
`pnpm solheim:smoke`. Linux needs Xvfb or an existing display. Do not run an untrusted extension with a key.
To record locally, install ffmpeg and run `xvfb-run -a -s "-screen 0 1280x720x24 -nolisten tcp"
bash scripts/solheim-smoke/record.sh` instead. Do not attach the recorder to your existing desktop.

The new simplified driver/workflow has not yet had a real-provider CI run. Earlier question-lane runs
established the underlying integration, not this refactor's live status. Review qualification stopped
after the frozen Stage 1B pilot produced zero incremental verified defects. Its research harness and
receipts are archived outside this smoke-only change; the chronology, results, caveats and preservation
details are recorded in [tracking issue #1896](https://github.com/Zoo-Code-Org/Zoo-Code/issues/1896).

Validation status, kept as two separate records. One user-reported local live run passed the smoke
verdict with `completionSeen: true`: total about 6390 ms, activation about 3010 ms, task about 3110 ms,
2719 input and 29 output tokens, two early buffered and replayed events, two cumulative usage snapshots,
and a clean teardown with no malformed, foreign, tool failure, or retry events. That trace reported
`STOPPED` with `adapterStopAfterCompletionMessage`, which matches the signal distinction above. This
report is not independently verified. The trusted-main workflow run is still pending. Only a
`.github/workflows/solheim-provider-smoke.yml` run on trusted main counts as verified CI evidence.

Planned follow-ups on top of the shared substrate, in order: five frozen real coding tasks, independent
credential-free graders, paired exact trusted commit comparisons, repeated runs with uncertainty
reporting, then advisory release integration aligned to the actual release workflows. They are tracked
in [`scripts/agent-evals/README.md`](../agent-evals/README.md).
