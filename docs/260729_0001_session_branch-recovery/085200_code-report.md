# Code Task Report: Sub-task 5 — Wire VS Code Message Boundary and Repair Source Routing

## Task Summary

Wired the VS Code message boundary for dashboard stats streaming by adding 7 new stream message handlers, restoring routing for ALL existing usage-stat handlers in `webviewMessageHandler.ts` (fixing the source routing gap from section 1.2F), verifying coordinator disposal, and writing comprehensive tests.

## Actions Taken

### 1. Added stream message handlers to `usageStatsMessageHandler.ts`

- Added imports for `ExtensionMessage`, `DashboardStatsSubscription` schema, `UsageStatsStreamCoordinator`, and `StatsStreamSink`
- Added `ProviderStreamSink` adapter class implementing `StatsStreamSink` to bridge coordinator → provider `postMessageToWebview` + visibility
- Added 5 new error codes: `STATS_HANDLER/stream/001` through `005`
- Added `getCoordinatorAndSink()` helper that lazily creates/reuses a sink per provider
- Implemented 7 new handler functions:
    - `handleSubscribeDashboardStats` — validates subscription payload, calls `coordinator.subscribe()`
    - `handleUnsubscribeDashboardStats` — calls `coordinator.unsubscribe()`
    - `handleReplaceDashboardStatsSubscription` — validates payload, calls `coordinator.replaceSubscription()`
    - `handlePauseDashboardStats` — calls `coordinator.pause()`
    - `handleResumeDashboardStats` — reads `message.value` as lastSequence, calls `coordinator.resume()`
    - `handleResyncDashboardStats` — validates payload, calls `coordinator.replaceSubscription()` for fresh snapshot
    - `handleGetDashboardSessionPage` — validates cursor/limit, uses `computeSessionPage()` from projection, posts `dashboardSessionPageResponse`

### 2. Restored routing in `webviewMessageHandler.ts`

- Added import block for all 13 usage-stat handler functions
- Added switch cases for ALL existing handlers: `getUsageStats`, `clearUsageStats`, `exportUsageStats`, `requestClearNonce`, `getDashboardSessions`, `getDashboardSessionDetail`
- Added switch cases for ALL 7 new stream handlers: `subscribeDashboardStats`, `unsubscribeDashboardStats`, `replaceDashboardStatsSubscription`, `pauseDashboardStats`, `resumeDashboardStats`, `resyncDashboardStats`, `getDashboardSessionPage`
- This fixes the source routing gap (section 1.2F) where handlers existed but were unreachable from source builds

### 3. Verified coordinator disposal in `ClineProvider.ts`

- Confirmed `ClineProvider.dispose()` calls `this.usageStatsService?.dispose()` (line 818)
- Confirmed `UsageStatsService.dispose()` calls `this.coordinator?.dispose()` (line 173)
- The disposal chain is: `ClineProvider.dispose()` → `UsageStatsService.dispose()` → `UsageStatsStreamCoordinator.dispose()`
- No changes needed — disposal was already correctly wired

### 4. Extended tests in `usageStatsMessageHandler.spec.ts`

- Added mock for `UsageStatsProjection` module
- Added `createMockCoordinator()` and `createMockDatabase()` factory functions
- Updated `createMockProvider` to support `view: { visible: true }` and async `postMessageToWebview`
- Added test blocks for all 7 new handlers covering:
    - Happy path (coordinator method called with correct args)
    - Service unavailable (error response with correct code)
    - Coordinator unavailable (error response with correct code)
    - Invalid payload validation (error response with correct code)
    - Edge cases (missing value, invalid limit, limit > 100)

### 5. Created `usageStatsMessageRouting.spec.ts` routing integration tests

- Tests send actual `WebviewMessage` values through `webviewMessageHandler()` to prove end-to-end routing
- 3 test groups:
    - **Existing usage-stat routing** (5 tests): proves `getUsageStats`, `clearUsageStats`, `requestClearNonce`, `getDashboardSessions`, `getDashboardSessionDetail` are routed
    - **Dashboard stream routing** (7 tests): proves all 7 new stream message types are routed
    - **Coordinator disposal** (1 test): proves the disposal chain `service.dispose()` → `coordinator.dispose()`
    - **Request validation and response correlation** (3 tests): proves requestId correlation and error code mapping

## Result

✅ Success — All 72 tests pass (56 existing + 16 new). No type errors in modified files.

### Verification Commands

```
cd src; npx vitest run core/webview/__tests__/usageStatsMessageHandler.spec.ts core/webview/__tests__/usageStatsMessageRouting.spec.ts
→ 2 test files passed, 72 tests passed

cd src; npx tsc --noEmit
→ No errors in core/webview/* files (pre-existing errors in api/providers/mimo.spec.ts are unrelated)
```

## Issues Discovered

- **Source routing gap confirmed (section 1.2F)**: `webviewMessageHandler.ts` had zero imports or routing cases for any usage-stat handlers. All existing handlers (`getUsageStats`, `clearUsageStats`, etc.) were unreachable from source builds. This has been fixed.
- `usageStatsChanged` is kept temporarily for compatibility as instructed — the new dashboard stream protocol does not use it.

## Affected File List

- `src/core/webview/usageStatsMessageHandler.ts` — Added imports, `ProviderStreamSink` adapter, 5 error codes, `getCoordinatorAndSink()` helper, 7 new handler functions
- `src/core/webview/webviewMessageHandler.ts` — Added import block for 13 handlers, added 13 switch cases
- `src/core/webview/__tests__/usageStatsMessageHandler.spec.ts` — Added mock for `UsageStatsProjection`, mock factories, 16 new tests
- `src/core/webview/__tests__/usageStatsMessageRouting.spec.ts` — New file, 16 routing integration tests
