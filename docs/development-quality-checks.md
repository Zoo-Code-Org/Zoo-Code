# Dead-code checks before review

Run these commands before requesting review:

```sh
pnpm knip
pnpm knip:production
pnpm test:knip-policy
```

The `knip` job in Code QA runs all three commands. Both analyzer runs must finish
without errors. The default run checks the graph that includes tests and development
dependencies. The production run checks runtime entry points without test callers
or development dependencies. A helper with passing unit tests can still be unused
by the product; the second run catches that case.

Unused files, dependencies, exports, exported types, enum members, namespace
exports, and duplicate exports are errors. Duplicate exports means exporting the
same declaration more than once; it does not mean similar implementations in
different modules. Class-member analysis remains off pending a separate audit.
Exports used inside their own file retain the existing exemption.

The policy tests run the installed Knip CLI against small temporary projects using
the extension workspace configuration. They verify successful analysis as well as
nonzero exit codes and specific findings for unused exports, unused types,
duplicate exports, unlisted dependencies, and production files referenced only by
tests. A workflow test verifies that CI runs both modes without allowing failure.

## Handling findings

First look for an existing implementation and real callers. Remove unused code or
integrate the existing helper rather than adding a second implementation. Deleting
an export can expose an unused local declaration to ESLint, so run lint and type
checks after cleanup.

For an intentional direct-test seam, put `@internal` and the reason next to the
export. Knip still follows test imports in default mode; production mode excludes
that export from its public-surface findings. This annotation does not make an
otherwise unused file reachable. Reserve `@public` for a deliberate public API.
Do not annotate a new scaffold just to make the checks pass.

Entry patterns describe real runtime entry points. Browser component fixtures are
development entries because Playwright loads them outside the normal application
graph. They are excluded from the production project so their imports cannot make
otherwise unused application helpers appear reachable. Shared `src/test-utils`
files are excluded only in production mode.

Two existing source files have explicit production-only exceptions:

| File                                             | Reason                                                                                                                                                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/utils/versionToken.ts`                      | A staged compare-and-swap helper from epic #1375 with direct tests; it has no runtime caller yet. Remove this exception when the write guard consumes it, or remove the helper if that work is abandoned.           |
| `src/core/tools/helpers/toolResultFormatting.ts` | Existing display helper with direct tests and no runtime callers. Retained as existing debt rather than expanding this PR's removal scope. Remove the exception when integrated or delete the helper and its tests. |

`resolveModelWithAbort` also currently has only contract-test callers. Its explicit
`@internal` annotation retains the existing shared cancellation helper for provider
adoption. This is existing debt, not evidence that providers already use it.

Review additions to exceptions and annotations as changes to the gate itself.
The repository's existing CODEOWNERS includes these files. Requiring that approval
and the `knip` status check is a GitHub ruleset setting; changing this workflow does
not configure branch protection or prevent an approved change to its own policy.

## What needs other checks

Knip cannot prove that a new helper should reuse an existing abstraction, that a PR
matches its issue, or that a test detects a behavioral regression. Use focused
contract tests and the existing changed-code mutation checks for those questions.
Keep new architectural ESLint rules and clone detection scoped to demonstrated
failure patterns and validate their false positives before making them required.
