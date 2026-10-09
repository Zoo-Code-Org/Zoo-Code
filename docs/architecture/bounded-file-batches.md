# Bounded native file batches

Issue [#1948](https://github.com/Zoo-Code-Org/Zoo-Code/issues/1948) adds the companion
[`read_files`](../../src/core/prompts/tools/native-tools/read_files.ts#L8) native tool.
It avoids intervening model turns when the paths and reading ranges are already
known. It does **not** implement parallel dispatch or promise faster disk I/O.

## Contract and isolation

- One call contains 1–10 entries, each with the existing single reader's slice or
  indentation options. Strict providers can send null for optional values;
  other providers can omit them. The
  [shared validation schema](../../packages/types/src/read-files/read-files-params.ts) rejects
  legacy ranges, malformed options, oversized arrays, and empty paths.
- Both native definitions build their per-file parameters directly from the
  [independent shared schema](../../src/core/prompts/tools/native-tools/file-reading/readFileParameters.ts#L31).
  Each keeps its own top-level description; batch construction does not instantiate
  the single-file tool. Runtime defaults live in the
  [file-reading constants module](../../src/core/tools/file-reading/readFileConstants.ts).
- [`ReadFilesTool.execute()`](../../src/core/tools/file-reading/ReadFilesTool.ts#L27) processes
  entries sequentially and returns exactly one result. No general parallel-tool
  setting or provider change is required.
- Both tools reuse [`ReadFileTool.readEntry()`](../../src/core/tools/file-reading/ReadFileTool.ts#L96).
  Ordinary single-file calls and historical legacy calls retain their original
  schemas and routing. The old multi-file executor is not used by the new tool.
- Every entry passes the existing ignore check and gets its own ordinary
  single-file approval request, including its range/anchor and outside-workspace
  flag. Approving an earlier entry does not grant permission to another entry.
  Existing read allowlists and outside-workspace policy still apply independently.
  There is no new approval state or settings round trip.
- Text and supported extracted documents use the same modern slice/indentation
  reader. Extracted text is not returned through the unbounded legacy document
  path. Images, including text-based SVG, and unsupported binary formats receive
  explicit unsupported results. Use the ordinary single reader for images;
  its existing image-memory limits are unchanged. Batch model results are text-only.

## Results and interruption policy

Each result has an entry index, escaped path label, and status: success,
truncated, denied, blocked, error, unsupported, budget-exhausted, or cancelled.
Duplicate paths are separate indexed reads with independent approval requests.
Very long labels are explicitly abbreviated; the request index identifies the
original entry unambiguously.

Missing/unreadable files, unsupported formats, and ignore blocks do not discard
successful siblings or prevent later eligible reads. **User rejection stops the
batch:** the rejected entry is denied and all subsequent entries are cancelled.
Completed results remain present. Cancellation during an approval starts no read;
cancellation during an already approved read discards its in-flight result and
starts no subsequent read. The executor only observes existing task cancellation
flags; it does not mutate task lifecycle transitions. A failed/withdrawn approval
also cancels the remaining reads, even before cancellation flags propagate.

Line/range truncation includes continuation guidance. Additional budget clipping
keeps only complete numbered lines and resumes at the first undelivered line.
If no complete line fits, it does not advance the requested starting position.
Structural blocks can become incomplete under the aggregate budget and are
explicitly labelled as such. Long-line clipping is separately reported: changing
line offsets cannot recover a line's omitted suffix. Feedback and error excerpts
are bounded and explicitly marked when clipped.

## Aggregate budget

The [isolated budget helper](../../src/core/tools/file-reading/readFileBatchBudget.ts)
uses the active input window, latest context usage, the shared output-token reserve,
the existing 10% context safety margin, pending sibling tool results, and this
call's arguments. UTF-8 byte length provides a deliberately conservative text
token estimate rather than assuming four characters per token.

The [batch output accumulator](../../src/core/tools/file-reading/readFileBatchOutput.ts)
uses the [pure per-entry formatter](../../src/core/tools/file-reading/readFileBatchEntry.ts).
The **complete model-facing batch result has a 64 KiB absolute ceiling**. Metadata
for every entry is reserved before content allocation (1 KiB per entry plus the
batch header). The remaining content allowance is shared among remaining entries,
so a large first file cannot silently starve later files. Explicit line limits
and indentation caps are defensively clamped to 2,000 lines, and the byte budget
still clips the resulting text regardless of those limits. Paths, errors, user
feedback, extracted documents, and continuation messages cannot bypass the ceiling.

If context cannot accommodate the reserved result envelope, no files are opened
or approved. A bounded, content-free status manifest is still returned for every
entry, asking the model to free context before retrying. This minimal diagnostic
is unavoidable when requiring a result for every entry even with zero available
context; it does not turn zero available context into permission to read data.
The absolute ceiling applies to this manifest as well.

The reader continues to load/extract one source file at a time, as the existing
modern reader does. This is an output/context bound, not a new streaming disk-read
or document-extraction memory guarantee.

## Validation and local comparison

Coverage includes native schema/strict nulls, streaming/final parsing, modern
executor integration, per-file approvals and allowlists, outside-workspace
policy, cancellation, duplicate paths, missing files, aggregate output,
oversized limits, UTF-8 boundaries, extracted documents, unsupported images,
UI range/anchor navigation, and the Sol/Codex Lite single-call contract.

The [known-path comparison test](../../src/core/tools/file-reading/__tests__/readFilesTool.spec.ts#L319)
reads identical source/test ranges with two single-file calls versus one batch.
The source lines are asserted equivalent. On 2026-10-06, one local run recorded:

| Metric                                                |     Single-file |           Batch |
| ----------------------------------------------------- | --------------: | --------------: |
| Required tool-request turns on a single-call provider |               2 |               1 |
| Local reader workflow time, mocked immediate approval |        3.139 ms |        2.263 ms |
| Model-facing reader output                            | 388 UTF-8 bytes | 553 UTF-8 bytes |
| Repeated reads                                        |               0 |               0 |
| Read errors                                           |               0 |               0 |
| Actual paid/network model requests in this test       |               0 |               0 |

The turn counts follow from the single-call contract, not a recorded paid model
session. These tiny timing values are noisy, exclude model inference and human
approval, and **are not an end-to-end speedup benchmark**. Total real model task
time and model-induced retry/error rates remain unmeasured. Batching deliberately
adds status/continuation overhead; its benefit is removing an intervening model
turn, not necessarily reducing returned bytes.

Reproduce the local comparison from the extension package:

```sh
pnpm --dir src exec vitest run core/tools/file-reading/__tests__/readFilesTool.spec.ts -t 'compares equivalent' --no-silent
```

For a future real-provider comparison, use the same known paths/ranges, fresh
equivalent context and auto-approval policy, and record provider/model, actual
request count, whole-task wall time, total output bytes/tokens, repeated reads,
errors/retries, and clipping for both cases. Do not compare sequential local I/O
against unrelated parallel dispatch or claim a fixed speedup from the local test.
