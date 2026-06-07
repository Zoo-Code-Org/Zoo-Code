# AGENTS.md

This file provides guidance to agents working in `webview-ui/`.

- Prefer local `webview-ui` tests for React/webview behavior. If a change is about component rendering, local state, hooks, form dirty-state, validation, or prop wiring inside the webview, add or update Vitest coverage under `webview-ui/src/**/__tests__` instead of reaching for `apps/vscode-e2e`.
- Use `apps/vscode-e2e` only when the behavior depends on the real VS Code extension environment: extension-host to webview messaging, VS Code workspace APIs, task execution flows, or other end-to-end behavior that needs `@vscode/test-electron`.
- When a regression can be proven with a component or webview integration test, keep it in `webview-ui`. Do not promote it to e2e just because the UI is hosted inside VS Code.
- For `SettingsView`, preserve the cached-state pattern from the repo root guidance: inputs should operate on local `cachedState` until the user saves, and tests should distinguish automatic initialization from real user edits.

## Visual Tests

- Add Playwright screenshot tests selectively for components where layout, styling, VS Code theme variables, or real web-component rendering are part of the behavior under test.
- Keep behavioral assertions in Vitest. A `*.visual.tsx` test should establish a deterministic state and make a focused screenshot assertion.
- Run visual comparisons with `pnpm test:visual:docker` from `webview-ui/`.
- Update intentional baselines with `pnpm test:visual:docker:update` and commit the resulting `__screenshots__` files with the UI change.
- Use the Docker commands when creating or reviewing baselines; host-rendered screenshots are not the source of truth.
- If Docker is unavailable, `pnpm test:visual` can help diagnose test code, but do not create or update committed baselines from the host rendering environment.
- Keep visual tests limited to components supported by the current Playwright harness. Add shared extension state, translation, React Query, or other provider support before snapshotting components that require it.
- The current baseline naming assumes a single Chromium project. Include `{projectName}` in `snapshotPathTemplate` before adding another browser project.
