import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import * as vscode from "vscode"

import { VsCodeLmModelsMessageType } from "@roo-code/types"

import { registerCopilotModelBroadcast, type CopilotModelBroadcastTarget } from "../copilotModelBroadcast"
import { getGitHubCopilotViewState } from "../copilotViewState"

vi.mock("vscode", () => ({
	lm: { onDidChangeChatModels: vi.fn() },
	authentication: { onDidChangeSessions: vi.fn() },
}))
vi.mock("../../../api/providers/github-copilot", () => ({
	getGitHubCopilotModels: vi.fn(),
	getGitHubCopilotAccount: vi.fn(),
}))

type Models = Awaited<ReturnType<typeof import("../../../api/providers/github-copilot").getGitHubCopilotModels>>

const model = (id: string) => ({ id, vendor: "copilot", family: id, version: "1", name: id, maxInputTokens: 1 })
const newTarget = () => ({ postMessageToWebview: vi.fn().mockResolvedValue(undefined) })

function setup(
	overrides: {
		targets?: CopilotModelBroadcastTarget[]
		fetchModels?: ReturnType<typeof vi.fn>
		fetchAccount?: ReturnType<typeof vi.fn>
	} = {},
) {
	let notify: () => void = () => {}
	const subscription = { dispose: vi.fn() }
	const target = newTarget()
	const targets = overrides.targets ?? [target]
	const fetchModels = overrides.fetchModels ?? vi.fn().mockResolvedValue([model("a")] as Models)
	const fetchAccount = overrides.fetchAccount ?? vi.fn().mockResolvedValue("octocat")
	const log = vi.fn()
	const registration = registerCopilotModelBroadcast({
		getTargets: () => targets,
		log,
		debounceMs: 100,
		subscribe: (listener) => {
			notify = listener
			return subscription as never
		},
		fetchModels: fetchModels as never,
		fetchAccount: fetchAccount as never,
	})
	return { notify: () => notify(), registration, subscription, target, targets, fetchModels, fetchAccount, log }
}

