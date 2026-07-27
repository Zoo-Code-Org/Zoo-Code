# Environment Feedback Report

## Mode: architect

## Date: 260726

## Issue: Invalid Crow Memory register parameter

### Problem Description

- What happened: A Crow Memory recall request used `register: "code"`, but the tool accepts concrete register names or `all`; `code` is valid only for the separate `domain` parameter.
- When it occurred: During causal-chain research for the error interception architecture plan.
- Error message: `Input validation error: 'code' is not one of ['style', 'bug', 'arch', 'context', 'life_pref', 'life_avoid', 'life_phil', 'life_context', 'all']`

### Root Cause Analysis

- Why it happened: The request conflated the tool's `domain` shortcut values with its `register` enum.

### Workaround/Solution

- How I solved it: Continue with a valid concrete register such as `arch`, or omit `register` while using `domain: "code"`.
- What I tried: One recall request with the invalid parameter combination. It was not retried unchanged.

### Ideal Environment

- What would be ideal: Tool-side validation could explicitly state, "Use domain=code; register does not accept code," to make the distinction immediately actionable.

### Additional Notes

- No repository source files were changed. This feedback report is kept inside the immutable session Report Folder.
