# Webview heartbeat checks

Build the extension, production webview assets, and extension-host controller, then run the heartbeat project:

```sh
pnpm --filter @roo-code/vscode-e2e visual:build
xvfb-run -a pnpm --filter @roo-code/vscode-e2e exec playwright test -c playwright-electron.config.ts --project=heartbeat
```

The scenarios use isolated VS Code instances and the production 60-second watchdog tick and 90-second stale threshold:

- Block only heartbeat messages at VS Code's webview message port, verify the watchdog replaces the document, and verify mount and periodic heartbeats resume.
- Terminate the webview renderer after verifying that its OS process differs from the workbench process, then require the welcome UI and periodic heartbeats to return. A timeout records a screenshot, trace, extension logs, and process IDs.
- Hide the sidebar with heartbeats blocked for 125 seconds, verify the document survives, reopen it, and restore heartbeat delivery.

The message-port interceptor follows the pinned VS Code implementation. Check it when upgrading VS Code. It does not modify the extension or fake extension-host timers. Heartbeat blocking and renderer termination are separate failure modes; passing the former does not establish crash recovery.

At PR head `a985f03ba`, terminating the isolated renderer reproduces a gray sidebar: the watchdog logs recovery, but assigning fresh HTML does not restore the UI within 150 seconds. The crash test intentionally remains an active regression test. It must pass before claiming recovery from a terminated renderer.

Keep exact timing boundaries, individual post-await guards, and reload-budget assertions in provider unit tests. Exercise OS minimize and sleep/resume behavior manually; the Electron scenarios do not reproduce OS suspension or its scheduling order.
