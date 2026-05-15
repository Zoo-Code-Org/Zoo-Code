import type { ClineAskResponse, ExtensionMessage, WebviewMessage } from "../vscode-extension-host.js"
import {
	portableCoreApprovalResponses,
	portableCoreExtensionMessageTypes,
	portableCoreProtocolMappings,
	portableCoreWebviewActionTypes,
	ZOO_WEBVIEW_PROTOCOL_VERSION,
} from "../webview-protocol.js"

describe("webview protocol contract", () => {
	it("pins the current protocol version", () => {
		expect(ZOO_WEBVIEW_PROTOCOL_VERSION).toBe(1)
	})

	it("covers portable-core webview action entry points", () => {
		const actions = new Set<WebviewMessage["type"]>(portableCoreWebviewActionTypes)

		expect(actions).toEqual(
			new Set<WebviewMessage["type"]>([
				"newTask",
				"askResponse",
				"queueMessage",
				"cancelTask",
				"terminalOperation",
				"mode",
				"switchMode",
			]),
		)
	})

	it("covers portable-core host-to-webview message surfaces", () => {
		const messages = new Set<ExtensionMessage["type"]>(portableCoreExtensionMessageTypes)

		expect(messages).toEqual(
			new Set<ExtensionMessage["type"]>([
				"state",
				"messageUpdated",
				"taskHistoryUpdated",
				"taskHistoryItemUpdated",
				"invoke",
				"interactionRequired",
				"modes",
			]),
		)
	})

	it("covers approval responses used by the current webview UI", () => {
		expect(new Set<ClineAskResponse>(portableCoreApprovalResponses)).toEqual(
			new Set<ClineAskResponse>(["yesButtonClicked", "noButtonClicked", "messageResponse", "objectResponse"]),
		)
	})

	it("documents target SDK mappings for each portable-core capability", () => {
		expect(Object.keys(portableCoreProtocolMappings).sort()).toEqual(
			[
				"abortTask",
				"modeChange",
				"newTask",
				"sendMessage",
				"sessionState",
				"streamingChunk",
				"taskHistory",
				"terminalOperation",
				"toolApproval",
			].sort(),
		)

		for (const mapping of Object.values(portableCoreProtocolMappings)) {
			expect(mapping.currentHostPath).toBeTruthy()
			expect(mapping.targetSdkPath).toBeTruthy()
		}
	})
})
