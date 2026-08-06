// npx vitest run src/activate/__tests__/registerAutocomplete.spec.ts

import { vi, describe, it, expect, beforeEach } from "vitest"
import * as vscode from "vscode"

import { ClineProvider } from "../../core/webview/ClineProvider"
import { registerAutocomplete } from "../registerAutocomplete"

vi.mock("vscode", async () => {
	const actual = await vi.importActual<typeof import("vscode")>("vscode")
	return {
		...actual,
		RelativePattern: class {
			base: unknown
			pattern: string
			constructor(base: unknown, pattern: string) {
				this.base = base
				this.pattern = pattern
			}
		},
		StatusBarAlignment: { Left: 1, Right: 2 },
		ThemeColor: class {
			id: string
			constructor(id: string) {
				this.id = id
			}
		},
		window: {
			...actual.window,
			showErrorMessage: vi.fn().mockResolvedValue(undefined),
			createStatusBarItem: vi.fn(() => ({
				show: vi.fn(),
				dispose: vi.fn(),
				text: "",
				tooltip: "",
				command: undefined,
				backgroundColor: undefined,
			})),
		},
		workspace: {
			...actual.workspace,
			workspaceFolders: [{ uri: { fsPath: "/workspace" } }],
			onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
			createFileSystemWatcher: vi.fn(() => ({
				onDidChange: () => ({ dispose: vi.fn() }),
				onDidCreate: () => ({ dispose: vi.fn() }),
				onDidDelete: () => ({ dispose: vi.fn() }),
				dispose: vi.fn(),
			})),
		},
		languages: {
			...actual.languages,
			registerInlineCompletionItemProvider: vi.fn(() => ({ dispose: vi.fn() })),
		},
		commands: {
			...actual.commands,
			registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
		},
	}
})

vi.mock("../../core/webview/ClineProvider")

vi.mock("../../shared/package", () => ({
	Package: { name: "zoo-code" },
}))

describe("registerAutocomplete", () => {
	let mockContext: vscode.ExtensionContext
	let mockProvider: { postMessageToWebview: ReturnType<typeof vi.fn> }

	beforeEach(() => {
		vi.clearAllMocks()
		mockContext = {
			subscriptions: [],
		} as unknown as vscode.ExtensionContext
		mockProvider = {
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
		}
	})

	it("registers the inline completion provider and the open-settings command", async () => {
		await registerAutocomplete({
			context: mockContext,
			provider: mockProvider as unknown as ClineProvider,
			getGlobalConfig: () => ({ enabled: false }) as never,
			getApiKey: () => undefined,
		})

		expect(vscode.languages.registerInlineCompletionItemProvider).toHaveBeenCalledWith(
			{ pattern: "**/*" },
			expect.anything(),
		)
		expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
			"zoo-code.autocomplete.openSettings",
			expect.any(Function),
		)
		expect(mockContext.subscriptions.length).toBeGreaterThan(0)
	})

	it("open-settings command deep-links the webview to the autocomplete section", async () => {
		await registerAutocomplete({
			context: mockContext,
			provider: mockProvider as unknown as ClineProvider,
			getGlobalConfig: () => ({ enabled: false }) as never,
			getApiKey: () => undefined,
		})

		const registerCall = vi
			.mocked(vscode.commands.registerCommand)
			.mock.calls.find(([id]) => id === "zoo-code.autocomplete.openSettings")
		const handler = registerCall?.[1] as () => void
		handler()

		expect(mockProvider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "switchTab",
			tab: "settings",
			values: { section: "autocomplete" },
		})
	})

	it("shows an error when the webview message cannot be posted", async () => {
		mockProvider.postMessageToWebview.mockRejectedValueOnce(new Error("webview gone"))
		await registerAutocomplete({
			context: mockContext,
			provider: mockProvider as unknown as ClineProvider,
			getGlobalConfig: () => ({ enabled: false }) as never,
			getApiKey: () => undefined,
		})

		const registerCall = vi
			.mocked(vscode.commands.registerCommand)
			.mock.calls.find(([id]) => id === "zoo-code.autocomplete.openSettings")
		const handler = registerCall?.[1] as () => void
		handler()

		// The rejection is handled in a `.catch` microtask; flush it before asserting.
		await new Promise((resolve) => setImmediate(resolve))

		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("webview gone"))
	})
})
