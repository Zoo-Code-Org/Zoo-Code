# AGENTS.md

This file provides guidance to agents working in `webview-ui/`.

## Testing Strategy Overview

We use a complementary two-layer strategy for testing webview UI code:

1. **Vitest + JSDOM (`*.test.tsx`)**: Unit, hook, state-machine, and interaction tests.
2. **Playwright Story Gallery (`*.visual.tsx`)**: Visual snapshot, VS Code theme variable, layout, and shadow DOM tests.

---

### When to write a JSDOM Test (`*.test.tsx`) vs. a Playwright Visual Test (`*.visual.tsx`)

| Testing Goal                                                          | Recommended Harness                                                   |
| :-------------------------------------------------------------------- | :-------------------------------------------------------------------- |
| Component state transitions, reducer actions, custom hook behavior    | **Vitest + JSDOM** (`*.test.tsx`)                                     |
| User interactions (button clicks, form validation, text typing)       | **Vitest + JSDOM** (`*.test.tsx`) using `@testing-library/user-event` |
| Conditional DOM rendering or prop wiring                              | **Vitest + JSDOM** (`*.test.tsx`)                                     |
| Visual layout, flexbox/grid alignment, or padding/margin verification | **Playwright gallery** (`*.visual.tsx`)                               |
| VS Code dark/light theme CSS tokens (`--vscode-*`)                    | **Playwright gallery** (`*.visual.tsx`)                               |
| Web component shadow DOM style encapsulation & upgrades               | **Playwright gallery** (`*.visual.tsx`)                               |

---

## Unit & State Tests (Vitest + JSDOM)

- Prefer local `webview-ui` tests for React/webview behavior. If a change is about component rendering, local state, hooks, form dirty-state, validation, or prop wiring inside the webview, add or update Vitest coverage under `webview-ui/src/**/__tests__` instead of reaching for `apps/vscode-e2e`.
- Use `apps/vscode-e2e` only when the behavior depends on the real VS Code extension environment: extension-host to webview messaging, VS Code workspace APIs, task execution flows, or other end-to-end behavior that needs `@vscode/test-electron`.
- When a regression can be proven with a component or webview integration test, keep it in `webview-ui`. Do not promote it to e2e just because the UI is hosted inside VS Code.
- For `SettingsView`, preserve the cached-state pattern from the repo root guidance: inputs should operate on local `cachedState` until the user saves, and tests should distinguish automatic initialization from real user edits.
- Use `@/utils/test-utils` `renderWithExtensionState` and `makeExtensionState` for common context/query setup. Keep component-specific mocks and state transitions local when they explain the scenario.

### Coverage & Codecov Quality Gates

Codecov tracks `webview-ui` coverage under the `webview-ui` flag.

- **Ratcheting (`target: auto`)**: Overall webview coverage will never drop below the current baseline as new tests are added.
- **Patch Gate (`target: 70%`)**: New or modified lines in PRs touching `webview-ui/src/` must meet minimum test coverage, ensuring state changes and new UI logic stay tested over time.

---

## Visual Tests (Playwright Story Gallery)

### When a UI change needs a snapshot

If your PR changes anything a user would notice at a glance — layout, spacing, theme tokens, brand elements, gradients, mask/blur effects, hover/empty/error states — **add a `*.visual.tsx` snapshot to the same PR**. Do not attach screenshots to the PR description as evidence; commit the baseline instead so future PRs get regression coverage automatically.

Visual regression is screen-based, not line-based — the goal is a small set of durable "pixel receipts" for the surfaces users see first, not blanket coverage. Prefer covering:

- Onboarding / first-run surfaces (welcome view, hero, unconfigured state)
- Empty and error states (no history, provider misconfig, degraded modes)
- Theme-critical layouts that rely heavily on `--vscode-*` tokens or CSS masks/gradients
- One representative snapshot per user-facing screen — not per component

