# AGENTS.md

This file provides guidance to agents working in `webview-ui/`.

## Testing Strategy Overview

We use a complementary two-layer strategy for testing webview UI code:

1. **Vitest + JSDOM (`*.test.tsx`)**: Unit, hook, state-machine, and interaction tests.
2. **Playwright Component Testing (`*.visual.tsx`)**: Visual snapshot, VS Code theme variable, layout, and shadow DOM tests.

---

### When to write a JSDOM Test (`*.test.tsx`) vs. a Playwright Visual Test (`*.visual.tsx`)

| Testing Goal                                                          | Recommended Harness                                                   |
| :-------------------------------------------------------------------- | :-------------------------------------------------------------------- |
| Component state transitions, reducer actions, custom hook behavior    | **Vitest + JSDOM** (`*.test.tsx`)                                     |
| User interactions (button clicks, form validation, text typing)       | **Vitest + JSDOM** (`*.test.tsx`) using `@testing-library/user-event` |
| Conditional DOM rendering or prop wiring                              | **Vitest + JSDOM** (`*.test.tsx`)                                     |
| Visual layout, flexbox/grid alignment, or padding/margin verification | **Playwright CT** (`*.visual.tsx`)                                    |
| VS Code dark/light theme CSS tokens (`--vscode-*`)                    | **Playwright CT** (`*.visual.tsx`)                                    |
| Web component shadow DOM style encapsulation & upgrades               | **Playwright CT** (`*.visual.tsx`)                                    |

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

## Visual Tests (Playwright CT)

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
- `webview-ui-ct` (Playwright CT) — narrow pixel-regression signal over a small set of critical screens. Low absolute % is expected and fine; the flag is not a coverage-to-hit target, it's a "did the surface still render the same" check.

### Authoring rules

- Keep behavioral assertions in Vitest. A `*.visual.tsx` test should establish a deterministic state and make a focused screenshot assertion.
- Run visual comparisons with `pnpm test:visual:docker` from `webview-ui/`.
- Update intentional baselines with `pnpm test:visual:docker:update` and commit the resulting `__screenshots__` files with the UI change.
- Use the Docker commands when creating or reviewing baselines; host-rendered screenshots are not the source of truth.
- If Docker is unavailable, `pnpm test:visual` can help diagnose test code, but do not create or update committed baselines from the host rendering environment.
- Keep visual tests limited to components supported by the current Playwright harness. Add shared extension state, translation, React Query, or other provider support before snapshotting components that require it.
- The current baseline naming assumes a single Chromium project. Include `{projectName}` in `snapshotPathTemplate` before adding another browser project.
- Import `test` and `expect` from `webview-ui/playwright/coverage-fixture.ts` (not directly from `@playwright/experimental-ct-react`) so the auto-fixture collects V8 coverage for `monocart-reporter` — that's what produces `coverage-ct/lcov.info` for the Codecov upload.
