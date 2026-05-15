# AGENTS.md

This file provides guidance to agents working in `webview-ui/`.

- Prefer local `webview-ui` tests for React/webview behavior. If a change is about component rendering, local state, hooks, form dirty-state, validation, or prop wiring inside the webview, add or update Vitest coverage under `webview-ui/src/**/__tests__` instead of reaching for `apps/vscode-e2e`.
- Use `apps/vscode-e2e` only when the behavior depends on the real VS Code extension environment: extension-host to webview messaging, VS Code workspace APIs, task execution flows, or other end-to-end behavior that needs `@vscode/test-electron`.
- When a regression can be proven with a component or webview integration test, keep it in `webview-ui`. Do not promote it to e2e just because the UI is hosted inside VS Code.
- For `SettingsView`, preserve the cached-state pattern from the repo root guidance: inputs should operate on local `cachedState` until the user saves, and tests should distinguish automatic initialization from real user edits.
