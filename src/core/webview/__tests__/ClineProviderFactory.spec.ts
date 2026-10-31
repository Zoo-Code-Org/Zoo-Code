import type * as vscode from "vscode"

import { ClineProviderFactory } from "../ClineProviderFactory"
import { ClineProvider } from "../ClineProvider"
import { WebviewFocusTracker } from "../WebviewFocusTracker"
import { openClineInNewTabForApi } from "../../../activate/registerCommands"
import { makeExtensionContext } from "../../../test-utils/vscode"

vi.mock("../../../activate/registerCommands", () => ({ openClineInNewTabForApi: vi.fn() }))
vi.mock("../ClineProvider", () => ({ ClineProvider: class {} }))

describe("ClineProviderFactory", () => {
	let context: vscode.ExtensionContext
	let outputChannel: vscode.OutputChannel
	let tracker: WebviewFocusTracker
	let factory: ClineProviderFactory
	let provider: ClineProvider

	beforeEach(() => {
		vi.clearAllMocks()
		context = makeExtensionContext()
		outputChannel = {
			name: "test-output",
			append: vi.fn(),
			appendLine: vi.fn(),
			replace: vi.fn(),
			clear: vi.fn(),
			show: vi.fn(),
			hide: vi.fn(),
			dispose: vi.fn(),
		}
		tracker = new WebviewFocusTracker()
		factory = new ClineProviderFactory(context, outputChannel, tracker)
		provider = Object.create(ClineProvider.prototype) as ClineProvider
		vi.mocked(openClineInNewTabForApi).mockResolvedValue(provider)
	})

	it("creates a tab with its injected dependencies and returns the provider", async () => {
		await expect(factory.createInNewTab()).resolves.toBe(provider)
		expect(openClineInNewTabForApi).toHaveBeenCalledExactlyOnceWith({
			context,
			outputChannel,
			webviewFocusTracker: tracker,
		})
	})

	it("keeps dependencies independent between factory instances", async () => {
		const secondContext = makeExtensionContext()
		const secondTracker = new WebviewFocusTracker()
		const secondFactory = new ClineProviderFactory(secondContext, outputChannel, secondTracker)
		const secondProvider = Object.create(ClineProvider.prototype) as ClineProvider
		vi.mocked(openClineInNewTabForApi).mockResolvedValueOnce(provider).mockResolvedValueOnce(secondProvider)

		await expect(factory.createInNewTab()).resolves.toBe(provider)
		await expect(secondFactory.createInNewTab()).resolves.toBe(secondProvider)
		expect(openClineInNewTabForApi).toHaveBeenNthCalledWith(1, {
			context,
			outputChannel,
			webviewFocusTracker: tracker,
		})
		expect(openClineInNewTabForApi).toHaveBeenNthCalledWith(2, {
			context: secondContext,
			outputChannel,
			webviewFocusTracker: secondTracker,
		})
	})

	it("propagates tab creation errors", async () => {
		const error = new Error("Cannot create a tab")
		vi.mocked(openClineInNewTabForApi).mockRejectedValueOnce(error)
		await expect(factory.createInNewTab()).rejects.toBe(error)
	})
})
