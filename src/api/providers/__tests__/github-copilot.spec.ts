import type { Anthropic } from "@anthropic-ai/sdk"
import { openAiModelInfoSaneDefaults, vscodeLlmModels } from "@roo-code/types"

// Mocks must come first, before imports
vi.mock("vscode", () => {
	class MockLanguageModelTextPart {
		type = "text"
		constructor(public value: string) {}
	}

	class MockLanguageModelToolCallPart {
		type = "tool_call"
		constructor(
			public callId: string,
			public name: string,
			public input: object,
		) {}
	}

	class MockLanguageModelToolResultPart {
		type = "tool_result"
		constructor(
			public callId: string,
			public content: unknown[],
		) {}
	}

	return {
		workspace: {
			getConfiguration: vi.fn(() => ({
				get: vi.fn((key: string, defaultValue: unknown) => defaultValue),
			})),
			onDidChangeConfiguration: vi.fn((_callback) => ({
				dispose: vi.fn(),
			})),
		},
		CancellationTokenSource: vi.fn(function () {
			return {
				token: {
					isCancellationRequested: false,
					onCancellationRequested: vi.fn(),
				},
				cancel: vi.fn(),
				dispose: vi.fn(),
			}
		}),
		CancellationError: class CancellationError extends Error {
			constructor() {
				super("Operation cancelled")
				this.name = "CancellationError"
			}
		},
		LanguageModelChatMessage: {
			Assistant: vi.fn((content) => ({
				role: "assistant",
				content: Array.isArray(content) ? content : [new MockLanguageModelTextPart(content)],
			})),
			User: vi.fn((content) => ({
				role: "user",
				content: Array.isArray(content) ? content : [new MockLanguageModelTextPart(content)],
			})),
		},
		LanguageModelTextPart: MockLanguageModelTextPart,
		LanguageModelToolCallPart: MockLanguageModelToolCallPart,
		LanguageModelToolResultPart: MockLanguageModelToolResultPart,
		LanguageModelDataPart: class {
			constructor(
				public data: Uint8Array,
				public mimeType: string,
			) {}
			static image(data: Uint8Array, mimeType: string) {
				return new this(data, mimeType)
			}
		},
		lm: {
			selectChatModels: vi.fn(),
		},
		authentication: {
			getSession: vi.fn(),
		},
		extensions: {
			getExtension: vi.fn(),
		},
		commands: {
			getCommands: vi.fn(),
			executeCommand: vi.fn(),
		},
	}
})

import * as vscode from "vscode"
import {
	GitHubCopilotHandler,
	connectGitHubCopilot,
	getGitHubCopilotAccount,
	openGitHubAccountManagement,
} from "../github-copilot"
import { getVsCodeLmModelInfo } from "../vscode-lm-capabilities"
import type { ApiHandlerOptions } from "../../../shared/api"
import { clearAllMocks } from "../../../test-utils/reset"
import { checkContextWindowExceededError } from "../../../core/context/context-management/context-error-handling"
import { collectStream } from "../../../test-utils/stream"

/** The stable typings this extension builds against predate image parts, so reach them by name. */
const dataPart = () =>
	Reflect.get(vscode, "LanguageModelDataPart") as { image?: unknown; new (...args: never[]): object }

const mockLanguageModelChat = {
	id: "test-model",
	name: "Test Model",
	vendor: "test-vendor",
	family: "test-family",
	version: "1.0",
	maxInputTokens: 4096,
	sendRequest: vi.fn(),
	countTokens: vi.fn(),
}

