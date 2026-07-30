# Code Mode Task Report: ST-4 — DST-correct startOfDay

## Task Summary
Fixed the DST-related 1-hour offset bug in `startOfDay()` (UsageAggregator.ts) and `toTimezoneStartOfDay()` (UsageStatsService.ts) by evaluating the timezone offset at the candidate midnight instant rather than at the input date.

## Root Cause
Both `startOfDay()` and `toTimezoneStartOfDay()` computed the UTC offset using the **input date** (typically "now"). When the input date and the target midnight fall on opposite sides of a DST transition, the offset was wrong by 1 hour, causing incorrect time range boundaries for "today", "7d", and "30d" presets.

## Actions Taken

### 1. `src/services/stats/UsageAggregator.ts`
- Replaced the private `startOfDay()` function with an exported `startOfDayInTimezone()` function.
- The new function evaluates `getTimezoneOffsetMinutes()` at the **candidate midnight instant** (`new Date(midnightEpoch)`) instead of at the input `date`. This ensures DST transitions between "now" and midnight are handled correctly.
- A single iteration suffices because the candidate instant is within ~14 hours of the true midnight, always enough to determine the correct DST offset in all real-world timezones.
- Updated all 3 call sites in `resolveTimeRange()` (`today`, `7d`, `30d` presets) to use `startOfDayInTimezone()`.

### 2. `src/services/stats/UsageStatsService.ts`
- Added `startOfDayInTimezone` to the import from `./UsageAggregator`.
- Replaced `this.toTimezoneStartOfDay(now, timezone)` call in `resolvePresetRange()` with `startOfDayInTimezone(now, timezone)`.
- Removed the now-dead private methods `toTimezoneStartOfDay()` and `getTimezoneOffsetMinutes()` (52 lines removed).

### 3. `src/services/stats/__tests__/UsageAggregator.spec.ts`
- Added `startOfDayInTimezone` to the import list.
- Added a new `describe("startOfDayInTimezone - DST correctness")` block with 10 test cases:
  - Asia/Seoul (no DST, UTC+9 year-round)
  - America/New_York winter (EST, UTC-5)
  - America/New_York summer (EDT, UTC-4)
  - Spring-forward: querying before DST, midnight also before DST
  - Spring-forward: querying after DST, midnight before DST (the key bug scenario)
  - Fall-back: querying before DST, midnight before DST
  - Fall-back: querying after DST, midnight before DST (the key bug scenario)
  - UTC timezone
  - Europe/London winter (GMT, UTC+0)
  - Europe/London summer (BST, UTC+1)

## Result
✅ **All 146 tests pass** across both test files (UsageAggregator.spec.ts + UsageStatsService.spec.ts).

```
Test Files  2 passed (2)
     Tests  146 passed (146)
  Duration  3.14s
```

## Issues Discovered
- Initial test for "spring-forward: querying before DST" had an incorrect expected value. The midnight on March 8, 2026 in America/New_York is at 00:00 local time, which is **before** the 02:00 DST transition, so it's in EST (UTC-5), not EDT. Fixed the test expectation and comment.

## Affected File List
- `src/services/stats/UsageAggregator.ts` — replaced `startOfDay()` with exported `startOfDayInTimezone()`, updated 3 call sites
- `src/services/stats/UsageStatsService.ts` — removed 2 private methods, replaced with import
- `src/services/stats/__tests__/UsageAggregator.spec.ts` — added import + 10 DST boundary tests
