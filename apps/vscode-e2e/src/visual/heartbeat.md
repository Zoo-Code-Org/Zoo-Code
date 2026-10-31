# Webview heartbeat checks

Build the extension, production webview assets, and extension-host controller, then run the heartbeat project:

```sh
pnpm --filter @roo-code/vscode-e2e visual:build
xvfb-run -a pnpm --filter @roo-code/vscode-e2e exec playwright test -c playwright-electron.config.ts --project=heartbeat
```

The scenarios use isolated VS Code instances and the production 60-second watchdog tick and 90-second stale threshold:

- Block only heartbeat messages at VS Code's webview message port, verify the watchdog replaces the document, and verify mount and periodic heartbeats resume.
- Terminate the webview renderer after verifying that its OS process differs from the workbench process, then require the task UI and periodic heartbeats to return. A fresh extension-host probe must report the same nonempty task stack. A timeout records a screenshot, trace, extension logs, and process IDs.
- Hide the sidebar with heartbeats blocked for 125 seconds, verify the document survives, reopen it, and restore heartbeat delivery.

The message-port interceptor follows the pinned VS Code implementation. Check it when upgrading VS Code. It does not modify the extension or fake extension-host timers. Heartbeat blocking and renderer termination are separate failure modes; passing the former does not establish crash recovery.

A gray sidebar can persist after renderer termination even when the watchdog assigns fresh HTML. HTML delivery alone cannot restart a dead renderer. Recovery now waits ten seconds for a heartbeat after assigning HTML, then recreates the affected host if the renderer has not responded. Sidebar recovery uses the generated view-removal and focus commands after checking their availability; tab recovery replaces its panel while retaining its provider. The crash test covers the real sidebar path. Unit tests cover tab replacement and task ownership.

A recovery attempt includes HTML-generation errors. Three attempts exhaust the budget; a startup heartbeat alone does not reset it. Periodic heartbeats must span a 60-second healthy window to replenish the budget. Exhaustion or unavailable/failed scoped host recovery logs once and offers a non-modal Reload Window or Show Logs action. A sidebar replacement that arrives after the ten-second wait retains the incident budget and displayed task. Only sustained healthy heartbeats replenish that budget. Window reload is never automatic. A late action from an old notification is ignored after liveness returns.

Keep exact timing boundaries, individual post-await guards, and reload-budget assertions in provider unit tests. Exercise OS minimize and sleep/resume behavior manually; the Electron scenarios do not reproduce OS suspension or its scheduling order.
