# Debug Task Report — Dashboard Renders Completely Blank

## Task Summary

Investigate why the Dashboard tab on branch `feature/local-usage-stats` renders completely blank (no Summary, Breakdown, Heatmap, or Sessions). Phase B2 — root cause analysis only, no code changes.

## Symptom (as reported)

User made "significant improvements" to the Dashboard, then while fixing "Sessions not showing at the bottom," introduced an error. Now the Dashboard opens but shows nothing at all.

---

## Investigation Method (8-Stage Diagnostic)

### Stage 0 — Impact Analysis

Reviewed `git diff HEAD~3..HEAD` for the three suspect commits (`3c994f6a5`, `a7a4447e5`, `d039c6dfe`).

**Causal chain traced:**

```
App.tsx:251 (tab==="dashboard")
  → DashboardView.tsx (memo component)
    → useDashboardStatsStream.ts (subscription hook)
      → posts "subscribeDashboardStats"
        → webviewMessageHandler.ts → usageStatsMessageHandler.ts
          → handleSubscribeDashboardStats → getCoordinatorAndSink
            → UsageStatsService.ensureInitialized()  [NEW in 3c994f6a5]
            → UsageStatsStreamCoordinator.subscribe → sendSnapshot
              → assembleRollupSnapshot / computeSessionPage / computeHeatmapSnapshot
                [cacheRatio fast-path NEW in a7a4447e5/d039c6dfe]
        ← "dashboardStatsStreamSnapshot"
      → dashboardStreamReducer (SNAPSHOT/DELTA/ERROR)
    → render (4 conditional branches)
```

### Stage 1–2 — Observe & Diagnose

Read full render logic, reducer, hook, and AnimatedNumber.

### Stage 3–6 — Hypothesize, Test, Verify

- **Frontend tests**: `DashboardView.spec.tsx` → **28/28 PASS**.
- **Backend tests**: `usageStatsMessageHandler.spec.ts` + `dashboardStatsStreaming.integration.spec.ts` → **11 failed / 45 passed**. Failures are all `TypeError: service.ensureInitialized is not a function` — **stale test mocks**, not production bugs (the mock service objects were not updated to include the new `ensureInitialized()` method added in `3c994f6a5`).
- **Build artifacts**: verified current, valid, and in sync (see below).

---

## Root Cause Assessment

**Confidence: MEDIUM**
**Suspected Area: build/runtime environment, NOT committed source**

### What I RULED OUT (with evidence)

1. **Stale/corrupted webview bundle — RULED OUT.**
    - `src/webview-ui/build/assets/index.js` exists (5.98 MB), `node --check` passes (exit 0, no syntax errors).
    - Bundle timestamp `07:54:02` is NEWER than the last commit `d039c6dfe` (`07:37:45`).
    - Bundle contains the new code: `STATS_HANDLER/stream/timeout` and `Dashboard request timed out` strings confirmed present.
    - Backend `src/dist/extension.js` (`08:02:05`) contains `ensureInitialized`.
    - Both artifacts are consistent with HEAD.

2. **Frontend conditional-rendering gap — RULED OUT as the cause of TOTAL blank.**
    - Render branches (DashboardView.tsx:584–635): `isLoading` / `error && !hasData` / `backgroundError && hasData` / `error && hasData` / `!error && !hasData` (empty) / `!error && hasData` (data).
    - `totals` has a null-safe default (line 398 `?? {...}`), so `hasData = totals.events > 0` (line 426) never throws.
    - Even a stream ERROR with empty DB renders the **empty state** (line 625), NOT a blank. The stream `ERROR` action sets `backgroundError`, not the local `error` state — so a fatal stream error with no data shows the empty state. (NOTE: this is a minor UX gap worth fixing — see Recommendations — but it does NOT produce a blank.)

3. **Backend DB migration crash — RULED OUT.**
    - `uncached_input_tokens` column added via `ALTER TABLE ... DEFAULT 0` wrapped in bare `catch {}` (UsageStatsDatabase.ts:336–339). Safe for pre-existing DBs.
    - Read paths use `?? 0` fallback (`(row.uncached_input_tokens as number) ?? 0`, lines 2002/2051/2124).

4. **Backend snapshot malformation — RULED OUT.**
    - `UsageStatsStreamCoordinator.sendSnapshot` (line 441–526) wraps all assembly in try/catch and calls `sendError` on failure (line 519). A malformed snapshot cannot reach the frontend; an error message is sent instead → frontend renders empty state, not blank.

5. **AnimatedNumber crash — RULED OUT.** Component is clean; only the `duration` default changed (600→200) and formatting whitespace.

6. **Uncommitted working-tree changes — RULED OUT.** `git status --short` shows only untracked `docs/`; the dashboard/stats files are clean at HEAD.

### The residual hypothesis (requires runtime observation to confirm)

The committed code at HEAD is **internally consistent and test-passing**. A TOTAL blank (not even the title/header at DashboardView.tsx:451 renders) means the React tree **unmounted via an uncaught render-time exception** OR the **webview failed to load its entry script in the running host**.

Because I cannot reproduce this with mocked data (28/28 tests pass) and the bundle is valid, the most probable remaining causes are:

