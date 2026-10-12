<!--
Thank you for contributing to Zoo Code!

Before you submit your PR, make sure of these points:
- It links to an approved GitHub Issue.
- You read our [Contributing Guidelines](../CONTRIBUTING.md).
- Write in Simplified Technical English (ASD-STE100): short sentences, plain words, active voice, one idea per sentence, no contractions. Keep the title short and specific.
-->

### Related GitHub Issue

<!-- Every PR MUST be linked to an approved issue. -->

Closes: # <!-- Replace with the issue number, for example, Closes: #123 -->

### Description

<!--
Summarize the changes in this PR and how they solve the linked issue.
The issue covers the "what" and the "why". This section covers:
- The "how": key implementation details, design choices, and trade-offs.
- Anything reviewers must check with care.
-->

### Test Procedure

<!--
Write the steps that test your changes. This helps reviewers check your work.
- How did you test this change? (for example, unit tests or manual steps)
- How can reviewers repeat your tests or check the fix or feature?
- Add the test environment details if they matter.
-->

### Pre-Submission Checklist

<!-- Complete this checklist before you mark your PR as ready for review. -->

- [ ] **Issue Linked**: This PR is linked to an approved GitHub Issue (see "Related GitHub Issue" above).
- [ ] **Scope**: My changes are focused on the linked issue (one major feature/fix per PR).
- [ ] **Self-Review**: I reviewed my own code with care.
- [ ] **Writing Style**: The PR title and description use Simplified Technical English (ASD-STE100): short sentences, plain words, active voice, one idea per sentence, no contractions.
- [ ] **Testing**: New and/or updated tests have been added to cover my changes (if applicable).
- [ ] **Visual Snapshot** (UI changes only): If a user would notice this change at a glance (layout, theme tokens, brand elements, empty/error states), I added or updated a `*.visual.tsx` snapshot in `webview-ui/`. See `webview-ui/AGENTS.md` → "When a UI change needs a snapshot".
- [ ] **Documentation Impact**: I checked if my changes need documentation updates (see "Documentation Updates" section below).
- [ ] **Contribution Guidelines**: I read and agree to the [Contributor Guidelines](/CONTRIBUTING.md).

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
Does this PR need updates to user-facing documentation?
- [ ] No documentation updates are required.
- [ ] Yes, documentation updates are required. (Describe what to update, or link to a PR in the docs repository).
-->

### Additional Notes

<!-- Add any other facts or questions for reviewers here. -->

### Get in Touch

<!--
Write your Discord username. Reviewers and maintainers use it to contact you if they have questions about your PR
-->
