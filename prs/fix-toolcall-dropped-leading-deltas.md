### Related GitHub Issue

Closes: #695

### Description

When a provider streams a tool call whose first delta(s) arrive _before_ the tool-call `id` is known, those leading argument bytes are silently discarded by `NativeToolCallParser.processRawChunk`. This causes downstream "missing required parameter" errors even when the model supplied the data.

This PR fixes the issue by centralizing the tracking of streaming tool calls in `NativeToolCallParser`. The `rawChunkTracker` is now initialized on the first sight of a stream `index`, independent of whether an `id` is present. All `arguments` deltas are buffered until both `id` and `name` are known, ensuring no data loss during streaming reassembly.

### Test Procedure

1. Ran the newly added unit test in `src/core/assistant-message/__tests__/NativeToolCallParser.spec.ts` which verifies that leading argument bytes arriving before the `id` are correctly preserved and finalized.
2. Verified that existing provider tests in the same test file pass.

### Pre-Submission Checklist

- [x] **Issue Linked**: This PR is linked to an approved GitHub Issue.
- [x] **Scope**: My changes are focused on the linked issue (one major feature/fix per PR).
- [x] **Self-Review**: I have performed a thorough self-review of my code.
- [x] **Testing**: New and/or updated tests have been added to cover my changes.
- [x] **Documentation Impact**: I have considered if my changes require documentation updates.
- [x] **Contribution Guidelines**: I have read and agree to the [Contributor Guidelines](/CONTRIBUTING.md).

### Screenshots / Videos

N/A

### Documentation Updates

- [x] No documentation updates are required.

### Additional Notes

N/A

### Get in Touch

@awschmeder
