---
name: probe-vscode-lm-api
description: How to empirically probe the VS Code Language Model API (`vscode.lm`) with a scratch extension against a real extension host, and the measured findings about Copilot Claude models leaking tool-call markup into text. Use when asked to "test the vscode.lm API", "probe Copilot model behavior", "capture a raw LM transcript", "does the model leak tool-call markup", "verify LanguageModelToolCallPart behavior", or when reasoning about `extractLeakedToolCalls()` in the vscode-lm provider.
---

# Probing the VS Code LM API Empirically

## When to Use This Skill

- A claim is being made about what a Copilot-backed model _actually_ emits over `vscode.lm` (tool-call parts vs. text), and it needs evidence rather than inference.
- Changing [`extractLeakedToolCalls()`](../../../src/api/providers/vscode-lm.ts) or its guards, and you need a false-positive corpus.
- Any question that can only be answered by real `model.sendRequest()` traffic — the mocked unit tests cannot answer it.

## When NOT to Use This Skill

- Ordinary provider work covered by [`src/api/providers/__tests__/vscode-lm.spec.ts`](../../../src/api/providers/__tests__/vscode-lm.spec.ts). Live probing is slow and burns Copilot quota.
- Anything about non-`vscode-lm` providers. Anthropic-API behavior does not transfer.

## Running the Probe

Scripts live in [`scripts/probe-vscode-lm-api/`](../../../scripts/probe-vscode-lm-api/) at the repo root.

1. Copy `scripts/probe-vscode-lm-api/package.json` and `scripts/probe-vscode-lm-api/extension.js` into a scratch directory, e.g. `<repo>\.tmp\lmprobe\`. No build, no `npm install` — it is plain CommonJS against the `vscode` module.
2. Adjust `OUT_DIR` at the top of the copied `extension.js` (or set `LM_PROBE_OUT_DIR`) to the transcript output directory.
3. Launch a **new** extension host window:

```
code --extensionDevelopmentPath=<repo>\.tmp\lmprobe --new-window <repo>
```

4. In that new window: `Ctrl+Shift+P` -> **LM Probe: Run** (or click "Run probe" on the toast).
5. Wait for the completion notification. Transcripts and `summary.json` land in `OUT_DIR`.

Each run writes a `.json` of every stream part and a `.txt` of the exact concatenated text, named `<modelId>__<scenario>__run<N>`.

### Delegate the UI driving

Steps 3-5 involve a live window. Delegate them to **`ui-operator`** mode rather than doing them inline; screenshots and control trees consume large amounts of context.

## Gotchas

### The consent gate needs a real user gesture

**Do not call `model.sendRequest()` from `activate()`.** Every request fails with:

```
Language model '<model-id>' cannot be used by '<publisher>.<ext-id>'
```

This is not a quota, auth, or manifest problem — `vscode.lm` grants consent only in response to a genuine user gesture. The probe must therefore be triggered from the Command Palette (or a notification button click). This is the single most expensive trap here; it silently fails 100% of requests and looks like an entitlement bug.

### Never `Stop-Process` filtered on window title

**WARNING:** During this experiment, killing processes matched by window title destroyed the user's unrelated VS Code windows and their unsaved work.

Safe alternative: only ever _launch_ new windows with `--new-window`, and close the probe window by hand. Never bulk-terminate `Code.exe` by title, `MainWindowTitle`, or any other fuzzy match.

### Run tests with pnpm, not npx

```
pnpm --dir src exec vitest run <path>
```

Never `npx vitest` — it resolves a wrong hoisted 3.2.4 instead of the pinned 4.1.9 and produces phantom failures.

## Measured Findings

Sample: 210 live requests, 7 Copilot Claude models x 6 scenarios x 5 repeats, 0 errors. The raw transcripts were not retained; the counts below are the retained record of that run, and re-running the probe is the way to regenerate the underlying evidence.

| Scenario | Setup                                     | Runs | `<invoke` in text |
| -------- | ----------------------------------------- | ---- | ----------------- |
| A        | tools declared + agent system prompt      | 35   | 0                 |
| B        | tools declared, no system prompt          | 35   | 0                 |
| C        | tools declared + ~300KB filler context    | 35   | 0                 |
| D        | no tools, model asked to emit the markup  | 35   | 14                |
| E        | asked to quote the markup in prose        | 35   | 23                |
| F        | asked to quote the markup in a code fence | 35   | 21                |

Observations:

- **The leak did not reproduce.** 105/105 tool-declared runs (A+B+C) emitted a proper `LanguageModelToolCallPart` and leaked nothing into text parts. This bounds the leak rate at a low value; it is **not** proof of absence. 105 runs across 7 models cannot exclude a rare or prompt-specific trigger.
- **Wrapped vs. bare inverts the intuition.** All 14 genuine emitted invocations (D) were wrapped in `<function_calls>`; 0 were bare. All 44 quoted-in-prose cases (E+F) were bare; 0 were wrapped. In this sample, _bare correlates with quoting and wrapped with genuine invocation_ — so requiring a `<function_calls>` wrapper would not have been the discriminator it appears to be.
- **No `antml:` prefix appeared** in any of the 210 runs.
- **Zero false positives.** Replaying `extractLeakedToolCalls()` over all 58 transcripts containing `<invoke` with `validToolNames = {read_file}`: 9 recovered (all genuine wrapped invocations, arguments parsed correctly), 49 passed through as text, including all 44 bare quoted cases. The fenced/quoted guard is what does the work here, not the wrapper requirement.

### Caveats

- Copilot's `vscode.lm` endpoint sits behind its own prompt assembly; results describe that surface, not the raw Anthropic API.
- The real-world shape of the leak that motivated the recovery code is **inferred** from third-party Anthropic-API reports (anthropics/claude-code#66153, #73808), not captured from `vscode-lm`. No `vscode-lm` transcript of the failure exists.

## Reproducing the False-Positive Replay

[`scripts/probe-vscode-lm-api/probe-false-positives.spec.ts`](../../../scripts/probe-vscode-lm-api/probe-false-positives.spec.ts) replays [`extractLeakedToolCalls()`](../../../src/api/providers/vscode-lm.ts) over a transcript directory and writes a `RECOVERED`/`passthrough` report. It has no committed inputs — run the probe first to produce them. Its `../vscode-lm` import and `TRANSCRIPTS` default are written for the copy destination, not for where it is committed. Drop it into `src/api/providers/__tests__/`, point `TRANSCRIPTS` (or `LM_PROBE_TRANSCRIPTS`) at the probe's `OUT_DIR`, then:

```
pnpm --dir src exec vitest run api/providers/__tests__/probe-false-positives.spec.ts
```

It is a scratch harness, not a committed test — remove it afterwards.
