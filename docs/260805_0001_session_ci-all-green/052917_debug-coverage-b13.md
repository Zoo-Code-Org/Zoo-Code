# Coverage Analysis Report: PR #1123 (b13-usage-store-v2)

## Branch: pr/b13-usage-store-v2

## Date: 2026-08-05 14:29 (KST)

### Coverage Summary

| File                                      | Total New Lines | Covered  | Uncovered | Coverage % |
| ----------------------------------------- | --------------- | -------- | --------- | ---------- |
| `packages/types/src/usage-stats.ts`       | 114             | 114      | 0         | 100.0%     |
| `src/services/stats/UsageAggregator.ts`   | 579             | 556      | 23        | 96.0%      |
| `src/services/stats/UsageEventStore.ts`   | 722             | 639      | 83        | 88.5%      |
| `src/services/stats/UsageRecorder.ts`     | 138             | 137      | 1         | 99.3%      |
| `src/services/stats/UsageStatsService.ts` | 524             | 274      | 250       | 52.3%      |
| `src/core/task/Task.ts` (partial)         | 95              | 19       | 76        | 20.0%      |
| **Overall (new source files only)**       | **2172**        | **1739** | **433**   | **80.1%**  |

> Note: `packages/types/src/usage-stats.ts` is 100% covered (tested via `packages/types/src/__tests__/usage-stats.spec.ts`).
> `UsageStatsService.ts` has **no test file** in this PR, which is the primary cause of the codecov/patch failure.
> `Task.ts` coverage is low because the usage-stats integration code (lines 3177-3214, 3322-3358) runs inside the live streaming loop which the existing `Task.usage-stats.spec.ts` tests via mocks but does not exercise the actual streaming path.

### Uncovered Lines Detail

#### 1. `src/services/stats/UsageStatsService.ts` (52.3% patch coverage - CRITICAL)

**No test file exists for this module.** All 524 lines are new. 250 lines uncovered.

- **Uncovered line ranges**: 27, 29, 31-32, 94-95, 98-99, 109, 123-124, 138, 141, 143-160, 170-171, 173-174, 186-191, 193-199, 202, 205, 216, 218-241, 243, 250, 264-272, 274-279, 282-285, 287, 298, 300-323, 330-340, 343-344, 347, 354-372, 374-375, 389, 392, 394-397, 399, 406, 408-411, 413, 420-481, 491-493, 496-499, 502-504, 506, 516-522

- **What these lines do**:
    - Lines 27-32: `StatsServiceError` constructor (error class definition)
    - Lines 94-95: `clearNonce` / `clearNonceExpiresAt` private fields
    - Lines 98-99: `UsageStatsService` constructor (instantiates `UsageEventStore` + `UsageAggregator`)
    - Lines 109, 123-124: `initialize()` and `queryStats()` methods
    - Lines 138-160: `exportStats()` method (JSON + CSV export, format validation)
    - Lines 170-174: `issueClearNonce()` method (nonce generation + expiry)
    - Lines 186-199, 202, 205: `clearStats()` method (nonce validation, expiry check, store clear)
    - Lines 216, 218-241, 243: `backfillFromHistory()` method (event restoration from history)
    - Lines 250: `isCapped()` method
    - Lines 264-285: `filterEventsByQuery()` private method (time range + cancelled filtering)
    - Lines 298, 300-323: `resolvePresetRange()` private method (today/7d/30d/all presets)
    - Lines 330-340, 343-344, 347: `toTimezoneStartOfDay()` private method
    - Lines 354-372, 374-375: `getTimezoneOffsetMinutes()` private method
    - Lines 389, 392, 394-397, 399: `eventsToCsv()` private method
    - Lines 406, 408-411, 413: `eventToCsvRow()` private method
    - Lines 420-481: `extractCsvValue()` private method (all CSV column extractors)
    - Lines 491-493, 496-499, 502-504, 506: `escapeCsvCell()` private method (formula injection prevention)
    - Lines 516-522: `generateNonce()` private method (crypto.randomUUID + fallback)

#### 2. `src/core/task/Task.ts` (20.0% patch coverage - partial)

Only 95 new lines added in this PR. 76 uncovered.

- **Uncovered line ranges**: 540, 3177-3214, 3322-3358

