import * as vscode from "vscode"

import { makeTextEditor, makeUri } from "../../../test-utils/vscode"
import type { CodeIndexStatusConsumer } from "../interfaces/status-consumer"
import type { CodeIndexManager } from "../manager"
import { CodeIndexScopeStatusManager } from "../code-index-scope-status-manager"

describe("CodeIndexScopeStatusManager", () => {
	const workspaceUri = makeUri("/workspace")
	let requestUpdate: (() => void) | undefined
	let progressUpdate: (() => void) | undefined
	let refreshDispose: ReturnType<typeof vi.fn>
	let progressDispose: ReturnType<typeof vi.fn>
	let consumer: CodeIndexStatusConsumer
	let codeIndexManager: CodeIndexManager

	beforeEach(() => {
		vi.clearAllMocks()
		requestUpdate = undefined
		progressUpdate = undefined
		refreshDispose = vi.fn()
		progressDispose = vi.fn()
		consumer = {
			onDidRequestCodeIndexStatusSubscriptionUpdate: ((listener: () => void) => {
				requestUpdate = listener
				return { dispose: refreshDispose }
			}) as vscode.Event<void>,
			postCodeIndexStatus: vi.fn().mockResolvedValue(undefined),
		}
		codeIndexManager = {
			onProgressUpdate: (listener: () => void) => {
				progressUpdate = listener
				return { dispose: progressDispose }
			},
			getCurrentStatus: vi.fn().mockReturnValue({ systemStatus: "Standby", message: "Ready" }),
		} as unknown as CodeIndexManager
		Object.defineProperty(vscode.window, "activeTextEditor", {
			configurable: true,
			value: makeTextEditor({ document: { uri: makeUri("/workspace/file.ts") } as vscode.TextDocument }),
		})
		vi.spyOn(vscode.workspace, "getWorkspaceFolder").mockReturnValue({
			uri: workspaceUri,
		} as vscode.WorkspaceFolder)
	})

	it("publishes only while its workspace is active", () => {
		const manager = new CodeIndexScopeStatusManager(workspaceUri.fsPath, codeIndexManager)
		manager.init(consumer)

		expect(consumer.postCodeIndexStatus).toHaveBeenCalledOnce()
		progressUpdate?.()
		expect(consumer.postCodeIndexStatus).toHaveBeenCalledTimes(2)

		vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue({
			uri: makeUri("/other-workspace"),
		} as vscode.WorkspaceFolder)
		requestUpdate?.()
		expect(progressDispose).toHaveBeenCalledOnce()

		progressUpdate?.()
		expect(consumer.postCodeIndexStatus).toHaveBeenCalledTimes(2)
	})

	it("disposes refresh and progress subscriptions", () => {
		const manager = new CodeIndexScopeStatusManager(workspaceUri.fsPath, codeIndexManager)
		manager.init(consumer)

		manager.dispose()

		expect(refreshDispose).toHaveBeenCalledOnce()
		expect(progressDispose).toHaveBeenCalledOnce()
	})
})
