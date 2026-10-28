# Webview heap results — 2026-10-27

Measured with real VS Code 1.100.0 under Xvfb, using CDP forced GC on the Zoo Code
webview renderer target. These are deterministic saved-task workloads loaded through
the real extension host and task-resume path, not an organic human/model session.
The extension host, dependencies and styles are identical between variants. Both
webview builds use production minification without source maps. External network
requests are blocked except for the local mock model used to create the seed tasks.

- Base webview modules: `97228c7ca9b032e5fe466e57e24fe72fbf405192`.
- Candidate webview modules: `b9a6ba03cb93c0f92f06cfb00c82ae7d488db7cb`.
- Three fresh measurement sessions per workload and variant: 12 successful samples.
- Each large task has 602 UI messages, including 300 command/output pairs. Repeated
  uses 32 distinct large output strings; unique uses 300. Each output is 16.4–16.9 KiB.
  A full-state refresh after
  hydration exercises reuse across successive deserialized state snapshots.

These hashes identify the historical measured builds, not the current branch head.
The measurements below have not been rerun for subsequent review fixes.

Median forced-GC used heap, in MiB:

| Workload | Variant   | Empty | Large task loaded | Loaded − empty | After switching to small task |
| -------- | --------- | ----: | ----------------: | -------------: | ----------------------------: |
| Repeated | Base      | 26.46 |             41.42 |          14.71 |                         36.19 |
| Repeated | Candidate | 26.57 |             31.75 |           5.19 |                         31.85 |
| Unique   | Base      | 26.78 |             41.58 |          14.80 |                         36.27 |
| Unique   | Candidate | 26.57 |             36.63 |          10.07 |                         36.26 |

`Loaded − empty` is the median of each session’s loaded-minus-empty difference;
it need not equal the difference of the two column medians.

Loaded heap is approximately **9.67 MiB lower (23%)** for repeated outputs and
**4.95 MiB lower (12%)** for unique outputs. Baseline-adjusted task growth falls by
about 9.52 MiB and 4.73 MiB respectively. The unique workload still benefits from
sharing unchanged message strings across full-state pushes via `Object.assign`,
even after FIFO eviction. The cache can retain only about 120 strings of 16 KiB
within its 2M-character budget. Repeated outputs fit within that budget and benefit
from cache interning as well. These mechanisms explain the observed difference,
but this comparison does not isolate their individual contributions. These results do not
measure CPU overhead, image-rich messages, or continuously streamed task execution.

Loaded-heap ranges across the three sessions:

| Workload | Base MiB    | Candidate MiB |
| -------- | ----------- | ------------- |
| Repeated | 40.96–41.42 | 31.75–32.23   |
| Unique   | 41.14–41.59 | 36.62–36.64   |

## Task-switch retention

The candidate's StringCache maps retain **zero old output strings after switching**
in all six candidate samples. Before switching, the message cache contains 32
output strings in the repeated case and 115 in the unique case, consistent with its
character budget. The history cache contains no tool outputs.

However, old task output strings remain reachable elsewhere in **both** variants:
300 output string nodes on base, versus 32 repeated or 300 unique on candidate.
A shortest strong retaining path inspected in both switched snapshots runs through:

```text
webview Window → DOM node → __reactProps… → children → props
→ onJumpToPreviousCheckpoint → closure contexts → message array → message.text
```

This confirms cache cleanup, but does **not** establish complete task-memory release.
The callback/React-props retaining path needs a separate investigation; this benchmark
only measures the observed post-switch state and does not establish indefinite growth.
No forced remounts or additional product behavior changes were introduced here.

## Evidence and reproduction

See [README.md](./README.md) for commands and methodology. The raw artifacts are local, git-ignored evidence and are not distributed with this
report; reproducing the run is required to independently inspect them. The ignored
`apps/vscode-e2e/heap-results/` directory contains the 36 successful snapshots,
per-run measurements, build provenance, generated summary, cache-map inventory,
and representative base/candidate retaining paths under `analysis/`.

The final sample set consists of 11 successful matrix cases and a successful narrow
rerun of the first base case after fixing the diagnostic's resume-readiness check.
The failed setup attempt has no measurement record and is excluded from the summary;
its failure artifacts remain available. Package type checks and ESLint pass with no
new suppressions. No memory threshold is imposed on CI.