- **What these lines do**:
    - Line 540: `catch` block in UsageRecorder initialization (`console.warn` on failure)
    - Lines 3177-3214: **Terminal finalize for completed/cancelled attempts** - constructs `UsageRecordingContext` and calls `this.usageRecorder.finalizeUsageEvent()` inside the `captureUsageData` success path. This is the main recording path for successful API calls.
    - Lines 3322-3358: **Terminal finalize for failed/cancelled streaming** - constructs `UsageRecordingContext` and calls `this.usageRecorder.finalizeUsageEvent()` inside the streaming error catch block. This records partial usage when a stream fails or user cancels.

- **Why uncovered**: The existing `Task.usage-stats.spec.ts` tests mock the streaming loop and test `UsageRecorder` in isolation. The actual `captureUsageData` callback and streaming error paths are not exercised because they require a full API streaming simulation.

#### 3. `src/services/stats/UsageEventStore.ts` (88.5% patch coverage)

722 new lines, 83 uncovered.

- **Uncovered line ranges**: 52, 54, 56-57, 164-168, 179, 210, 235-239, 250-253, 270, 280, 282-284, 317-321, 355, 367-371, 376, 406-409, 422-426, 440, 447-449, 466-470, 484, 507-509, 518-519, 535-544, 558, 572-573, 596-600, 642, 686, 705, 713

- **What these lines do**:
    - Lines 52-57: `StatsStoreError` constructor
    - Lines 164-168: `initialize()` error path (mkdir failure)
    - Line 179: `rebuildIdempotencySet` failure warning
    - Line 210: `append()` promise queue reject handler
    - Lines 235-239: `readAll()` directory read error (StatsStoreError)
    - Lines 250-253: `readAll()` segment file read error (ENOENT skip)
    - Line 270: empty line skip in readAll
    - Lines 280, 282-284: zod validation failure quarantine (last line special case)
    - Lines 317-321: `clear()` manifest lock acquisition failure
    - Line 355: `clear()` segment file move failure warning
    - Lines 367-371, 376: `clear()` manifest replacement failure + lock release
    - Lines 406-409: `appendInternal()` hard cap check throw
    - Lines 422-426: `appendInternal()` manifest lock acquisition failure
    - Line 440: `appendInternal()` stat error re-throw (non-ENOENT)
    - Lines 447-449: segment rotation (currentSegment increment)
    - Lines 466-470: `appendInternal()` file write error
    - Line 484: `appendInternal()` lock release warning
    - Lines 507-509, 518-519: `loadOrCreateManifest()` validation failure + default overwrite
    - Lines 535-544: `writeManifestAtomic()` temp file cleanup on error
    - Line 558: `acquireManifestLock()` manifest creation on missing
    - Lines 572-573: `acquireManifestLock()` onCompromised handler
    - Lines 596-600: `rebuildIdempotencySet()` segment scan error
    - Line 642: `checkTotalSize()` catch fallback
    - Line 686: `writeQuarantineReport()` failure warning
    - Line 705: `ensureInitialized()` lazy init
    - Line 713: `_getIdempotencyKeyCount()` test helper

#### 4. `src/services/stats/UsageAggregator.ts` (96.0% patch coverage)

579 new lines, 23 uncovered.

- **Uncovered line ranges**: 163-167, 386, 388, 396, 406, 409, 412, 417, 486-490, 494-498, 535

- **What these lines do**:
    - Lines 163-167: `30d` preset time range calculation (only `today`, `7d`, `all` are tested)
    - Lines 386, 388: `getAxisValues()` for `week` and `month` axes (not tested)
    - Line 396: `getAxisValues()` for `status` axis (not tested)
    - Lines 406, 409: `getAxisValues()` for `source` axis - `inputTokens` and `outputTokens` source extraction
    - Lines 412, 417: `getAxisValues()` source "unknown" fallback + default case
    - Lines 486-490: `accumulateIntoBucket()` `cacheWriteInInput` "included" and "unknown" branches
    - Lines 494-498: `accumulateIntoBucket()` `reasoningInOutput` "included" and "unknown" branches
    - Line 535: `sortBuckets()` tiebreaker (name ascending when totalTokens equal)