- **(A) Running host is serving a DIFFERENT (older) build than `src/webview-ui/build`.** If the user is running a packaged/installed `.vsix` or a different Extension Development Host whose webview root predates the rebuild, the served `index.html`/`index.js` may be stale or mismatched (the HTML references hashed chunks that no longer exist → entry 404 → blank). The two `git stash` entries (`stash@{0}`, `stash@{1}`) and a history of `vsix-build` branches suggest the user may be testing a **packaged build**, not the live source.
- **(B) A render-time exception in a downstream data component** (`DashboardSummary`, `SessionList`, heatmap) triggered only by the user's real production data shape (e.g., a session record with an unexpected field) — not covered by the mock fixtures. This branch only executes when `hasData` is true.

### Why this is consistent with the user's narrative

The user said the bug appeared "while fixing Sessions not showing." The Sessions area is rendered by `SessionList.tsx` inside the `hasData` branch. A crash there (e.g., a session with malformed/undefined field from the new rollup path) during render would unmount the entire `DashboardView` (there is **no React error boundary** around the dashboard), producing a TOTAL blank — matching the symptom exactly. This points to hypothesis (B) as the leading candidate, but it is data-dependent and needs a runtime stack trace to confirm.

---

## Verification Results

| Check                     | Command / Method                                                                                      | Result                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------ |
| Frontend unit tests       | `cd webview-ui; npx vitest run .../DashboardView.spec.tsx`                                            | 28/28 PASS                     |
| Backend handler tests     | `cd src; npx vitest run usageStatsMessageHandler.spec.ts dashboardStatsStreaming.integration.spec.ts` | 11 fail (stale mocks), 45 pass |
| Webview bundle syntax     | `node --check src/webview-ui/build/assets/index.js`                                                   | exit 0 (valid)                 |
| Bundle freshness          | `index.js` mtime 07:54 > HEAD commit 07:37                                                            | current                        |
| Bundle contains new code  | grep `STATS_HANDLER/stream/timeout` in `index.js`                                                     | present                        |
| Backend contains new code | grep `ensureInitialized` in `extension.js`                                                            | present                        |
| Working tree              | `git status --short`                                                                                  | clean (only `docs/` untracked) |

## Issues Discovered

1. **Stale test mocks (test-env debt, not the bug):** `usageStatsMessageHandler.spec.ts` and `dashboardStatsStreaming.integration.spec.ts` mock `UsageStatsService` without the `ensureInitialized()` method added in `3c994f6a5`. 11 tests now fail with `service.ensureInitialized is not a function`. **Test environment issue — should be fixed by adding `ensureInitialized: vi.fn().mockResolvedValue(undefined)` to the service mocks.**
2. **No React error boundary** around `DashboardView`. Any render-time throw in any dashboard child blanks the entire tab with no visible error. This is what turns a small data-dependent crash into a "totally blank" catastrophic symptom.
3. **Minor UX gap:** A fatal stream ERROR with empty DB renders the _empty_ state (because the ERROR action sets `backgroundError`, and the fatal branch checks the unrelated local `error` state). The user sees "no data" instead of the actual error message. Not the blank cause, but misleading.

## Next Step Recommendations (for VP)

**This needs SYSTEMIC/runtime observation to pin the exact throw.** Recommended actions, in order:

1. **Confirm the runtime target (highest value, cheapest):** Ask the user whether they are running (a) the Extension Development Host (F5), or (b) an installed/packaged `.vsix`. If (b), the served webview is likely stale → **rebuild and reinstall the vsix** (`pnpm --dir webview-ui build` then repackage). This alone may resolve it (hypothesis A).
2. **Capture the actual exception:** Instruct the user to open the Dashboard, then open Webview Developer Tools (`Help → Toggle Developer Tools → Console`) and paste the red error/stack trace. A single stack line will confirm hypothesis (B) and name the exact component/field. This is the decisive next datum.
3. **Add an error boundary (defensive, recommended regardless):** Wrap `DashboardView` (or its data branch) in a React error boundary so a child render throw shows a visible error + Refresh button instead of a blank tab. This converts future "blank" catastrophes into diagnosable errors.
4. **Fix the stale test mocks** (issue #1) so the dashboard integration suite is green again.

### ⭐ Recommended Escalation: SYSTEMIC

- Reason: Root cause is data/environment-dependent and not reproducible under mocked tests; committed code is internally consistent and artifacts are valid. A live stack trace from the webview console (or confirmation of the vsix-vs-devhost target) is required to localize the exact throw. Not enough evidence for a single surgical line fix yet.

## Affected File List (investigated; none modified)

- `webview-ui/src/components/dashboard/DashboardView.tsx`
- `webview-ui/src/components/dashboard/useDashboardStatsStream.ts`
- `webview-ui/src/components/dashboard/dashboardStreamReducer.ts`
- `webview-ui/src/components/dashboard/AnimatedNumber.tsx`
- `src/core/webview/usageStatsMessageHandler.ts`
- `src/core/webview/webviewMessageHandler.ts`
- `src/services/stats/UsageStatsService.ts`
- `src/services/stats/UsageStatsProjection.ts`
- `src/services/stats/UsageStatsDatabase.ts`
- `src/services/stats/UsageStatsStreamCoordinator.ts`
- `src/core/webview/__tests__/usageStatsMessageHandler.spec.ts` (stale mock — needs fix)
- `src/core/webview/__tests__/dashboardStatsStreaming.integration.spec.ts` (stale mock — needs fix)