Skip a visual test when the change is behavior-only (state transitions, handler wiring, validation) — those belong in Vitest. Visual tests are for what JSDOM cannot verify.

### Where the two coverage flags fit

- `webview-ui` (Vitest + JSDOM) — broad line coverage over component logic, hooks, and state. This is your main coverage gate.
- `webview-ui-ct` (Playwright gallery) — narrow pixel-regression signal over a small set of critical screens. Low absolute % is expected and fine; the flag is not a coverage-to-hit target, it's a "did the surface still render the same" check.

### Authoring rules

- Keep behavioral assertions in Vitest. A `*.visual.tsx` test should establish a deterministic state and make a focused screenshot assertion.
- Register browser-owned stories in `playwright/gallery/stories.tsx` under a stable, descriptive ID and mount them with `mount(storyId, props)`. Props must be serializable; callbacks, React state, providers, and query clients stay inside the story so every mount starts fresh.
- Keep gallery-wide production CSS, theme fixtures, image setup, aliases, and mocks in `playwright/gallery/main.tsx` and `playwright/vite.config.ts` rather than duplicating setup in specs.
- Use `playwright/vscode-messages.ts` to inspect outbound `vscode.postMessage` payloads. The gallery resets captured messages before every mount; do not parse the browser console for host messages.
- Use `playwright/layout-contracts.ts` for bounded-layout checks. Critical real stories should cover WCAG text spacing at the 320px reflow width, horizontal overflow, clipped text and controls, action-row containment, and focused-control visibility without adding snapshots for that geometry matrix.
- Run visual comparisons with `pnpm test:visual:docker` from `webview-ui/`.
- Update intentional baselines with `pnpm test:visual:docker:update` and commit the resulting `__screenshots__` files with the UI change.
- Use the Docker commands when creating or reviewing baselines; host-rendered screenshots are not the source of truth.
- If Docker is unavailable, `pnpm test:visual` can help diagnose test code, but do not create or update committed baselines from the host rendering environment.
- If Docker cannot run at all, use the repository's pinned GitHub Actions container as the authoritative baseline generator:
    1. Push the visual test without new or updated host-generated baselines.
    2. Dispatch `.github/workflows/visual-regression.yml` against that branch. The expected missing-baseline failure uploads the `webview-visual-regression` artifact.
    3. Download the artifact and copy each relevant `test-results/**/<snapshot-name>-actual.png` to the test's `__screenshots__/<snapshot-name>.png` path.
    4. Commit those container-generated PNGs, push, and rerun the workflow until the visual job passes.
- Fork contributors can use this fallback in their own fork when GitHub Actions is enabled and the workflow exists on the fork's default branch, for example with `gh workflow run visual-regression.yml --repo <owner>/Zoo-Code --ref <branch>`. The public Playwright image and artifact upload do not require upstream secrets, though the Codecov upload may be unavailable. Fork contributors usually cannot manually dispatch the upstream repository's workflow; a maintainer can run it against an upstream branch when needed.
- The files under `playwright/themes/` are generated from the resolved webview variables exposed by the VS Code version pinned in `apps/vscode-e2e/package.json`; do not edit them manually. On Linux, update them with `xvfb-run -a pnpm --filter @roo-code/vscode-e2e themes:update` and verify them with `xvfb-run -a pnpm --filter @roo-code/vscode-e2e themes:check`. CI runs the same check and fails when the checked-in fixtures drift from the pinned VS Code runtime.
- Keep visual tests limited to components supported by the current Playwright harness. Add shared extension state, translation, React Query, or other provider support before snapshotting components that require it.
- The current baseline naming assumes a single Chromium project. Include `{projectName}` in `snapshotPathTemplate` before adding another browser project.
- Import `test` and `expect` from `webview-ui/playwright/coverage-fixture.ts` (not directly from `@playwright/test`) so the built-in gallery mount fixture retains V8 coverage collection for `monocart-reporter` — that's what produces `coverage-ct/lcov.info` for the Codecov upload.
