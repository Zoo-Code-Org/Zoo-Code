# Webview heap benchmark

See [RESULTS.md](./RESULTS.md) for the recorded comparison and its retention findings.

This opt-in diagnostic runs real VS Code, the extension host, task-history hydration,
extension/webview messaging and the production React webview. The model is a local
mock. It does not call a paid API or mutate your normal VS Code profile.

```sh
pnpm --dir apps/vscode-e2e heap:build
xvfb-run -a pnpm --dir apps/vscode-e2e test:heap
pnpm --dir apps/vscode-e2e heap:summarize
```

`heap:build` creates isolated base and candidate webview builds in `heap-results/builds`.
The extension host is identical for both. Base replaces `webview-ui/src/context/ExtensionStateContext.tsx`
with its version at `git merge-base HEAD origin/main`.
Override that reference with `HEAP_BASE_REF`. Source maps are disabled for both builds
to reduce build memory; production minification is preserved. Source files in your
checkout are untouched.

Each repetition creates two tasks through the exported API, evicts them, and stops
VS Code. With no extension host alive, it replaces the large task's persisted UI
transcript with 602 deterministic messages:
300 completed command/output pairs plus a title and completion. Each output contains
256 log lines (roughly 17 KiB). `repeated` uses 32 distinct output texts; `unique` uses 300. The isolated profile is restarted, and the normal task-resume path reads and posts
the transcript. This represents a
reproducible large saved task, not a recording of a human or live model session.

The driver waits for task-resume events, extension readiness files and rendered
completion markers. It requests a normal full-state refresh after each resume. It
then waits for fonts and two animation frames, forces GC through CDP attached to the
Zoo Code content frame, records `Runtime.getHeapUsage`, and streams a heap snapshot
to disk. This happens with no task loaded, with the large task loaded, and after
switching to a small task. A final snapshot can expose strings retained after the
task transition. This measures the webview renderer isolate, not extension-host heap
or whole-process RSS. External HTTP traffic is blocked (only the local mock model is reachable).
Playwright tracing is disabled to avoid retaining captured DOM
snapshots and message text during measurement.

The default is three fresh sessions per workload and variant (12 sessions). There is
no pass/fail memory threshold. Inspect distributions, baseline-adjusted differences,
and retaining paths before drawing conclusions. The summarizer reports median heap
sizes and counts large output string nodes in the loaded and switched snapshots.
It does not infer cache ownership solely from a surviving string.

Artifacts are ignored by git under `apps/vscode-e2e/heap-results/`: build provenance,
per-run `measurement.json`, three `.heapsnapshot` files, `summary.json` and `summary.md`.
Load snapshots in Chrome DevTools' Memory panel for retaining-path analysis. Temporary
profiles, workspaces and extension directories are removed on both success and failure;
failure logs and screenshots are copied to the run artifacts first.

Optional environment variables (use the same `HEAP_BENCHMARK_DIR` for all three commands):

- `HEAP_BENCHMARK_DIR`: absolute artifact/build directory.
- `HEAP_BASE_REF`: base commit or ref used by the comparison build.
- `HEAP_REPEATS`: repetitions per workload and variant (default 3).
- `HEAP_VSCODE_EXECUTABLE`: existing VS Code executable; otherwise download the pinned version.

For a smoke run: `HEAP_REPEATS=1 ... test:heap --project=candidate --grep=repeated`.