#### 5. `src/services/stats/UsageRecorder.ts` (99.3% patch coverage)

138 new lines, 1 uncovered.

- **Uncovered line**: 136

- **What line 136 does**: `_hasFinalized()` test helper method - returns whether a requestKey:status pair has been finalized. This is a test-only utility that is not called by any existing test.

### Recommended Tests to Write

#### Priority 1: `UsageStatsService.spec.ts` (CRITICAL - no test file exists)

This is the single biggest gap. A new test file `src/services/stats/__tests__/UsageStatsService.spec.ts` should be created with:

1. **Constructor + initialize**: Verify `UsageStatsService` constructs and `initialize()` creates the store
2. **queryStats**: Query with various presets (today, 7d, 30d, all) and explicit from/to, verify snapshot
3. **exportStats - JSON**: Export events as JSON, verify schema version, timestamp, query echo, events array
4. **exportStats - CSV**: Export events as CSV, verify header row, column order, cell escaping
5. **exportStats - invalid format**: Verify `StatsServiceError` with code `STATS_SERVICE/export/001`
6. **CSV cell escaping**: Test formula injection prevention (`=`, `+`, `-`, `@` prefix), comma/quote/newline escaping
7. **CSV column extraction**: Test all 30+ columns including missing values (null `parentTaskId`, missing `inputTokens`, etc.)
8. **issueClearNonce**: Verify nonce is generated, has 5-minute expiry
9. **clearStats - valid nonce**: Verify store is cleared after valid nonce
10. **clearStats - invalid nonce**: Verify `StatsServiceError` with code `STATS_SERVICE/clear/001` on mismatch
11. **clearStats - expired nonce**: Verify error after expiry
12. **clearStats - single use**: Verify nonce is consumed (second call with same nonce fails)
13. **backfillFromHistory**: Verify events are appended with `provenance: "history-backfill"`, count returned
14. **backfillFromHistory - error isolation**: Verify `StatsStoreError` is caught (warn), non-store errors are re-thrown
15. **isCapped**: Verify delegates to store
16. **filterEventsByQuery**: Test time range filtering + cancelled exclusion (private, test via exportStats)
17. **resolvePresetRange**: Test all 4 presets (today, 7d, 30d, all) with timezone
18. **toTimezoneStartOfDay**: Test with various timezones (UTC, Asia/Seoul, America/New_York)
19. **getTimezoneOffsetMinutes**: Test offset calculation for different timezones
20. **generateNonce**: Verify UUID format, fallback path

#### Priority 2: `UsageAggregator.spec.ts` additions (minor gaps)

Add tests for:

1. **30d preset**: Query with `preset: "30d"` (currently only today/7d/all tested)
2. **week/month grouping**: Group by `["week"]` and `["month"]` axes
3. **status grouping**: Group by `["status"]` axis
4. **source axis with inputTokens/outputTokens**: Events with different token sources
5. **source axis "unknown" fallback**: Event with no costUsd and no input/output tokens
6. **cacheWriteInInput "included" and "unknown"**: Events with these semantics values
7. **reasoningInOutput "included" and "unknown"**: Events with these semantics values
8. **sort tiebreaker**: Two buckets with same totalTokens, verify name ascending order

#### Priority 3: `UsageEventStore.spec.ts` additions (error paths)

Add tests for:

1. **initialize mkdir failure**: Mock `fs.mkdir` to throw, verify `StatsStoreError` with code `STATS_STORE/append/001`
2. **readAll directory read failure**: Mock `fs.readdir` to throw, verify `StatsStoreError` with code `STATS_STORE/readAll/001`
3. **readAll segment file non-ENOENT error**: Mock `fs.readFile` to throw non-ENOENT error
4. **clear lock acquisition failure**: Mock `acquireManifestLock` to throw, verify `StatsStoreError` with code `STATS_STORE/clear/001`
5. **clear manifest replacement failure**: Mock `writeManifestAtomic` to throw, verify `StatsStoreError` with code `STATS_STORE/clear/002`
6. **appendInternal hard cap**: Set `capped = true`, verify `StatsStoreError` with code `STATS_STORE/append/003`
7. **appendInternal manifest lock failure**: Mock `acquireManifestLock` to throw during append
8. **appendInternal file write error**: Mock `fs.open` to throw, verify `StatsStoreError` with code `STATS_STORE/append/004`
9. **segment rotation**: Write events exceeding `SEGMENT_MAX_BYTES`, verify `currentSegment` increments
10. **loadOrCreateManifest validation failure**: Corrupt manifest with wrong types, verify default overwrite
11. **writeManifestAtomic temp cleanup**: Mock `fs.rename` to throw, verify temp file is cleaned up
12. **rebuildIdempotencySet scan error**: Mock `fs.readFile` to throw non-ENOENT during scan

