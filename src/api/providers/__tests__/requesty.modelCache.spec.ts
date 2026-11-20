// npx vitest run api/providers/__tests__/requesty.modelCache.spec.ts

// The real model cache runs in this file. requesty.spec.ts replaces getModels() with a double,
// which re-implements the single-flight that this abort behaviour depends on, so a regression in
// dedupedFetch()/joinFlight() could not fail there. Here only the cache's storage edges, the SDK
// client and the handler's catalog fetch are stubbed: the join, the per-waiter abort views and the
// last-waiter release are the code under test.

vitest.mock("fs", () => ({
	existsSync: vitest.fn().mockReturnValue(false),
	readFileSync: vitest.fn().mockReturnValue("{}"),
}))

vitest.mock("fs/promises", () => ({
	writeFile: vitest.fn().mockResolvedValue(undefined),
	readFile: vitest.fn().mockResolvedValue("{}"),
	mkdir: vitest.fn().mockResolvedValue(undefined),
}))

vitest.mock("../../../core/config/ContextProxy", () => ({
	ContextProxy: {
		instance: {
			globalStorageUri: {
				fsPath: "/mock/storage/path",
			},
		},
	},
}))

vitest.mock("../utils/timeout-config", () => ({
	getApiRequestTimeout: vitest.fn().mockReturnValue(300_000),
}))

const mockCreate = vitest.fn()

vitest.mock("openai", () => ({
	default: vitest.fn().mockImplementation(function () {
		return {
			chat: {
				completions: {
					create: mockCreate,
				},
			},
		}
	}),
}))

vitest.mock("delay", () => ({
	default: vitest.fn(function () {
		return Promise.resolve()
	}),
}))

import type { ModelRecord } from "@roo-code/types"

import { RequestyHandler } from "../requesty"
import { makeApiHandlerOptions, makeCreateMessageMetadata } from "../../../test-utils/api"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"
import { withSettleGuard } from "../../../test-utils/settle-guard"
import { flushMacrotasks } from "../../../test-utils/timers"

const CATALOG: ModelRecord = {
	"coding/claude-4-sonnet": {
		maxTokens: 8192,
		contextWindow: 200000,
		supportsImages: true,
		supportsPromptCache: true,
		inputPrice: 3,
		outputPrice: 15,
		cacheWritesPrice: 3.75,
		cacheReadsPrice: 0.3,
		description: "Claude 4 Sonnet",
	},
}

describe("RequestyHandler model lookup through the real model cache", () => {
	it("lets one waiter abort without cancelling the catalog fetch the other is waiting on", async () => {
		const handler = new RequestyHandler(
			makeApiHandlerOptions({
				requestyApiKey: "isolation-key",
				requestyModelId: "coding/claude-4-sonnet",
			}),
		)

		// The provider fetch boundary is the only stub. It mirrors an HTTP client: it rejects when the
		// signal it was handed fires, so a flight that cancelled its own fetch would fail the waiter
		// that was still waiting for it.
		let resolveCatalog!: (models: ModelRecord) => void
		let notifyFetch!: () => void
		const fetchStarted = new Promise<void>((resolve) => {
			notifyFetch = resolve
		})
		const fetchModelsSpy = vitest.spyOn(handler, "fetchModels").mockImplementation((_options, signal) => {
			notifyFetch()
			return new Promise<ModelRecord>((resolve, reject) => {
				signal?.addEventListener("abort", () => reject(new Error("canceled")), { once: true })
				resolveCatalog = resolve
			})
		})

		try {
			const controllerA = new AbortController()
			const controllerB = new AbortController()
			const pA = collectStream(
				handler.createMessage(
					"sys",
					[{ role: "user", content: "a" }],
					makeCreateMessageMetadata({ abortSignal: controllerA.signal }),
				),
			)
			void pA.catch(() => {})

			// A owns the flight: its provider fetch has started.
			await withSettleGuard(fetchStarted)

			const pB = collectStream(
				handler.createMessage(
					"sys",
					[{ role: "user", content: "b" }],
					makeCreateMessageMetadata({ abortSignal: controllerB.signal }),
				),
			)
			void pB.catch(() => {})
			await flushMacrotasks()

			// B joined the flight A started rather than opening its own: still one provider fetch.
			expect(fetchModelsSpy).toHaveBeenCalledTimes(1)

			// The fetch is bound to the flight's own signal, never to either caller's.
			const flightSignal = fetchModelsSpy.mock.calls[0]?.[1]
			expect(flightSignal).toBeInstanceOf(AbortSignal)
			expect(flightSignal).not.toBe(controllerA.signal)
			expect(flightSignal).not.toBe(controllerB.signal)

			controllerA.abort()
			await expect(pA).rejects.toMatchObject({
				name: "AbortError",
				message: "The Requesty request was aborted",
			})

			// A detached only its own wait: the shared fetch is still running for B.
			expect(flightSignal?.aborted).toBe(false)

			mockCreate.mockResolvedValue(
				asyncStreamFrom([
					{
						id: "coding/claude-4-sonnet",
						choices: [{ delta: { content: "b-response" } }],
					},
					{
						id: "test-id",
						choices: [{ delta: {} }],
						usage: {
							prompt_tokens: 1,
							completion_tokens: 1,
							total_tokens: 2,
						},
					},
				]),
			)
			resolveCatalog(CATALOG)

			const chunksB = await withSettleGuard(pB)
			expect(chunksB).toContainEqual({ type: "text", text: "b-response" })
			expect(fetchModelsSpy).toHaveBeenCalledTimes(1)
		} finally {
			fetchModelsSpy.mockRestore()
		}
	})
})
