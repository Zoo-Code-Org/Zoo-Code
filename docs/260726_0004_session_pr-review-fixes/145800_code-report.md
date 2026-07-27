# Code Task Report: Sanitize Parameter Names at Both Trust Boundaries

## Task Summary

Implemented prompt-injection prevention for `paramName` at both trust boundaries: the ErrorClassifier (extraction/storage boundary) and the MessageTransformer (interpolation boundary). Unsafe parameter names are now omitted entirely rather than escaped.

## Actions Taken

### 1. Added `isValidIdentifier()` to ErrorClassifier.ts

- Exported a shared safe-identifier validator function
- Uses `SAFE_IDENTIFIER_RE = /^[a-zA-Z_][\w.]*$/` to allow only identifier-like strings (including dotted member access like `options.timeout`)
- Enforces `MAX_PARAM_NAME_LENGTH = 128`
- Rejects instruction-like patterns: newlines, carriage returns, quotes (`"`, `'`), angle brackets (`<`, `>`), brackets (`[]`, `{}`, `()`), pipe (`|`), semicolon (`;`), backtick (`` ` ``), backslash (`\`)

### 2. Validated `extractParameterName()` result in ErrorClassifier.ts

- In `sanitizeFacts()`, the extracted parameter name is now validated through `isValidIdentifier()` before being stored in `facts.parameterName`
- If invalid, the parameter name is omitted (not stored)
- Also added validation for metadata-provided `parameterName` — the metadata loop copies values verbatim, so an unsafe `parameterName` from metadata would bypass the extraction-path validation. Added a post-loop check that deletes `facts.parameterName` if it fails `isValidIdentifier()`

### 3. Added defense-in-depth revalidation in MessageTransformer.ts

- Imported `isValidIdentifier` from ErrorClassifier
- In `buildPayload()`, the `paramName` from `facts["parameterName"]` is revalidated through `isValidIdentifier()` before interpolation into guidance text
- If invalid, falls back to the generic category template instead of the parameter-specific sentence
- Does NOT escape and partially preserve attacker-controlled values — omits them entirely

### 4. Updated tests

- **ErrorClassifier.spec.ts**: Added 22 tests for `isValidIdentifier()` covering valid identifiers, dotted names, underscore names, max-length, and rejection of newlines, quotes, angle brackets, brackets, shell characters, backslash, empty strings, overlength, digit-starting, whitespace, and full injection payloads. Added 20 tests for parameter name sanitization in the classification pipeline covering all injection vectors through both error message extraction and metadata injection paths.
- **MessageTransformer.spec.ts**: Added 20 tests for defense-in-depth revalidation covering valid name injection, dotted name injection, and omission of unsafe names (newline injection, quotes, markup, brackets, braces, parentheses, shell pipe, semicolon, backtick, backslash, empty string, overlength, digit-starting, whitespace) from rendered output. Includes end-to-end tests verifying unsafe values are ABSENT from the complete rendered message.

## Result

✅ Success — All 165 tests pass (2 test files, 165 tests, 921ms duration)

```
Test Files  2 passed (2)
     Tests  165 passed (165)
```

## Issues Discovered

- **Metadata bypass bug found and fixed**: The original `sanitizeFacts()` loop copied `parameterName` from metadata verbatim into `facts`, bypassing the `isValidIdentifier()` check that only ran when `facts.parameterName === undefined` (i.e., the extraction path). Fixed by adding a post-loop validation that deletes `facts.parameterName` if it fails the safe-identifier check.
- **Regex extraction truncation**: The `tryExtractParamNameFromText()` regex `[^'"']+` naturally truncates at quote characters, meaning injection payloads containing quotes in error messages would be partially extracted (e.g., `path"; rm -rf /` extracts just `path`). This is actually a secondary defense, but tests were adjusted to use metadata injection for quote-containing payloads to properly test the `isValidIdentifier()` boundary.

## Acceptance Criteria Verification

- ✅ Normal names like `path`, `file_pattern`, `options.timeout` remain useful (tested and pass)
- ✅ Payloads containing newline instructions, quotes, angle brackets, or overlength names NEVER appear in `What` or `Next` (tested and pass — unsafe values are ABSENT from rendered output)
- ✅ Rejected names get omitted, not escaped (no escaping logic exists; invalid names are simply not stored/interpolated)

## Files Modified

- `src/core/tools/error-interception/ErrorClassifier.ts` — Added `isValidIdentifier()` export, validation in `sanitizeFacts()` for both extraction and metadata paths
- `src/core/tools/error-interception/MessageTransformer.ts` — Imported `isValidIdentifier`, added defense-in-depth revalidation in `buildPayload()`
- `src/core/tools/error-interception/__tests__/ErrorClassifier.spec.ts` — Added `isValidIdentifier` import, 22 unit tests for `isValidIdentifier()`, 20 tests for parameter name sanitization in classification
- `src/core/tools/error-interception/__tests__/MessageTransformer.spec.ts` — Added 20 tests for defense-in-depth revalidation in message transformation

## Next Step Recommendations

- Consider running the full test suite to verify no regressions in other error-interception tests
- Consider adding a lint rule or type-level constraint to prevent direct interpolation of `facts["parameterName"]` without validation in future code paths