describe("connectGitHubCopilot", () => {
	beforeEach(() => vi.clearAllMocks())

	it("authenticates through VS Code and selects only Copilot models", async () => {
		vi.mocked(vscode.authentication.getSession).mockResolvedValue({
			id: "test-session",
			accessToken: "test-token",
			scopes: ["user:email"],
			account: { id: "test-account", label: "Test User" },
		})
		vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([])

		const onAuthenticated = vi.fn(async (account: string) => {
			expect(account).toBe("Test User")
			expect(vscode.lm.selectChatModels).not.toHaveBeenCalled()
		})
		await expect(connectGitHubCopilot(onAuthenticated)).resolves.toEqual({ account: "Test User", models: [] })
		expect(onAuthenticated).toHaveBeenCalledOnce()

		expect(vscode.authentication.getSession).toHaveBeenCalledWith("github", ["user:email"], { createIfNone: true })
		expect(vscode.lm.selectChatModels).toHaveBeenCalledWith({ vendor: "copilot" })
	})

	it("rejects an incomplete sign-in rather than reporting a connected account", async () => {
		vi.mocked(vscode.authentication.getSession).mockResolvedValueOnce(undefined)
		await expect(connectGitHubCopilot()).rejects.toThrow("GitHub sign-in did not complete")
		expect(vscode.lm.selectChatModels).not.toHaveBeenCalled()
	})

	it("requests a fresh account session when reconnecting", async () => {
		vi.mocked(vscode.authentication.getSession).mockResolvedValueOnce({
			id: "fresh-session",
			accessToken: "test-token",
			scopes: ["user:email"],
			account: { id: "account", label: "Test User" },
		})
		await connectGitHubCopilot(undefined, true)
		expect(vscode.authentication.getSession).toHaveBeenCalledWith("github", ["user:email"], {
			forceNewSession: true,
			clearSessionPreference: true,
		})
	})

	describe("account", () => {
		const session = (label: string) => ({
			id: "session",
			accessToken: "test-token",
			scopes: [],
			account: { id: "account", label },
		})

		it("recognizes the session Copilot itself uses, whichever supported scope set holds it", async () => {
			vi.mocked(vscode.authentication.getSession).mockImplementation(async (_provider, scopes) =>
				(scopes as readonly string[]).includes("read:user") ? session("Legacy User") : undefined,
			)
			await expect(getGitHubCopilotAccount()).resolves.toBe("Legacy User")
			expect(vscode.authentication.getSession).toHaveBeenCalledWith("github", ["user:email"], { silent: true })
			expect(vscode.authentication.getSession).toHaveBeenCalledWith("github", ["read:user"], { silent: true })
		})

		it("stops at the first scope set that has a session", async () => {
			vi.mocked(vscode.authentication.getSession).mockResolvedValue(session("Current User"))
			await expect(getGitHubCopilotAccount()).resolves.toBe("Current User")
			expect(vscode.authentication.getSession).toHaveBeenCalledTimes(1)
		})

		it("reports no account rather than failing when the lookup throws", async () => {
			vi.mocked(vscode.authentication.getSession).mockRejectedValue(new Error("auth unavailable"))
			await expect(getGitHubCopilotAccount()).resolves.toBeUndefined()
		})

		it("opens VS Code's own account management instead of signing out on its behalf", async () => {
			await openGitHubAccountManagement()
			expect(vscode.commands.executeCommand).toHaveBeenCalledExactlyOnceWith("workbench.action.manageAccounts")
		})
	})

	it("shares one sign-in between concurrent requests", async () => {
		let finish: (value: ReturnType<typeof session>) => void = () => {}
		const session = (label: string) => ({
			id: "session",
			accessToken: "test-token",
			scopes: [],
			account: { id: "account", label },
		})
		vi.mocked(vscode.authentication.getSession).mockImplementationOnce(
			() => new Promise((resolve) => (finish = resolve)) as never,
		)
		vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([])

		const first = connectGitHubCopilot()
		const second = connectGitHubCopilot()
		finish(session("Test User"))

		await expect(Promise.all([first, second])).resolves.toEqual([
			{ account: "Test User", models: [] },
			{ account: "Test User", models: [] },
		])
		expect(vscode.authentication.getSession).toHaveBeenCalledTimes(1)
	})

	describe("overlapping sign-in requests with different intent", () => {
		const session = (label: string) => ({ id: "s", accessToken: "t", scopes: [], account: { id: "a", label } })
		const pendingSession = () => {
			let finish: (value: ReturnType<typeof session>) => void = () => {}
			const promise = new Promise((resolve) => (finish = resolve)) as never
			return { promise, finish: (label: string) => finish(session(label)) }
		}

		it("gives a Reconnect its own forced session instead of the pending plain sign-in's", async () => {
			const plain = pendingSession()
			const fresh = pendingSession()
			vi.mocked(vscode.authentication.getSession)
				.mockImplementationOnce(() => plain.promise)
				.mockImplementationOnce(() => fresh.promise)
			vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([])
			const onFresh = vi.fn()

			const first = connectGitHubCopilot()
			const second = connectGitHubCopilot(onFresh, true)
			plain.finish("Plain User")
			fresh.finish("Fresh User")

			await expect(first).resolves.toMatchObject({ account: "Plain User" })
			await expect(second).resolves.toMatchObject({ account: "Fresh User" })
			expect(vscode.authentication.getSession).toHaveBeenCalledTimes(2)
			expect(vscode.authentication.getSession).toHaveBeenLastCalledWith("github", ["user:email"], {
				forceNewSession: true,
				clearSessionPreference: true,
			})
			expect(onFresh).toHaveBeenCalledWith("Fresh User")
		})

		it("still shares one attempt between concurrent Reconnect requests", async () => {
			const fresh = pendingSession()
			vi.mocked(vscode.authentication.getSession).mockImplementationOnce(() => fresh.promise)
			vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([])

			const results = [connectGitHubCopilot(undefined, true), connectGitHubCopilot(undefined, true)]
			fresh.finish("Fresh User")

			await Promise.all(results)
			expect(vscode.authentication.getSession).toHaveBeenCalledTimes(1)
		})

		it("lets a failed attempt of one kind be retried without disturbing the other", async () => {
			vi.mocked(vscode.authentication.getSession).mockRejectedValueOnce(new Error("cancelled"))
			await expect(connectGitHubCopilot(undefined, true)).rejects.toThrow("cancelled")

			vi.mocked(vscode.authentication.getSession).mockResolvedValueOnce(session("Retry User"))
			vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([])
			await expect(connectGitHubCopilot(undefined, true)).resolves.toMatchObject({ account: "Retry User" })
		})
	})

	it("allows a new sign-in once the previous one has settled", async () => {
		vi.mocked(vscode.authentication.getSession).mockRejectedValueOnce(new Error("Sign-in cancelled"))
		await expect(connectGitHubCopilot()).rejects.toThrow("Sign-in cancelled")

		vi.mocked(vscode.authentication.getSession).mockResolvedValueOnce({
			id: "session",
			accessToken: "test-token",
			scopes: [],
			account: { id: "account", label: "Test User" },
		})
		vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([])
		await expect(connectGitHubCopilot()).resolves.toEqual({ account: "Test User", models: [] })
	})
	it("propagates authentication failures without attempting model discovery", async () => {
		vi.mocked(vscode.authentication.getSession).mockRejectedValueOnce(new Error("Sign-in cancelled"))
		vi.mocked(vscode.lm.selectChatModels).mockClear()

		await expect(connectGitHubCopilot()).rejects.toThrow("Sign-in cancelled")
		expect(vscode.lm.selectChatModels).not.toHaveBeenCalled()
	})
})

