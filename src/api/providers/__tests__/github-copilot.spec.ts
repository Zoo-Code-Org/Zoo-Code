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
import { registerCopilotModelBroadcast } from "../../../services/language-models/copilotModelBroadcast"
import {
	GitHubCopilotHandler,
	connectGitHubCopilot,
	getGitHubCopilotModels,
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

	it("activates Copilot Chat after sign-in so model discovery can see its models", async () => {
		const activate = vi.fn(async () => {
			expect(vscode.lm.selectChatModels).not.toHaveBeenCalled()
		})
		vi.mocked(vscode.extensions.getExtension).mockReturnValue({ activate } as unknown as vscode.Extension<unknown>)
		vi.mocked(vscode.authentication.getSession).mockResolvedValue({
			id: "test-session",
			accessToken: "test-token",
			scopes: ["user:email"],
			account: { id: "test-account", label: "Test User" },
		})
		vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([])

		await expect(connectGitHubCopilot()).resolves.toEqual({ account: "Test User", models: [] })

		expect(vscode.extensions.getExtension).toHaveBeenCalledWith("GitHub.copilot-chat")
		expect(activate).toHaveBeenCalledOnce()
		expect(vscode.lm.selectChatModels).toHaveBeenCalledOnce()
	})

	it("still lists models when Copilot Chat is not installed", async () => {
		vi.mocked(vscode.extensions.getExtension).mockReturnValue(undefined)
		vi.mocked(vscode.authentication.getSession).mockResolvedValue({
			id: "test-session",
			accessToken: "test-token",
			scopes: ["user:email"],
			account: { id: "test-account", label: "Test User" },
		})
		vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([])

		await expect(connectGitHubCopilot()).resolves.toEqual({ account: "Test User", models: [] })
		expect(vscode.extensions.getExtension).toHaveBeenCalledWith("GitHub.copilot-chat")
		expect(vscode.lm.selectChatModels).toHaveBeenCalledOnce()
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

		it("reports no account when no supported scope set holds a session", async () => {
			vi.mocked(vscode.authentication.getSession).mockResolvedValue(undefined)
			await expect(getGitHubCopilotAccount()).resolves.toBeUndefined()
			expect(vscode.authentication.getSession).toHaveBeenCalledTimes(2)
			expect(vscode.authentication.getSession).toHaveBeenCalledWith("github", ["user:email"], { silent: true })
			expect(vscode.authentication.getSession).toHaveBeenCalledWith("github", ["read:user"], { silent: true })
		})

		it("lets a failed lookup throw instead of reporting it as signed out", async () => {
			vi.mocked(vscode.authentication.getSession).mockRejectedValue(new Error("auth unavailable"))
			await expect(getGitHubCopilotAccount()).rejects.toThrow("auth unavailable")
		})

		it("keeps every view's account label when a broadcast's real account lookup fails", async () => {
			vi.useFakeTimers()
			try {
				vi.mocked(vscode.authentication.getSession).mockRejectedValue(new Error("auth unavailable"))
				vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([])
				const view = { postMessageToWebview: vi.fn().mockResolvedValue(undefined) }
				const log = vi.fn()
				let notify!: () => void
				const registration = registerCopilotModelBroadcast({
					getTargets: () => [view],
					log,
					debounceMs: 10,
					subscribe: (listener) => {
						notify = listener
						return { dispose: () => {} }
					},
				})
				try {
					notify()
					await vi.advanceTimersByTimeAsync(10)
				} finally {
					registration.dispose()
				}

				// Posting `githubCopilotAccount: null` here would clear the label as if the user signed out.
				expect(view.postMessageToWebview).not.toHaveBeenCalled()
				expect(log).toHaveBeenCalledWith("Failed to refresh GitHub Copilot state: auth unavailable")
			} finally {
				vi.useRealTimers()
			}
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

		it.each([
			["a capabilities object that says nothing about vision", { supportsToolCalling: true }],
			["an empty capabilities object", {}],
			["vision reported as something other than a boolean", { supportsImageToText: "yes", imageInput: 1 }],
		])("leaves vision unset for %s", (_label, capabilities) => {
			expect(getVsCodeLmModelInfo(liveModel({ capabilities })).supportsImages).toBeUndefined()
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

	describe("tool support resolution", () => {
		it.each([true, false])("treats the host-reported tool flag (%s) as authoritative", (reported) => {
			const info = getVsCodeLmModelInfo(liveModel({ capabilities: { supportsToolCalling: reported } }))
			expect(info.supportsToolCalling).toBe(reported)
		})

		it.each([
			[true, 128],
			[true, 1],
			[false, 0],
		])("reads the provider-side tool count as supported=%s for %s tools, never as a limit", (expected, count) => {
			const info = getVsCodeLmModelInfo(liveModel({ capabilities: { toolCalling: count } }))
			expect(info.supportsToolCalling).toBe(expected)
			// The count must change nothing else: the result equals what the plain boolean
			// report produces, so it is never carried into model info as a per-model tool limit.
			const withoutCount = getVsCodeLmModelInfo(liveModel({ capabilities: { toolCalling: expected } }))
			expect(info).toStrictEqual(withoutCount)
		})

		it("accepts the provider-side boolean spelling when the consumer-side one is absent", () => {
			expect(getVsCodeLmModelInfo(liveModel({ capabilities: { toolCalling: true } })).supportsToolCalling).toBe(
				true,
			)
		})

		it("does not borrow the curated catalog's tool flag for a model the host reports nothing about", () => {
			// The curated catalog marks every family `supportsToolCalling: true`; that is not a host report.
			expect(getVsCodeLmModelInfo(liveModel({ family: curatedFamily })).supportsToolCalling).toBeUndefined()
		})

		it.each([
			["no capabilities object", undefined],
			["an empty capabilities object", {}],
			["a capabilities object that says nothing about tools", { supportsImageToText: true }],
			["tools reported as something other than a boolean or count", { supportsToolCalling: "yes" }],
			["a non-finite tool count", { toolCalling: Number.NaN }],
		])("leaves tool support unset for %s", (_label, capabilities) => {
			expect(getVsCodeLmModelInfo(liveModel({ capabilities })).supportsToolCalling).toBeUndefined()
		})

		it("keeps tool support independent of vision", () => {
			const info = getVsCodeLmModelInfo(
				liveModel({ capabilities: { supportsImageToText: false, supportsToolCalling: true } }),
			)
			expect(info.supportsImages).toBe(false)
			expect(info.supportsToolCalling).toBe(true)
		})

		it("passes the host report through to the models Copilot lists", async () => {
			vi.mocked(vscode.lm.selectChatModels).mockResolvedValueOnce([
				liveModel({ id: "tools-yes", capabilities: { supportsToolCalling: true } }),
				liveModel({ id: "tools-unreported" }),
			] as never)
			const models = await getGitHubCopilotModels()
			expect(models.find((m) => m.id === "tools-yes")?.modelInfo.supportsToolCalling).toBe(true)
			expect(models.find((m) => m.id === "tools-unreported")?.modelInfo.supportsToolCalling).toBeUndefined()
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

		describe("when the host reports no usable limit for a model the catalog knows", () => {
			const fallback = openAiModelInfoSaneDefaults.contextWindow
			const catalog = Object.entries(vscodeLlmModels)
			const above = catalog.find(([, entry]) => entry.maxInputTokens > fallback)
			const below = catalog.find(([, entry]) => entry.maxInputTokens < fallback)

			it.each([0, Number.NaN, -1])("assumes the fallback, capped by the curated limit, for %s", (reported) => {
				expect(above).toBeDefined()
				const [family, entry] = above!

				const { contextWindow } = getVsCodeLmModelInfo(liveModel({ family, maxInputTokens: reported }))

				expect(contextWindow).toBe(fallback)
				expect(contextWindow).toBeLessThan(entry.maxInputTokens)
			})

			it("keeps a curated limit that is already below the fallback", () => {
				expect(below).toBeDefined()
				const [family, entry] = below!

				expect(getVsCodeLmModelInfo(liveModel({ family, maxInputTokens: 0 })).contextWindow).toBe(
					entry.maxInputTokens,
				)
			})

			it("is the window the handler enforces and condenses against, not a larger curated one", async () => {
				const [family] = above!
				vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([
					liveModel({ family, maxInputTokens: 0 }),
				] as never)
				const handler = new GitHubCopilotHandler({})
				try {
					await handler.initializeClient()
					expect(handler.getCondenseContextWindow()).toBe(fallback)
					expect(handler.getModel().info.contextWindow).toBe(fallback)
				} finally {
					handler.dispose()
				}
			})
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

	describe("createMessage cancellation", () => {
		beforeEach(() => mockLanguageModelChat.countTokens.mockResolvedValue(10))

		/** A stream whose next read stays pending until `release`, as when the host waits on a chunk. */
		const pendingStream = () => {
			let release!: () => void
			const released = new Promise<void>((resolve) => (release = resolve))
			let token: vscode.CancellationToken | undefined
			mockLanguageModelChat.sendRequest.mockImplementation(async (_m, _o, t: vscode.CancellationToken) => {
				token = t
				return {
					stream: (async function* () {
						yield new vscode.LanguageModelTextPart("first")
						await released
						yield new vscode.LanguageModelTextPart("late")
					})(),
				}
			})
			return { release, token: () => token }
		}

		/**
		 * A cancellation source whose `cancel()` fires the token's listeners, like VS Code's,
		 * so a fake host stream can end its pending read the way the real host does.
		 */
		const firingCancellationSource = () => {
			const listeners: Array<() => void> = []
			const token = {
				isCancellationRequested: false,
				onCancellationRequested: vi.fn((listener: () => void) => {
					listeners.push(listener)
					return { dispose: vi.fn() }
				}),
			}
			const source = {
				token,
				cancel: vi.fn(() => {
					if (token.isCancellationRequested) return
					token.isCancellationRequested = true
					for (const listener of listeners) listener()
				}),
				dispose: vi.fn(),
			}
			vi.mocked(vscode.CancellationTokenSource).mockImplementationOnce(function () {
				return source as unknown as vscode.CancellationTokenSource
			})
			return source
		}

		it("ends a stream read that is already pending when the task aborts", async () => {
			const source = firingCancellationSource()
			mockLanguageModelChat.sendRequest.mockImplementation(async (_m, _o, token: vscode.CancellationToken) => ({
				stream: (async function* () {
					yield new vscode.LanguageModelTextPart("first")
					// Like the host: the next chunk never arrives, and only cancellation ends the read.
					await new Promise<never>((_, reject) =>
						token.onCancellationRequested(() => reject(new vscode.CancellationError())),
					)
				})(),
			}))
			const controller = new AbortController()
			const handler = new GitHubCopilotHandler(defaultOptions)
			try {
				const messages = handler.createMessage("system", [{ role: "user", content: "hi" }], {
					taskId: "t",
					abortSignal: controller.signal,
				})
				await messages.next()

				// Request the next chunk first, so the read is in flight when the abort lands.
				const pendingRead = messages.next()
				let settled = false
				void pendingRead.then(
					() => (settled = true),
					() => (settled = true),
				)
				await new Promise((resolve) => setTimeout(resolve, 0))
				expect(settled).toBe(false)
				expect(source.cancel).not.toHaveBeenCalled()

				controller.abort()

				await expect(pendingRead).rejects.toThrow("Request cancelled by user")
				expect(source.cancel).toHaveBeenCalled()
			} finally {
				handler.dispose()
			}
		})

		it("leaves no abort listener behind when pre-request validation fails", async () => {
			// Over the model's input window, so the context-window check throws before sending.
			mockLanguageModelChat.countTokens.mockResolvedValue(mockLanguageModelChat.maxInputTokens + 1)
			const controller = new AbortController()
			const addSpy = vi.spyOn(controller.signal, "addEventListener")
			const removeSpy = vi.spyOn(controller.signal, "removeEventListener")
			const handler = new GitHubCopilotHandler(defaultOptions)
			try {
				await expect(
					collectStream(
						handler.createMessage("system", [{ role: "user", content: "hi" }], {
							taskId: "t",
							abortSignal: controller.signal,
						}),
					),
				).rejects.toThrow("exceeds the selected Copilot model's input context window")
			} finally {
				handler.dispose()
			}

			// Every listener added must have been removed, so none outlives the request.
			expect(removeSpy.mock.calls.map(([, listener]) => listener)).toEqual(
				addSpy.mock.calls.map(([, listener]) => listener),
			)
			expect(mockLanguageModelChat.sendRequest).not.toHaveBeenCalled()
		})

		const requireValue = <T>(value: T | null | undefined): T => {
			if (value == null) throw new Error("Expected a value")
			return value
		}

		it("releases only the failing request's source when a newer request has already started", async () => {
			// Two requests on one handler. The first is held in token counting; the second starts and
			// replaces the handler's current source; then the first fails its pre-send check.
			const handler = new GitHubCopilotHandler(defaultOptions)
			await handler.initializeClient()
			let releaseFirstCount!: () => void
			const firstCountHeld = new Promise<void>((resolve) => (releaseFirstCount = resolve))
			let firstCounting!: () => void
			const firstCountStarted = new Promise<void>((resolve) => (firstCounting = resolve))
			let secondCounting!: () => void
			const secondCountStarted = new Promise<void>((resolve) => (secondCounting = resolve))
			// The first request's counts are held and come back large, so only it fails the check
			// below; any later count belongs to the second request and comes back small.
			const FIRST_REQUEST_TOKENS = 1_000
			let firstToken: unknown
			mockLanguageModelChat.countTokens.mockImplementation(async (_text: unknown, token: unknown) => {
				firstToken ??= token
				if (token === firstToken) {
					firstCounting()
					await firstCountHeld
					return FIRST_REQUEST_TOKENS
				}
				secondCounting()
				return 10
			})
			handler["assertWithinContextWindow"] = (inputTokens: number) => {
				if (inputTokens >= FIRST_REQUEST_TOKENS) {
					throw new Error("first rejected before sending")
				}
			}
			const stream = pendingStream()
			try {
				vi.mocked(vscode.CancellationTokenSource).mockClear()
				const first = collectStream(
					handler.createMessage("system", [{ role: "user", content: "a" }], { taskId: "t" }),
				)
				await firstCountStarted

				const second = handler.createMessage("system", [{ role: "user", content: "b" }], { taskId: "t" })
				const secondFirstChunk = second.next()
				await secondCountStarted
				const sources = vi.mocked(vscode.CancellationTokenSource).mock.results.map((r) => r.value)
				const firstSource = sources.find((source) => source.token === firstToken)
				const secondSource = requireValue(handler["currentRequestCancellation"])
				expect(firstSource).toBeDefined()
				expect(secondSource).not.toBe(firstSource)

				releaseFirstCount()
				await expect(first).rejects.toThrow("first rejected before sending")

				// The first request released its own source and left the newer one running.
				expect(firstSource.dispose).toHaveBeenCalled()
				expect(secondSource.cancel).not.toHaveBeenCalled()
				expect(handler["currentRequestCancellation"]).toBe(secondSource)

				await secondFirstChunk
				expect(stream.token()).toBe(secondSource.token)
				stream.release()
				await second.return(undefined)
			} finally {
				handler.dispose()
			}
		})

		it("releases the request's cancellation source when a request is rejected before sending", async () => {
			// A pre-send check that throws without cleaning up after itself, so only the shared
			// request path can release the source. (Copilot's own context-window check also releases it.)
			const handler = new GitHubCopilotHandler(defaultOptions)
			handler["assertWithinContextWindow"] = () => {
				throw new Error("rejected before sending")
			}
			try {
				await expect(
					collectStream(handler.createMessage("system", [{ role: "user", content: "hi" }], { taskId: "t" })),
				).rejects.toThrow("rejected before sending")

				// The request's source is the one token counting used; it must be released at failure,
				// not left for the next request's or the handler's cleanup.
				const countToken = mockLanguageModelChat.countTokens.mock.calls[0][1]
				const requestSource = vi
					.mocked(vscode.CancellationTokenSource)
					.mock.results.map((r) => r.value)
					.find((source) => source.token === countToken)
				expect(requestSource).toBeDefined()
				expect(requestSource.dispose).toHaveBeenCalled()
				expect(handler["currentRequestCancellation"]).toBeNull()
				expect(mockLanguageModelChat.sendRequest).not.toHaveBeenCalled()
			} finally {
				handler.dispose()
			}
		})

		it("ends a token count that is still pending when the task aborts, and never sends", async () => {
			const source = firingCancellationSource()
			let countStarted!: () => void
			const counting = new Promise<void>((resolve) => (countStarted = resolve))
			// Like the host counter for this request: it never answers, and only cancellation of
			// its token ends it. Counts made with any other token (client setup) answer normally.
			mockLanguageModelChat.countTokens.mockImplementation((_text: unknown, token: unknown) => {
				if (token !== source.token) return Promise.resolve(10)
				return new Promise((_, reject) => {
					countStarted()
					source.token.onCancellationRequested(() => reject(new vscode.CancellationError()))
				})
			})
			const controller = new AbortController()
			const handler = new GitHubCopilotHandler(defaultOptions)
			try {
				const request = collectStream(
					handler.createMessage("system", [{ role: "user", content: "hi" }], {
						taskId: "t",
						abortSignal: controller.signal,
					}),
				)
				await counting
				// The pending count holds the request's own token, so the abort can reach it.
				expect(mockLanguageModelChat.countTokens.mock.calls.some(([, token]) => token === source.token)).toBe(
					true,
				)
				expect(source.cancel).not.toHaveBeenCalled()

				controller.abort()

				await expect(request).rejects.toThrow("Request cancelled by user")
				expect(source.cancel).toHaveBeenCalled()
				expect(mockLanguageModelChat.sendRequest).not.toHaveBeenCalled()
			} finally {
				handler.dispose()
			}
		})

		it("does not send when the task aborts while tokens are being counted", async () => {
			const controller = new AbortController()
			mockLanguageModelChat.countTokens.mockImplementation(async () => {
				controller.abort()
				return 10
			})
			pendingStream()
			const handler = new GitHubCopilotHandler(defaultOptions)
			try {
				await expect(
					collectStream(
						handler.createMessage("system", [{ role: "user", content: "hi" }], {
							taskId: "t",
							abortSignal: controller.signal,
						}),
					),
				).rejects.toThrow("Request cancelled by user")
				const source = vi.mocked(vscode.CancellationTokenSource).mock.results.at(-1)?.value
				expect(source.cancel).toHaveBeenCalled()
				expect(mockLanguageModelChat.sendRequest).not.toHaveBeenCalled()
			} finally {
				handler.dispose()
			}
		})

		it("does not count or send when the task already aborted", async () => {
			pendingStream()
			const source = firingCancellationSource()
			const controller = new AbortController()
			controller.abort()
			const handler = new GitHubCopilotHandler(defaultOptions)
			try {
				await expect(
					collectStream(
						handler.createMessage("system", [{ role: "user", content: "hi" }], {
							taskId: "t",
							abortSignal: controller.signal,
						}),
					),
				).rejects.toThrow("Request cancelled by user")
				expect(source.cancel).toHaveBeenCalled()
				// Any count that did start saw an already-cancelled token.
				for (const [, token] of mockLanguageModelChat.countTokens.mock.calls) {
					expect((token as vscode.CancellationToken).isCancellationRequested).toBe(true)
				}
				expect(mockLanguageModelChat.sendRequest).not.toHaveBeenCalled()
			} finally {
				handler.dispose()
			}
		})

		it("reports an ordinary pre-send failure as itself, not as a cancellation", async () => {
			const handler = new GitHubCopilotHandler(defaultOptions)
			handler["assertWithinContextWindow"] = () => {
				throw new Error("rejected before sending")
			}
			try {
				await expect(
					collectStream(handler.createMessage("system", [{ role: "user", content: "hi" }], { taskId: "t" })),
				).rejects.toThrow("rejected before sending")
			} finally {
				handler.dispose()
			}
		})

		it("removes exactly the abort listener it added when the stream is closed early", async () => {
			const stream = pendingStream()
			const controller = new AbortController()
			const addSpy = vi.spyOn(controller.signal, "addEventListener")
			const removeSpy = vi.spyOn(controller.signal, "removeEventListener")
			const handler = new GitHubCopilotHandler(defaultOptions)
			try {
				const messages = handler.createMessage("system", [{ role: "user", content: "hi" }], {
					taskId: "t",
					abortSignal: controller.signal,
				})
				await messages.next()
				stream.release()
				await messages.return(undefined)
			} finally {
				handler.dispose()
			}

			expect(addSpy).toHaveBeenCalledOnce()
			expect(removeSpy).toHaveBeenCalledOnce()
			expect(removeSpy.mock.calls[0][0]).toBe("abort")
			expect(removeSpy.mock.calls[0][1]).toBe(addSpy.mock.calls[0][1])
		})

		it("removes the abort listener after the stream completes normally", async () => {
			mockLanguageModelChat.sendRequest.mockImplementation(async () => ({
				stream: (async function* () {
					yield new vscode.LanguageModelTextPart("done")
				})(),
			}))
			const controller = new AbortController()
			const addSpy = vi.spyOn(controller.signal, "addEventListener")
			const removeSpy = vi.spyOn(controller.signal, "removeEventListener")
			const handler = new GitHubCopilotHandler(defaultOptions)
			try {
				await collectStream(
					handler.createMessage("system", [{ role: "user", content: "hi" }], {
						taskId: "t",
						abortSignal: controller.signal,
					}),
				)
			} finally {
				handler.dispose()
			}
			expect(removeSpy.mock.calls[0]?.[1]).toBe(addSpy.mock.calls[0][1])
		})
	})

	describe("completePrompt", () => {
		it("sends a justification so the host's consent prompt names Zoo Code", async () => {
			mockLanguageModelChat.sendRequest.mockImplementation(async () => ({
				stream: (async function* () {
					yield new vscode.LanguageModelTextPart("enhanced")
				})(),
			}))
			const handler = new GitHubCopilotHandler(defaultOptions)
			try {
				await expect(handler.completePrompt("improve this")).resolves.toBe("enhanced")
			} finally {
				handler.dispose()
			}

			const requestOptions = mockLanguageModelChat.sendRequest.mock.calls[0][1]
			expect(requestOptions.justification).toContain("Zoo Code")
			expect(requestOptions.justification).toContain(mockLanguageModelChat.name)
		})

		it("disposes each request's cancellation source and the handler's configuration listener", async () => {
			mockLanguageModelChat.sendRequest.mockImplementation(async () => ({
				stream: (async function* () {
					yield new vscode.LanguageModelTextPart("enhanced")
				})(),
			}))

			for (let i = 0; i < 3; i++) {
				const handler = new GitHubCopilotHandler(defaultOptions)
				try {
					await expect(handler.completePrompt("improve this")).resolves.toBe("enhanced")
				} finally {
					handler.dispose()
				}
			}

			const sources = vi.mocked(vscode.CancellationTokenSource).mock.results.map((r) => r.value)
			expect(sources).toHaveLength(3)
			for (const source of sources) expect(source.dispose).toHaveBeenCalledOnce()

			const subscriptions = vi.mocked(vscode.workspace.onDidChangeConfiguration).mock.results.map((r) => r.value)
			expect(subscriptions).toHaveLength(3)
			for (const subscription of subscriptions) expect(subscription.dispose).toHaveBeenCalledOnce()
		})

		it("cancels the in-flight VS Code request when the caller aborts mid-stream", async () => {
			let token: vscode.CancellationToken | undefined
			let streamStarted!: () => void
			const started = new Promise<void>((resolve) => (streamStarted = resolve))
			let release!: () => void
			mockLanguageModelChat.sendRequest.mockImplementation(async (_m, _o, t: vscode.CancellationToken) => {
				token = t
				return {
					stream: (async function* () {
						streamStarted()
						await new Promise<void>((resolve) => (release = resolve))
						yield new vscode.LanguageModelTextPart("late")
					})(),
				}
			})
			const controller = new AbortController()
			const handler = new GitHubCopilotHandler(defaultOptions)
			try {
				const pending = handler.completePrompt("improve this", { abortSignal: controller.signal })
				await started
				const [source] = vi.mocked(vscode.CancellationTokenSource).mock.results.map((r) => r.value)
				expect(token).toBe(source.token)
				expect(source.cancel).not.toHaveBeenCalled()

				controller.abort()
				expect(source.cancel).toHaveBeenCalledOnce()

				release()
				await pending
			} finally {
				handler.dispose()
			}
		})

		it("removes exactly the abort listener it added once the request settles", async () => {
			mockLanguageModelChat.sendRequest.mockImplementation(async () => ({
				stream: (async function* () {
					yield new vscode.LanguageModelTextPart("done")
				})(),
			}))
			const controller = new AbortController()
			const addSpy = vi.spyOn(controller.signal, "addEventListener")
			const removeSpy = vi.spyOn(controller.signal, "removeEventListener")
			const handler = new GitHubCopilotHandler(defaultOptions)
			try {
				await handler.completePrompt("improve this", { abortSignal: controller.signal })
			} finally {
				handler.dispose()
			}

			expect(addSpy).toHaveBeenCalledOnce()
			const [addedType, addedListener] = addSpy.mock.calls[0]
			expect(addedType).toBe("abort")
			expect(removeSpy).toHaveBeenCalledOnce()
			expect(removeSpy.mock.calls[0][0]).toBe("abort")
			expect(removeSpy.mock.calls[0][1]).toBe(addedListener)

			// An abort after completion must no longer reach the disposed source.
			const [source] = vi.mocked(vscode.CancellationTokenSource).mock.results.map((r) => r.value)
			controller.abort()
			expect(source.cancel).not.toHaveBeenCalled()
		})

		it("arms no timer when the timeout is disabled", async () => {
			const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout")
			mockLanguageModelChat.sendRequest.mockImplementation(async () => ({
				stream: (async function* () {
					yield new vscode.LanguageModelTextPart("ok")
				})(),
			}))
			const handler = new GitHubCopilotHandler(defaultOptions)
			try {
				await expect(handler.completePrompt("x", { timeoutMs: 0 })).resolves.toBe("ok")
			} finally {
				handler.dispose()
				setTimeoutSpy.mockRestore()
			}
			expect(setTimeoutSpy).not.toHaveBeenCalled()
		})

		it("rethrows a non-Error failure unchanged", async () => {
			mockLanguageModelChat.sendRequest.mockRejectedValueOnce("plain failure")
			const handler = new GitHubCopilotHandler(defaultOptions)
			try {
				await expect(handler.completePrompt("x")).rejects.toBe("plain failure")
			} finally {
				handler.dispose()
			}
			const [source] = vi.mocked(vscode.CancellationTokenSource).mock.results.map((r) => r.value)
			expect(source.dispose).toHaveBeenCalledOnce()
		})

		it("refuses to send when the caller already aborted", async () => {
			const controller = new AbortController()
			controller.abort()
			vi.mocked(vscode.CancellationTokenSource).mockImplementationOnce(function () {
				const token = { isCancellationRequested: false, onCancellationRequested: vi.fn() }
				return {
					token,
					cancel: vi.fn(() => (token.isCancellationRequested = true)),
					dispose: vi.fn(),
				} as unknown as vscode.CancellationTokenSource
			})
			const handler = new GitHubCopilotHandler(defaultOptions)
			try {
				await expect(handler.completePrompt("x", { abortSignal: controller.signal })).rejects.toThrow(
					"Operation cancelled",
				)
			} finally {
				handler.dispose()
			}
			expect(mockLanguageModelChat.sendRequest).not.toHaveBeenCalled()
		})

		it("cancels the VS Code request once the timeout elapses", async () => {
			vi.useFakeTimers()
			try {
				let release!: () => void
				mockLanguageModelChat.sendRequest.mockImplementation(async () => ({
					stream: (async function* () {
						await new Promise<void>((r) => (release = r))
						yield new vscode.LanguageModelTextPart("late")
					})(),
				}))
				const handler = new GitHubCopilotHandler(defaultOptions)
				const pending = handler.completePrompt("x", { timeoutMs: 1000 })
				await vi.advanceTimersByTimeAsync(0)
				const [source] = vi.mocked(vscode.CancellationTokenSource).mock.results.map((r) => r.value)
				expect(source.cancel).not.toHaveBeenCalled()
				await vi.advanceTimersByTimeAsync(1000)
				expect(source.cancel).toHaveBeenCalledOnce()
				release()
				await pending
				handler.dispose()
			} finally {
				vi.useRealTimers()
			}
		})

		it("disposes the cancellation source when the request fails", async () => {
			mockLanguageModelChat.sendRequest.mockRejectedValueOnce(new Error("boom"))
			const handler = new GitHubCopilotHandler(defaultOptions)
			try {
				await expect(handler.completePrompt("improve this")).rejects.toThrow("boom")
			} finally {
				handler.dispose()
			}

			const [source] = vi.mocked(vscode.CancellationTokenSource).mock.results.map((r) => r.value)
			expect(source.dispose).toHaveBeenCalledOnce()
		})
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

describe("getGitHubCopilotModels", () => {
	const copilotModel = (overrides: Record<string, unknown> = {}) => ({
		...mockLanguageModelChat,
		id: "listed-model",
		vendor: "copilot",
		family: "listed-family",
		...overrides,
	})

	beforeEach(() => vi.clearAllMocks())

	it("describes each model by identity and by the capabilities the host reports", async () => {
		vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([
			copilotModel({ maxInputTokens: 50000, capabilities: { supportsImageToText: true } }),
		] as never)

		const [listed] = await getGitHubCopilotModels()

		expect(listed).toMatchObject({
			id: "listed-model",
			vendor: "copilot",
			family: "listed-family",
			maxInputTokens: 50000,
			modelInfo: { contextWindow: 50000, supportsImages: true },
		})
	})

	it("asks the host only for Copilot's models", async () => {
		vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([])
		await getGitHubCopilotModels()
		expect(vscode.lm.selectChatModels).toHaveBeenCalledWith({ vendor: "copilot" })
	})

	it("omits models that can never work", async () => {
		vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([
			copilotModel({ id: "claude-3.7-sonnet" }),
			copilotModel({ id: "kept" }),
		] as never)

		expect((await getGitHubCopilotModels()).map((model) => model.id)).toEqual(["kept"])
	})

	it("reports a host that has no models as an empty list", async () => {
		vi.mocked(vscode.lm.selectChatModels).mockResolvedValue(undefined as never)
		await expect(getGitHubCopilotModels()).resolves.toEqual([])
	})

	it("surfaces a failed lookup instead of passing it off as 'no models'", async () => {
		vi.mocked(vscode.lm.selectChatModels).mockRejectedValue(new Error("host unavailable"))
		await expect(getGitHubCopilotModels()).rejects.toThrow("host unavailable")
	})
})
