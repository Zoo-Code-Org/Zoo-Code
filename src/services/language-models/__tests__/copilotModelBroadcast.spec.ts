import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import * as vscode from "vscode"

import { VsCodeLmModelsMessageType, githubCopilotLanguageModel } from "@roo-code/types"

import { registerCopilotModelBroadcast, type CopilotModelBroadcastTarget } from "../copilotModelBroadcast"

vi.mock("vscode", () => ({ lm: { onDidChangeChatModels: vi.fn() } }))
vi.mock("../../../api/providers/vscode-lm", () => ({ getVsCodeLmModels: vi.fn() }))

type Models = Awaited<ReturnType<typeof import("../../../api/providers/vscode-lm").getVsCodeLmModels>>

const model = (id: string) => ({ id, vendor: "copilot", family: id, version: "1", name: id, maxInputTokens: 1 })

function setup(overrides: { targets?: CopilotModelBroadcastTarget[]; fetchModels?: ReturnType<typeof vi.fn> } = {}) {
	let notify: () => void = () => {}
	const subscription = { dispose: vi.fn() }
	const target = { postMessageToWebview: vi.fn().mockResolvedValue(undefined) }
	const targets = overrides.targets ?? [target]
	const fetchModels = overrides.fetchModels ?? vi.fn().mockResolvedValue([model("a")] as Models)
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
	})
	return { notify: () => notify(), registration, subscription, target, targets, fetchModels, log }
}

describe("registerCopilotModelBroadcast", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it("looks models up once for the Copilot vendor and posts them to every view", async () => {
		const second = { postMessageToWebview: vi.fn().mockResolvedValue(undefined) }
		const first = { postMessageToWebview: vi.fn().mockResolvedValue(undefined) }
		const { notify, fetchModels } = setup({ targets: [first, second] })

		notify()
		await vi.advanceTimersByTimeAsync(100)

		expect(fetchModels).toHaveBeenCalledTimes(1)
		expect(fetchModels).toHaveBeenCalledWith(githubCopilotLanguageModel.selector)
		for (const view of [first, second]) {
			expect(view.postMessageToWebview).toHaveBeenCalledWith({
				type: VsCodeLmModelsMessageType.githubCopilotModels,
				vsCodeLmModels: [model("a")],
			})
		}
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
		const late = { postMessageToWebview: vi.fn().mockResolvedValue(undefined) }
		targets.push(late)

		notify()
		await vi.advanceTimersByTimeAsync(100)

		expect(late.postMessageToWebview).toHaveBeenCalledTimes(1)
	})

	it("logs a failed lookup and posts nothing, so views keep their last known list", async () => {
		const { notify, target, log } = setup({ fetchModels: vi.fn().mockRejectedValue(new Error("host busy")) })

		notify()
		await vi.advanceTimersByTimeAsync(100)

		expect(target.postMessageToWebview).not.toHaveBeenCalled()
		expect(log).toHaveBeenCalledTimes(1)
		expect(log).toHaveBeenCalledWith("Failed to refresh GitHub Copilot models: host busy")
	})

	it("posts an empty list when the host genuinely reports no models", async () => {
		const { notify, target } = setup({ fetchModels: vi.fn().mockResolvedValue([]) })

		notify()
		await vi.advanceTimersByTimeAsync(100)

		expect(target.postMessageToWebview).toHaveBeenCalledWith({
			type: VsCodeLmModelsMessageType.githubCopilotModels,
			vsCodeLmModels: [],
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

	it("logs a failure that is not an Error as text", async () => {
		const { notify, log } = setup({ fetchModels: vi.fn().mockRejectedValue("plain failure") })

		notify()
		await vi.advanceTimersByTimeAsync(100)

		expect(log).toHaveBeenCalledWith("Failed to refresh GitHub Copilot models: plain failure")
	})

	describe("default host wiring", () => {
		const hostEvent = vi.mocked(vscode.lm.onDidChangeChatModels)

		it("listens to the host's model-change event and releases it on dispose", () => {
			const hostSubscription = { dispose: vi.fn() }
			hostEvent.mockReturnValue(hostSubscription as never)

			const registration = registerCopilotModelBroadcast({ getTargets: () => [], log: vi.fn() })
			expect(hostEvent).toHaveBeenCalledWith(expect.any(Function))

			registration.dispose()
			expect(hostSubscription.dispose).toHaveBeenCalledTimes(1)
		})

		it("refreshes when the host raises the event", async () => {
			let raise: () => void = () => {}
			hostEvent.mockImplementation(((listener: () => void) => {
				raise = listener
				return { dispose: vi.fn() }
			}) as never)
			const fetchModels = vi.fn().mockResolvedValue([])

			registerCopilotModelBroadcast({
				getTargets: () => [],
				log: vi.fn(),
				fetchModels: fetchModels as never,
				debounceMs: 10,
			})
			raise()
			await vi.advanceTimersByTimeAsync(10)

			expect(fetchModels).toHaveBeenCalledTimes(1)
		})

		it("tolerates a host that does not expose the event", () => {
			hostEvent.mockReturnValue(undefined as never)
			const registration = registerCopilotModelBroadcast({ getTargets: () => [], log: vi.fn() })
			expect(() => registration.dispose()).not.toThrow()
		})
	})
})