describe("Copilot model capabilities", () => {
	const curatedWithVision = Object.entries(vscodeLlmModels).find(([, entry]) => entry.supportsImages)
	if (!curatedWithVision) throw new Error("expected the curated catalog to contain a vision-capable model")
	const [curatedFamily, curatedEntry] = curatedWithVision

	const liveModel = (overrides: Record<string, unknown> = {}) => ({
		...mockLanguageModelChat,
		vendor: "copilot",
		id: "synthetic-model",
		family: "synthetic-family",
		maxInputTokens: 16000,
		...overrides,
	})

	const imageSource = { type: "base64" as const, media_type: "image/png" as const, data: "aW1hZ2U=" }
	const imageMessages: Anthropic.Messages.MessageParam[] = [
		{ role: "user", content: [{ type: "image", source: imageSource }] },
	]
	const toolResultImageMessages: Anthropic.Messages.MessageParam[] = [
		{
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: "tool-1", content: [{ type: "image", source: imageSource }] },
			],
		},
	]

	const send = async (
		model: ReturnType<typeof liveModel>,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: Parameters<GitHubCopilotHandler["createMessage"]>[2],
	) => {
		vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([model])
		const handler = new GitHubCopilotHandler({})
		try {
			await handler.initializeClient()
			await collectStream(handler.createMessage("", messages, metadata))
		} finally {
			handler.dispose()
		}
	}

	beforeEach(() => {
		vi.clearAllMocks()
		mockLanguageModelChat.countTokens.mockResolvedValue(10)
		mockLanguageModelChat.sendRequest.mockImplementation(async () => ({
			stream: (async function* () {
				yield new vscode.LanguageModelTextPart("Done")
			})(),
		}))
	})

	describe("vision resolution", () => {
		it.each([true, false])("treats the host-reported vision flag (%s) as authoritative", (reported) => {
			const info = getVsCodeLmModelInfo(liveModel({ capabilities: { supportsImageToText: reported } }))
			expect(info.supportsImages).toBe(reported)
		})

		it("accepts the provider-side capability spelling when the consumer-side one is absent", () => {
			expect(getVsCodeLmModelInfo(liveModel({ capabilities: { imageInput: true } })).supportsImages).toBe(true)
		})

		it("lets an explicit host report override the curated catalog", () => {
			const model = liveModel({ family: curatedFamily, capabilities: { supportsImageToText: false } })
			expect(getVsCodeLmModelInfo(model).supportsImages).toBe(false)
		})

		it("does not borrow the catalog's vision flag for a live model the host reports nothing about", () => {
			expect(getVsCodeLmModelInfo(liveModel({ family: curatedFamily })).supportsImages).toBeUndefined()
		})

		it("leaves vision unset rather than guessing when no source states it", () => {
			expect(getVsCodeLmModelInfo(liveModel()).supportsImages).toBeUndefined()
		})

		it("reports no vision when this host cannot construct image parts", () => {
			const parts = dataPart()
			const original = parts.image
			Object.assign(parts, { image: undefined })
			try {
				expect(
					getVsCodeLmModelInfo(liveModel({ capabilities: { supportsImageToText: true } })).supportsImages,
				).toBe(false)
			} finally {
				Object.assign(parts, { image: original })
			}
		})

		it("keeps unknown vision unset through the no-client fallback instead of defaulting it to unsupported", () => {
			const handler = new GitHubCopilotHandler({
				vsCodeLmModelSelector: { vendor: "copilot", family: "synthetic-family" },
			})
			try {
				expect(handler.getModel().info.supportsImages).toBeUndefined()
			} finally {
				handler.dispose()
			}
		})
	})

	describe("context window", () => {
		it("uses the live input limit when the catalog has no entry", () => {
			expect(getVsCodeLmModelInfo(liveModel({ maxInputTokens: 921793 })).contextWindow).toBe(921793)
		})

		it("honors a live limit smaller than the curated limit", () => {
			const model = liveModel({ family: curatedFamily, maxInputTokens: curatedEntry.maxInputTokens - 1 })
			expect(getVsCodeLmModelInfo(model).contextWindow).toBe(curatedEntry.maxInputTokens - 1)
		})

		it("caps an inflated live limit at the curated limit", () => {
			const model = liveModel({ family: curatedFamily, maxInputTokens: curatedEntry.maxInputTokens * 10 })
			expect(getVsCodeLmModelInfo(model).contextWindow).toBe(curatedEntry.maxInputTokens)
		})

		it("falls back to a sane default when the host reports no usable limit", () => {
			expect(getVsCodeLmModelInfo(liveModel({ maxInputTokens: 0 })).contextWindow).toBe(
				openAiModelInfoSaneDefaults.contextWindow,
			)
		})
	})

	describe("requests", () => {
		const visionModel = () => liveModel({ capabilities: { supportsImageToText: true } })

		it("transmits image bytes and counts the real message when vision is reported", async () => {
			await send(visionModel(), imageMessages)
			const messages = mockLanguageModelChat.sendRequest.mock.calls[0][0]
			expect(messages[1].content[0]).toBeInstanceOf(dataPart())
			expect(messages[1].content[0].data).toEqual(Buffer.from("image"))
			expect(mockLanguageModelChat.countTokens).toHaveBeenCalledWith(messages[1], expect.anything())
		})

		it("transmits image bytes nested inside tool results", async () => {
			await send(visionModel(), toolResultImageMessages)
			const toolResult = mockLanguageModelChat.sendRequest.mock.calls[0][0][1].content[0]
			expect(toolResult.content[0]).toBeInstanceOf(dataPart())
		})

		it.each([
			["reported unsupported", { capabilities: { supportsImageToText: false } }],
			["not reported", {}],
		])("rejects images before sending when vision is %s", async (_label, overrides) => {
			await expect(send(liveModel(overrides), imageMessages)).rejects.toThrow(
				"does not report image input support",
			)
			await expect(send(liveModel(overrides), toolResultImageMessages)).rejects.toThrow(
				"does not report image input support",
			)
			expect(mockLanguageModelChat.sendRequest).not.toHaveBeenCalled()
		})

		it("forwards every offered tool without imposing a client-side cap", async () => {
			const tools = Array.from({ length: 130 }, (_, index) => ({
				type: "function" as const,
				function: {
					name: `tool_${index}`,
					description: "A tool",
					parameters: { type: "object", properties: {} },
				},
			}))
			await send(liveModel(), [], { taskId: "tool-passthrough", tools })
			expect(mockLanguageModelChat.sendRequest.mock.calls[0][1].tools).toHaveLength(130)
		})
	})
})

