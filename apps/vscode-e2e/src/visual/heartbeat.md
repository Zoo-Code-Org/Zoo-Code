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

A recovery attempt includes HTML-generation errors. Three attempts exhaust the budget; a startup heartbeat alone does not reset it. Periodic heartbeats must span a 60-second healthy window to replenish the budget. Exhaustion or unavailable/failed scoped host recovery logs once and offers non-modal Retry Interface Recovery, Reload Window, and Show Logs actions. A sidebar replacement that arrives after the ten-second wait retains the incident budget and displayed task. A failed sidebar focus command clears the pending marker so a later manual open starts normally. A sidebar or tab that fails initialization after publication shows the recovery warning and keeps its task and a watchdog for bounded retries. Failure handling lives in the shared view resolver, including sidebar callbacks invoked independently by VS Code. A published sidebar that is still initializing after the ten-second wait keeps its remaining attempts. The warning does not consume the remaining attempts. Duplicate warnings are suppressed until heartbeats resume or a user-opened view resets the notification state. A later terminal failure still logs its final stop reason once, independently of warning deduplication. Subsequent watchdog ticks do not repeat the stop log. Automatic recovery replenishes the incident budget only after sustained healthy heartbeats. Window reload is never automatic. Late Retry Interface Recovery and Reload Window actions are ignored after liveness returns or a newer explicit recovery generation starts. Show Logs still opens the output channel.

Keep exact timing boundaries, individual post-await guards, and reload-budget assertions in provider unit tests. Exercise OS minimize and sleep/resume behavior manually; the Electron scenarios do not reproduce OS suspension or its scheduling order.

The [bounded recovery model](../../../../docs/architecture/webview-recovery-model.md) checks production recovery policies and abstract interleavings. Run `pnpm webview-recovery:model-check` alongside the provider and Electron tests. It does not prove VS Code effects or recovery liveness.

## Explicit recovery after a timeout

Choose **Retry Interface Recovery** in the warning, or run **Zoo Code: Retry Interface Recovery** from the Command Palette. The command remains available if the warning was dismissed or the sidebar has no live view. It starts a new recovery generation, counts the requested repair as the first of three attempts, clears the old warning/log state, and retains the task stack, including an interrupted task. It does not reload the VS Code window.

Reopening a sidebar after a timed-out focus is ambiguous: VS Code does not pass a user-versus-programmatic origin to the resolver. Such a callback keeps the pending incident and its budget. The explicit retry command supplies the missing user intent. Late command completions and notifications from older generations cannot change the renewed budget or release its operation ownership. An already-issued VS Code command cannot be cancelled by this generation guard; the guard prevents subsequent obsolete extension-side effects.
