<!--
Thank you for contributing to Zoo Code!

Before submitting your PR, please ensure:
- It's linked to an approved GitHub Issue.
- You've reviewed our [Contributing Guidelines](../CONTRIBUTING.md).
-->

### Related GitHub Issue

<!-- Every PR MUST be linked to an approved issue. -->

Closes: # <!-- Replace with the issue number, e.g., Closes: #123 -->

### Description

<!--
Briefly summarize the changes in this PR and how they address the linked issue.
The issue should cover the "what" and "why"; this section should focus on:
- The "how": key implementation details, design choices, or trade-offs made.
- Anything specific reviewers should pay attention to in this PR.
-->

### Test Procedure

<!--
Detail the steps to test your changes. This helps reviewers verify your work.
- How did you test this specific implementation? (e.g., unit tests, manual testing steps)
- How can reviewers reproduce your tests or verify the fix/feature?
- Include relevant testing environment details if applicable.
-->

### Pre-Submission Checklist

<!-- Go through this checklist before marking your PR as ready for review. -->

- [ ] **Issue Linked**: This PR is linked to an approved GitHub Issue (see "Related GitHub Issue" above).
- [ ] **Scope**: My changes are focused on the linked issue (one major feature/fix per PR).
- [ ] **Self-Review**: I have performed a thorough self-review of my code.
- [ ] **Testing**: New and/or updated tests have been added to cover my changes (if applicable).
- [ ] **Visual Snapshot** (UI changes only): If a user would notice this change at a glance (layout, theme tokens, brand elements, empty/error states), I've added or updated a `*.visual.tsx` snapshot in `webview-ui/`. See `webview-ui/AGENTS.md` → "When a UI change needs a snapshot".
- [ ] **Documentation Impact**: I have considered if my changes require documentation updates (see "Documentation Updates" section below).
- [ ] **Contribution Guidelines**: I have read and agree to the [Contributor Guidelines](/CONTRIBUTING.md).

### Visual Snapshots

<!--
For UI changes to static rendered state, the primary artifact is a committed
Playwright Story Gallery snapshot (`*.visual.tsx` in `webview-ui/`) — that baseline
becomes durable regression coverage for the surface. See
`webview-ui/AGENTS.md` for what deserves a snapshot.

Before/after screenshots pasted here are welcome as a review aid but are not a
substitute for the committed baseline. If a snapshot is possible, prefer the
snapshot.
-->

### Videos (interaction / animation only)

<!--
Snapshots cannot capture motion or multi-step flows. Attach a short screen
recording here when reviewers need to see:
  - A new interactive flow (dropdown, form, dialog progression)
  - Animation, transition, or timing behavior
  - A regression that only manifests during interaction

Videos are a review aid, not regression coverage. If the *result* of the
interaction has a distinct rendered state worth protecting, still commit a
`*.visual.tsx` snapshot of that end-state alongside the video.
-->

### Documentation Updates

<!--
Does this PR necessitate updates to user-facing documentation?
- [ ] No documentation updates are required.
- [ ] Yes, documentation updates are required. (Please describe what needs to be updated or link to a PR in the docs repository).
-->

### Additional Notes

<!-- Add any other context, questions, or information for reviewers here. -->

### Get in Touch

<!--
Please provide your Discord username for reviewers or maintainers to reach you if they have questions about your PR
-->
