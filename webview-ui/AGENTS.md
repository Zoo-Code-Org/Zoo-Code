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

### Coverage & Codecov Quality Gates

Codecov tracks `webview-ui` coverage under the `webview-ui` flag.

- **Ratcheting (`target: auto`)**: Overall webview coverage will never drop below the current baseline as new tests are added.
- **Patch Gate (`target: 70%`)**: New or modified lines in PRs touching `webview-ui/src/` must meet minimum test coverage, ensuring state changes and new UI logic stay tested over time.

---

## Visual Tests (Playwright CT)

- Add Playwright screenshot tests selectively for components where layout, styling, VS Code theme variables, or real web-component rendering are part of the behavior under test.
- Keep behavioral assertions in Vitest. A `*.visual.tsx` test should establish a deterministic state and make a focused screenshot assertion.
- Run visual comparisons with `pnpm test:visual:docker` from `webview-ui/`.
- Update intentional baselines with `pnpm test:visual:docker:update` and commit the resulting `__screenshots__` files with the UI change.
- Use the Docker commands when creating or reviewing baselines; host-rendered screenshots are not the source of truth.
- If Docker is unavailable, `pnpm test:visual` can help diagnose test code, but do not create or update committed baselines from the host rendering environment.
- Keep visual tests limited to components supported by the current Playwright harness. Add shared extension state, translation, React Query, or other provider support before snapshotting components that require it.
- The current baseline naming assumes a single Chromium project. Include `{projectName}` in `snapshotPathTemplate` before adding another browser project.