#### Priority 4: `UsageRecorder.spec.ts` addition (1 line)

Add test for:

1. **`_hasFinalized()` helper**: Call `finalizeUsageEvent` then verify `_hasFinalized` returns true

#### Priority 5: `Task.ts` usage-stats integration (hard - requires streaming mock)

The uncovered lines (3177-3214, 3322-3358) are inside the live API streaming loop. To cover them:

1. **Success path**: Mock the API to return a streaming response with usage data, verify `finalizeUsageEvent` is called with correct context
2. **Failure path**: Mock the API to throw during streaming, verify `finalizeUsageEvent` is called with "failed" status
3. **Cancellation path**: Trigger `this.abort = true` during streaming, verify `finalizeUsageEvent` is called with "cancelled" status

These tests are complex because they require mocking the full API streaming pipeline. Consider whether the existing `Task.usage-stats.spec.ts` tests (which test `UsageRecorder` in isolation) provide sufficient confidence, or if integration tests are needed.

### Commands Run

1. `git fetch myk1yt && git checkout pr/b13-usage-store-v2` - Branch checkout
2. `git diff upstream/main...HEAD --stat` - PR diff stat (14 files, 3857 insertions)
3. `cd src && npx vitest run --coverage --reporter=verbose services/stats/__tests__/UsageAggregator.spec.ts services/stats/__tests__/UsageEventStore.spec.ts core/task/__tests__/Task.usage-stats.spec.ts` - Test run with coverage (60 tests passed, 3 files)
4. `cd src && npx vitest run --coverage --coverage.reporter=json --coverage.reportsDirectory=./coverage-json ...` - JSON coverage output
5. `cd packages/types && npx vitest run --coverage --coverage.reporter=json --coverage.reportsDirectory=./coverage-json` - Types package coverage (305 tests passed, 21 files)
6. `git diff upstream/main...HEAD -- <file>` - Per-file diff to identify added line numbers
7. Python script to cross-reference coverage JSON with git diff added lines

### Root Cause Assessment

The `codecov/patch` check fails because:

1. **`UsageStatsService.ts` (524 new lines, 0% tested)**: This file has NO test file. It contains the entire public API surface (`queryStats`, `exportStats`, `clearStats`, `backfillFromHistory`, CSV export, nonce management, timezone handling). This is the #1 gap.

2. **`Task.ts` integration code (76 uncovered new lines)**: The usage recording hooks inside the streaming loop (lines 3177-3214 for success, 3322-3358 for failure) are not exercised by existing tests. The `Task.usage-stats.spec.ts` tests mock at the `UsageRecorder` level, not at the streaming level.

3. **`UsageEventStore.ts` (83 uncovered lines)**: Mostly error paths (mkdir failure, lock failure, write failure, manifest corruption). The happy paths are well tested but edge cases are missing.

4. **`UsageAggregator.ts` (23 uncovered lines)**: Minor gaps - `30d` preset, `week`/`month`/`status` axes, some semantics branches, sort tiebreaker.

**Estimated effort to reach 80% patch coverage**:

- Writing `UsageStatsService.spec.ts` would bring `UsageStatsService.ts` from 52.3% to ~90%+, adding ~200 covered lines
- Adding `UsageEventStore.ts` error path tests would bring it from 88.5% to ~95%+, adding ~40 covered lines
- Adding `UsageAggregator.ts` edge case tests would bring it from 96.0% to ~99%, adding ~15 covered lines
- `Task.ts` integration tests are harder but even partial coverage (e.g., testing the success path) would add ~35 lines
- Total: ~290 additional covered lines, bringing overall from 80.1% to ~93%+
