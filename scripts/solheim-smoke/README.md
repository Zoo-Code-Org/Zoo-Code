# Project A: Solheim provider smoke

Infrastructure validation only: a real VS Code extension activates, accepts a correlated IPC task,
receives output from Solheim's OpenAI-compatible provider, and produces a completion result.
It does not read a PR, assess an answer's meaning, select checks, find defects, or post to GitHub.

The active workflow is `.github/workflows/solheim-provider-smoke.yml`. It is manual-only, restricted to
`refs/heads/main`, and checks out the exact triggering SHA. It builds trusted extension code before the
single credential-bearing step. There is one job, no PR input or approval gate, no review/posting job,
and `contents: read` is the only GitHub permission. This deliberately validates the provider integration
on main, not arbitrary PR artifacts. It is not a required PR review check.

The protected environment `final-vscode-review-smoke` and its secret `FINAL_SMOKE_OPENAI_API_KEY`
retain their existing names to avoid an unnecessary repository-settings migration. Restrict its deployment
policy to main and require approval. No environment or secret settings have been changed by this cleanup.

The provider endpoint and model are fixed: `https://api.solheim.ai/v1`, `qwen3.8-27b`. The task has no tool
groups; delegation, follow-ups, writes, shell and MCP are disabled. The driver opens an empty temporary
workspace with isolated VS Code storage and an allowlisted host environment. The provider credential is
supplied over IPC, not inherited by the child or passed on its command line. Temporary extension storage
can contain the configured credential while the session runs; it is removed at teardown and never uploaded.
This is process/environment isolation, not a sandbox for malicious extension code—CI runs trusted main only.

Activation and completion each have a 120-second limit; task-start acknowledgment has a 35-second limit,
with 30-second per-stage bounds in the extension. The live CI step has an eight-minute outer timeout.
Teardown escalates through close, terminate, and kill within independent five-second windows. A non-empty
completion and actual output-token usage must belong to the accepted task. Activation alone cannot pass.
The driver never approves dialogs or tool execution; it closes the task during teardown.

The action uploads `verdict.json` (fixed failure code, boolean gates, duration and provider/model names)
and `smoke.mp4`, a 1280×720, 12 fps screen recording of the fresh CI virtual display. It records up to
eight minutes / approximately 120 MiB, with bounded shutdown and seven-day artifact retention. Video
contains the visible smoke UI, potentially including the fixed prompt and model answer; unlike the verdict,
it is not text-redacted. No settings screen is opened, and no host logs, storage, task configuration or
credential files are uploaded. Fragmented MP4 preserves completed fragments on abrupt interruption.
Ordinary success and failure runs upload both artifacts; cancellation may prevent finalization/upload.

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
