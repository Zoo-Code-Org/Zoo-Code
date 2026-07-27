# Requirement Checklist

## Task: PR Review Fixes + Error Interception Guidance Effectiveness

## Date: 260726

## Branch: feat/error-interception-middleware

### Context

PR reviewer (edelauna) identified 7 issues in the error interception middleware PR.
Additionally, the user observed that the error interception middleware fails to effectively guide AI models to recover from errors — models repeatedly hit the same errors (e.g., INVALID_JSON_ARGUMENTS occurrence=10+) requiring the user to click "Proceed anyway" manually.

### PR Review Items (edelauna)

- [ ] [REQ-001] Remove local dev scripts from PR (ci-fix-commit.ps1, commit-and-push.ps1, commit-message.txt, resolve_conflicts.py) and add to .gitignore
- [ ] [REQ-002] Synchronize TaskErrorState fingerprint reset with ToolErrorInterceptor.resetTaskState — when fingerprint changes, also reset the interceptor's per-category counter to prevent occurrence drift
- [ ] [REQ-003] Sanitize paramName in MessageTransformer — validate regex-extracted paramName matches identifier pattern (e.g., /^[a-zA-Z\_][\w.]\*$/) before interpolating into guidance sentences (prompt injection prevention)
- [ ] [REQ-004] Fix unknown tool classification — don't send typeMismatch:true for unknown tools; add errorPatterns entries for unknownTool/modeRestriction/fileRestriction metadata to close fail-open paths
- [ ] [REQ-005] Do not add new entries to eslint-suppressions.json — fix lint violations in code instead
- [ ] [REQ-006] Remove AI session notes from PR (docs/260726_0003_session_error-hiding-fix/074338_code-light-report.md) and add docs/ to .gitignore or similar
- [ ] [REQ-007] Add integration test spec with real NativeToolCallParser.consumeParseError + real Task.pushToolResultToUserContent dedup (pin parser→dispatch seam)

### Error Interception Guidance Effectiveness (User-reported)

- [ ] [REQ-008] Improve error guidance recovery effectiveness — when models hit repeated errors (e.g., parallel tool call bleeding), the middleware's guidance messages must be specific enough to break the loop. The current generic "ONE AT A TIME" guidance is insufficient; guidance should include the model's actual mistake pattern and a concrete corrective action. Goal: reduce "Proceed anyway" user interventions.
