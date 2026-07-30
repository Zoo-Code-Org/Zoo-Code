# Environment Feedback Report

## Mode: architect

## Date: 260730

## Issue: PowerShell inline conditional parsed as a command

### Problem Description

- What happened: A read-only Git diff aggregation command attempted to use `if (...) { ... } else { ... }` directly inside parentheses while calculating per-file line totals.
- When it occurred: During branch split analysis for `docs/260729_0001_session_branch-recovery/pr-split-strategy.md`.
- Error message: `if : The term 'if' is not recognized as the name of a cmdlet, function, script file, or operable program.`

### Root Cause Analysis

- Why it happened: Windows PowerShell 5.1 does not treat the statement-form `if` expression as a value when written in the attempted parenthesized assignment form. The shell tried to resolve `if` as a command. The command also lacked `ErrorActionPreference = 'Stop'`, so repeated non-terminating errors still produced exit code 0 and an invalid `FILES_GT_500=0` result.

### Workaround/Solution

- How I solved it: Discard the invalid aggregation result. Future calculations assign additions and deletions in separate statement blocks before summing them, and set `ErrorActionPreference = 'Stop'` so parsing/runtime failures return a failing command result.
- What I tried: One read-only PowerShell aggregation command. No repository source files or Git history were changed.

### Ideal Environment

- What would be ideal: The command runner should convert PowerShell non-terminating errors into a non-zero tool result, or default to `ErrorActionPreference = 'Stop'` for inline commands.

### Additional Notes

- The persisted command output was large because the same parsing error repeated once per diff row. Its reported file count must not be used.