describe("GitHubCopilotHandler", () => {
	const defaultOptions: ApiHandlerOptions = {
		vsCodeLmModelSelector: { vendor: "test-vendor", family: "test-family" },
	}

	beforeEach(() => {
		clearAllMocks()
		vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([{ ...mockLanguageModelChat }] as never)
	})

	it("forces the Copilot vendor even when the saved selector names another vendor", async () => {
		const copilotHandler = new GitHubCopilotHandler(defaultOptions)
		try {
			await copilotHandler.initializeClient()
			expect(vscode.lm.selectChatModels).toHaveBeenCalledWith({ vendor: "copilot", family: "test-family" })
		} finally {
			copilotHandler.dispose()
		}
	})

	it("rejects unavailable Copilot models instead of generating placeholder output", async () => {
		const copilotHandler = new GitHubCopilotHandler(defaultOptions)
		try {
			vi.mocked(vscode.lm.selectChatModels).mockResolvedValueOnce([])
			await expect(copilotHandler.createClient({ vendor: "copilot", id: "missing-model" })).rejects.toThrow(
				"No matching GitHub Copilot model",
			)
		} finally {
			copilotHandler.dispose()
		}
	})

	describe("input limits", () => {
		const copilotModel = (overrides: Record<string, unknown> = {}) => ({
			...mockLanguageModelChat,
			vendor: "copilot",
			id: "limited",
			family: "limited-family",
			maxInputTokens: 16000,
			...overrides,
		})

		const run = async (perMessageTokens: number) => {
			vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([copilotModel()] as never)
			mockLanguageModelChat.countTokens.mockResolvedValue(perMessageTokens)
			mockLanguageModelChat.sendRequest.mockImplementation(async () => ({
				stream: (async function* () {
					yield new vscode.LanguageModelTextPart("ok")
				})(),
			}))
			const handler = new GitHubCopilotHandler({})
			try {
				await collectStream(handler.createMessage("system", [{ role: "user", content: "hello" }]))
			} finally {
				handler.dispose()
			}
		}

		it("refuses a request measured over the model's window, as an error Zoo recovers from by condensing", async () => {
			const failure = await run(9000).catch((error: unknown) => error)

			expect(checkContextWindowExceededError(failure)).toBe(true)
			expect(mockLanguageModelChat.sendRequest).not.toHaveBeenCalled()
		})

		it("admits a request that exactly fills the window", async () => {
			// System prompt and user message are counted separately: 2 x 8000 = 16000.
			await expect(run(8000)).resolves.toBeUndefined()
			expect(mockLanguageModelChat.sendRequest).toHaveBeenCalledTimes(1)
		})
	})

	describe("countTokens", () => {
		beforeEach(() => mockLanguageModelChat.countTokens.mockResolvedValue(42))

		it("measures the content as a user message through the host's counter", async () => {
			vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([
				{ ...mockLanguageModelChat, vendor: "copilot" },
			] as never)
			const handler = new GitHubCopilotHandler({})
			try {
				await expect(handler.countTokens([{ type: "text", text: "hello" }])).resolves.toBe(42)
				expect(mockLanguageModelChat.countTokens).toHaveBeenCalledTimes(1)
				expect(mockLanguageModelChat.countTokens.mock.calls[0][0]).toMatchObject({ role: "user" })
			} finally {
				handler.dispose()
			}
		})

		it("fails clearly, rather than returning a made-up count, when no Copilot model is available", async () => {
			vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([])
			const handler = new GitHubCopilotHandler({})
			try {
				await expect(handler.countTokens([{ type: "text", text: "hello" }])).rejects.toThrow(
					"No matching GitHub Copilot model",
				)
			} finally {
				handler.dispose()
			}
		})
	})
})