describe("registerCopilotModelBroadcast", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it("looks models and the account up once and posts both to every view", async () => {
		const first = newTarget()
		const second = newTarget()
		const { notify, fetchModels, fetchAccount } = setup({ targets: [first, second] })

		notify()
		await vi.advanceTimersByTimeAsync(100)

		expect(fetchModels).toHaveBeenCalledTimes(1)
		expect(fetchAccount).toHaveBeenCalledTimes(1)
		for (const view of [first, second]) {
			expect(view.postMessageToWebview).toHaveBeenCalledWith({
				type: VsCodeLmModelsMessageType.githubCopilotModels,
				vsCodeLmModels: [model("a")],
				githubCopilotAccount: "octocat",
			})
		}
	})

	it("reports no account as null, so a sign-out done in VS Code clears the label rather than leaving it", async () => {
		const { notify, target } = setup({ fetchAccount: vi.fn().mockResolvedValue(undefined) })

		notify()
		await vi.advanceTimersByTimeAsync(100)

		expect(target.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ githubCopilotAccount: null }),
		)
	})

	it("collapses a burst of change events into one refresh", async () => {
		const { notify, fetchModels } = setup()

		notify()
		notify()
		await vi.advanceTimersByTimeAsync(50)
		notify()
		await vi.advanceTimersByTimeAsync(100)

		expect(fetchModels).toHaveBeenCalledTimes(1)
	})

	it("does nothing before the debounce interval has elapsed", async () => {
		const { notify, fetchModels } = setup()

		notify()
		await vi.advanceTimersByTimeAsync(99)

		expect(fetchModels).not.toHaveBeenCalled()
	})

	it("includes views that open after registration", async () => {
		const targets: CopilotModelBroadcastTarget[] = []
		const { notify } = setup({ targets })
		const late = newTarget()
		targets.push(late)

		notify()
		await vi.advanceTimersByTimeAsync(100)

		expect(late.postMessageToWebview).toHaveBeenCalledTimes(1)
	})

	it("logs a failed lookup and posts nothing, so views keep their last known state", async () => {
		const { notify, target, log } = setup({ fetchModels: vi.fn().mockRejectedValue(new Error("host busy")) })

		notify()
		await vi.advanceTimersByTimeAsync(100)

		expect(target.postMessageToWebview).not.toHaveBeenCalled()
		expect(log).toHaveBeenCalledExactlyOnceWith("Failed to refresh GitHub Copilot state: host busy")
	})

	it("does not report a failed account lookup as a sign-out", async () => {
		const { notify, target, log } = setup({ fetchAccount: vi.fn().mockRejectedValue(new Error("auth down")) })

		notify()
		await vi.advanceTimersByTimeAsync(100)

		expect(target.postMessageToWebview).not.toHaveBeenCalled()
		expect(log).toHaveBeenCalledWith("Failed to refresh GitHub Copilot state: auth down")
	})

	describe("a view that cannot be reached", () => {
		// The refresh runs from a timer, so a rejection that escaped it would be unhandled.
		const unhandled = vi.fn()
		beforeEach(() => {
			unhandled.mockClear()
			process.on("unhandledRejection", unhandled)
		})
		afterEach(() => void process.off("unhandledRejection", unhandled))

		it("is logged and never escapes the refresh", async () => {
			const broken = { postMessageToWebview: vi.fn().mockRejectedValue(new Error("webview disposed")) }
			const { notify, log } = setup({ targets: [broken] })

			notify()
			await vi.advanceTimersByTimeAsync(100)

			expect(broken.postMessageToWebview).toHaveBeenCalledTimes(1)
			expect(log).toHaveBeenCalledExactlyOnceWith("Failed to refresh GitHub Copilot state: webview disposed")
			expect(unhandled).not.toHaveBeenCalled()
		})

		it("does not stop the other views from receiving the update", async () => {
			const broken = { postMessageToWebview: vi.fn().mockRejectedValue(new Error("webview disposed")) }
			const healthy = newTarget()
			const { notify } = setup({ targets: [broken, healthy] })

			notify()
			await vi.advanceTimersByTimeAsync(100)

			expect(healthy.postMessageToWebview).toHaveBeenCalledWith(
				expect.objectContaining({
					type: VsCodeLmModelsMessageType.githubCopilotModels,
					githubCopilotAccount: "octocat",
				}),
			)
			expect(unhandled).not.toHaveBeenCalled()
		})

		it("is retried on the next change, since one failed delivery does not disable later refreshes", async () => {
			const flaky = {
				postMessageToWebview: vi
					.fn()
					.mockRejectedValueOnce(new Error("not ready"))
					.mockResolvedValue(undefined),
			}
			const { notify } = setup({ targets: [flaky] })

			notify()
			await vi.advanceTimersByTimeAsync(100)
			notify()
			await vi.advanceTimersByTimeAsync(100)

			expect(flaky.postMessageToWebview).toHaveBeenCalledTimes(2)
		})
	})

	it("logs a failure that is not an Error as text", async () => {
		const { notify, log } = setup({ fetchModels: vi.fn().mockRejectedValue("plain failure") })

		notify()
		await vi.advanceTimersByTimeAsync(100)

		expect(log).toHaveBeenCalledWith("Failed to refresh GitHub Copilot state: plain failure")
	})

	it("posts an empty list when the host genuinely reports no models", async () => {
		const { notify, target } = setup({ fetchModels: vi.fn().mockResolvedValue([]) })

		notify()
		await vi.advanceTimersByTimeAsync(100)

		expect(target.postMessageToWebview).toHaveBeenCalledWith({
			type: VsCodeLmModelsMessageType.githubCopilotModels,
			vsCodeLmModels: [],
			githubCopilotAccount: "octocat",
		})
	})

	it("discards a lookup that a newer change has superseded", async () => {
		let resolveFirst: (models: Models) => void = () => {}
		const fetchModels = vi
			.fn()
			.mockImplementationOnce(() => new Promise<Models>((resolve) => (resolveFirst = resolve)))
			.mockResolvedValueOnce([model("fresh")] as Models)
		const { notify, target } = setup({ fetchModels })

		notify()
		await vi.advanceTimersByTimeAsync(100)
		notify()
		await vi.advanceTimersByTimeAsync(100)
		resolveFirst([model("stale")] as Models)
		await vi.advanceTimersByTimeAsync(0)

		expect(target.postMessageToWebview).toHaveBeenCalledTimes(1)
		expect(target.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ vsCodeLmModels: [model("fresh")] }),
		)
	})

	describe("a view that signs in while a lookup runs", () => {
		it("is skipped, because its own sign-in result is newer than the lookup", async () => {
			let finishModels: (models: Models) => void = () => {}
			const fetchModels = vi
				.fn()
				.mockImplementation(() => new Promise<Models>((resolve) => (finishModels = resolve)))
			const signingIn = newTarget()
			const bystander = newTarget()
			const { notify } = setup({ targets: [signingIn, bystander], fetchModels })

			notify()
			await vi.advanceTimersByTimeAsync(100)
			getGitHubCopilotViewState(signingIn).changes++
			finishModels([model("a")] as Models)
			await vi.advanceTimersByTimeAsync(0)

			expect(signingIn.postMessageToWebview).not.toHaveBeenCalled()
			expect(bystander.postMessageToWebview).toHaveBeenCalledTimes(1)
		})

		it("is skipped when a manual refresh of that view started after the lookup began", async () => {
			let finishModels: (models: Models) => void = () => {}
			const fetchModels = vi
				.fn()
				.mockImplementation(() => new Promise<Models>((resolve) => (finishModels = resolve)))
			const refreshed = newTarget()
			const bystander = newTarget()
			const { notify } = setup({ targets: [refreshed, bystander], fetchModels })

			notify()
			await vi.advanceTimersByTimeAsync(100)
			// The manual refresh path claims the view's next refresh, as the message handler does.
			getGitHubCopilotViewState(refreshed).refreshId++
			finishModels([model("a")] as Models)
			await vi.advanceTimersByTimeAsync(0)

			expect(refreshed.postMessageToWebview).not.toHaveBeenCalled()
			expect(bystander.postMessageToWebview).toHaveBeenCalledWith(
				expect.objectContaining({ vsCodeLmModels: [model("a")] }),
			)
		})

		it("leaves the view's refresh claim untouched when its lookup fails", async () => {
			const view = newTarget()
			const before = getGitHubCopilotViewState(view).refreshId
			const { notify } = setup({ targets: [view], fetchModels: vi.fn().mockRejectedValue(new Error("busy")) })

			notify()
			await vi.advanceTimersByTimeAsync(100)

			expect(getGitHubCopilotViewState(view).refreshId).toBe(before)
			expect(view.postMessageToWebview).not.toHaveBeenCalled()
		})

		it("is served normally when the sign-in finished before the lookup began", async () => {
			const view = newTarget()
			getGitHubCopilotViewState(view).changes += 3
			const { notify } = setup({ targets: [view] })

			notify()
			await vi.advanceTimersByTimeAsync(100)

			expect(view.postMessageToWebview).toHaveBeenCalledTimes(1)
		})
	})

	it("stops listening and cancels a pending refresh when disposed", async () => {
		const { notify, registration, subscription, fetchModels } = setup()

		notify()
		registration.dispose()
		await vi.advanceTimersByTimeAsync(500)

		expect(subscription.dispose).toHaveBeenCalledTimes(1)
		expect(fetchModels).not.toHaveBeenCalled()
	})

	it("does not post a lookup that finishes after disposal", async () => {
		let resolve: (models: Models) => void = () => {}
		const fetchModels = vi.fn().mockImplementation(() => new Promise<Models>((r) => (resolve = r)))
		const { notify, registration, target } = setup({ fetchModels })

		notify()
		await vi.advanceTimersByTimeAsync(100)
		registration.dispose()
		resolve([model("a")] as Models)
		await vi.advanceTimersByTimeAsync(0)

		expect(target.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("tolerates a host that has no model-change event", () => {
		const registration = registerCopilotModelBroadcast({
			getTargets: () => [],
			log: vi.fn(),
			subscribe: () => undefined,
		})
		expect(() => registration.dispose()).not.toThrow()
	})

	describe("default host wiring", () => {
		const modelEvent = vi.mocked(vscode.lm.onDidChangeChatModels)
		const sessionEvent = vi.mocked(vscode.authentication.onDidChangeSessions)
		const raise = {
			models: () => {},
			sessions: (_providerId: string) => {},
		}

		beforeEach(() => {
			modelEvent.mockReset()
			sessionEvent.mockReset()
			modelEvent.mockImplementation(((listener: () => void) => {
				raise.models = listener
				return { dispose: vi.fn() }
			}) as never)
			sessionEvent.mockImplementation(((listener: (event: { provider: { id: string } }) => void) => {
				raise.sessions = (id) => listener({ provider: { id } })
				return { dispose: vi.fn() }
			}) as never)
		})

		const register = () => {
			const fetchModels = vi.fn().mockResolvedValue([])
			const registration = registerCopilotModelBroadcast({
				getTargets: () => [],
				log: vi.fn(),
				debounceMs: 10,
				fetchModels: fetchModels as never,
				fetchAccount: vi.fn().mockResolvedValue("octocat") as never,
			})
			return { fetchModels, registration }
		}

		it("refreshes when the host changes its models", async () => {
			const { fetchModels } = register()
			raise.models()
			await vi.advanceTimersByTimeAsync(10)
			expect(fetchModels).toHaveBeenCalledTimes(1)
		})

		it("refreshes when GitHub's sessions change, such as after signing out in VS Code", async () => {
			const { fetchModels } = register()
			raise.sessions("github")
			await vi.advanceTimersByTimeAsync(10)
			expect(fetchModels).toHaveBeenCalledTimes(1)
		})

		it("ignores session changes of other authentication providers", async () => {
			const { fetchModels } = register()
			raise.sessions("microsoft")
			await vi.advanceTimersByTimeAsync(50)
			expect(fetchModels).not.toHaveBeenCalled()
		})

		it("releases both host subscriptions on dispose", () => {
			const modelSubscription = { dispose: vi.fn() }
			const sessionSubscription = { dispose: vi.fn() }
			modelEvent.mockReturnValue(modelSubscription as never)
			sessionEvent.mockReturnValue(sessionSubscription as never)

			register().registration.dispose()

			expect(modelSubscription.dispose).toHaveBeenCalledTimes(1)
			expect(sessionSubscription.dispose).toHaveBeenCalledTimes(1)
		})

		it("tolerates a host that exposes neither event", () => {
			modelEvent.mockReturnValue(undefined as never)
			sessionEvent.mockReturnValue(undefined as never)
			expect(() => register().registration.dispose()).not.toThrow()
		})
	})
})
