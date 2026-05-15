import type { ClineAskResponse, ExtensionMessage, WebviewMessage } from "./vscode-extension-host.js"

/** Current host-webview protocol version used by the VS Code extension. */
export const ZOO_WEBVIEW_PROTOCOL_VERSION = 1 as const

/** Webview actions that must remain stable while portable-core routing is introduced. */
export const portableCoreWebviewActionTypes = [
	"newTask",
	"askResponse",
	"queueMessage",
	"cancelTask",
	"terminalOperation",
	"mode",
	"switchMode",
] as const satisfies readonly WebviewMessage["type"][]

/** Host messages that must remain stable while SDK events are adapted for the current React UI. */
export const portableCoreExtensionMessageTypes = [
	"state",
	"messageUpdated",
	"taskHistoryUpdated",
	"taskHistoryItemUpdated",
	"invoke",
	"interactionRequired",
	"modes",
] as const satisfies readonly ExtensionMessage["type"][]

/** Approval responses currently emitted by the webview approval UI. */
export const portableCoreApprovalResponses = [
	"yesButtonClicked",
	"noButtonClicked",
	"messageResponse",
	"objectResponse",
] as const satisfies readonly ClineAskResponse[]

/** SDK mapping for the stable webview protocol capabilities. */
export const portableCoreProtocolMappings = {
	newTask: {
		currentWebviewMessage: "newTask",
		currentHostPath: "webviewMessageHandler -> ClineProvider.createTask",
		targetSdkPath: "ZooClient.createSession + ZooClient.sendMessage",
	},
	sendMessage: {
		currentWebviewMessage: "askResponse:messageResponse",
		currentHostPath: "Task.handleWebviewAskResponse -> Task.submitUserMessage",
		targetSdkPath: "ZooClient.sendMessage",
	},
	streamingChunk: {
		currentExtensionMessage: "messageUpdated",
		currentHostPath: "Task message update -> ClineProvider.postMessageToWebview",
		targetSdkPath: "ZooClient.sendMessage MessageChunk stream",
	},
	sessionState: {
		currentExtensionMessage: "state",
		currentHostPath: "ClineProvider.postStateToWebview",
		targetSdkPath: "ZooClient.createSession/listSessions/getSession mapped into ExtensionState",
	},
	taskHistory: {
		currentExtensionMessage: "taskHistoryUpdated",
		currentHostPath: "ClineProvider.broadcastTaskHistoryUpdate",
		targetSdkPath: "ZooClient.listSessions mapped into task history",
	},
	toolApproval: {
		currentWebviewMessage: "askResponse:yesButtonClicked|noButtonClicked|objectResponse",
		currentHostPath: "Task.handleWebviewAskResponse",
		targetSdkPath: "SDK approval response routed to CLI approval protocol",
	},
	abortTask: {
		currentWebviewMessage: "cancelTask",
		currentHostPath: "ClineProvider.cancelTask -> Task.abortTask",
		targetSdkPath: "ZooClient.abortSession",
	},
	terminalOperation: {
		currentWebviewMessage: "terminalOperation:continue|abort",
		currentHostPath: "Task.handleTerminalOperation",
		targetSdkPath: "Portable-core terminal/tool event adapter",
	},
	modeChange: {
		currentWebviewMessage: "mode|switchMode",
		currentHostPath: "ClineProvider.handleModeSwitch",
		targetSdkPath: "Portable-core mode/session selection adapter",
	},
} as const

export type PortableCoreProtocolMapping = keyof typeof portableCoreProtocolMappings
