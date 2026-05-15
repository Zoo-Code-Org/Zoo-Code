# Webview Message Protocol

The Zoo Code VS Code extension currently uses a host-webview protocol defined by `ExtensionMessage` and `WebviewMessage` in `@zoo-code/types`. Phase 3 portable-core work keeps this protocol stable while the extension host starts routing selected actions through `@zoo-code/sdk` and the Zoo CLI server behind `zoo-code.usePortableCore`.

Protocol version: `ZOO_WEBVIEW_PROTOCOL_VERSION = 1`.

## Contract Sources

- `packages/types/src/vscode-extension-host.ts` defines `ExtensionMessage`, `WebviewMessage`, `ExtensionState`, and `ClineAskResponse`.
- `packages/types/src/webview-protocol.ts` pins the current portable-core-relevant protocol surfaces and SDK mappings.
- `packages/types/src/__tests__/webview-protocol.test.ts` fails if the pinned portable-core contract changes without an intentional test update.

## Current And Target Mapping

| Capability         | Current webview contract                                                      | Current extension path                                    | Portable-core target                                                                    |
| ------------------ | ----------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| New task           | `WebviewMessage` type `newTask`                                               | `webviewMessageHandler -> ClineProvider.createTask`       | `ZooClient.createSession()` then `ZooClient.sendMessage()`                              |
| Follow-up message  | `askResponse` with `askResponse: "messageResponse"`                           | `Task.handleWebviewAskResponse -> Task.submitUserMessage` | `ZooClient.sendMessage()`                                                               |
| Streaming chunks   | `ExtensionMessage` type `messageUpdated` with `clineMessage`                  | `Task` updates via `ClineProvider.postMessageToWebview`   | `MessageChunk` stream from `ZooClient.sendMessage()` mapped into `ClineMessage` updates |
| Session state      | `ExtensionMessage` type `state` with partial `ExtensionState`                 | `ClineProvider.postStateToWebview`                        | SDK session create/list/get mapped into `ExtensionState`                                |
| Task history       | `taskHistoryUpdated` and `taskHistoryItemUpdated`                             | `ClineProvider` task history store broadcasts             | `ZooClient.listSessions()` mapped into task history                                     |
| Tool approvals     | `askResponse` with `yesButtonClicked`, `noButtonClicked`, or `objectResponse` | `Task.handleWebviewAskResponse`                           | SDK approval response routed to CLI approval protocol                                   |
| Abort              | `WebviewMessage` type `cancelTask`                                            | `ClineProvider.cancelTask -> Task.abortTask`              | `ZooClient.abortSession()`                                                              |
| Terminal operation | `terminalOperation` with `continue` or `abort`                                | `Task.handleTerminalOperation`                            | Portable-core terminal/tool event adapter                                               |
| Mode change        | `mode` and `switchMode`                                                       | `ClineProvider.handleModeSwitch`                          | Portable-core mode/session selection adapter                                            |

## Compatibility Rules

- Do not remove or rename pinned portable-core message types without updating `ZOO_WEBVIEW_PROTOCOL_VERSION`, this document, and the contract tests.
- Keep legacy extension-host behavior as the default while `zoo-code.usePortableCore` is `false`.
- SDK-backed paths should adapt into the existing `state` and `messageUpdated` messages until the React UI deliberately migrates to a new protocol.
- Approval and abort messages must preserve current UI semantics so user decisions and cancellation behavior remain stable across flag paths.
