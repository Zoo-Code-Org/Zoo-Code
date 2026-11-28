// Property tests from docs/architecture/tla/LmStudioLoad.tla. Each test runs one invariant on the real code.
import axios from "axios"

import { forceFullModelDetailsLoad, getLMStudioModels, hasLoadedFullDetails } from "../lmstudio"
import type { ApiHandler } from "../../../index"

import nativeFixture from "./fixtures/lmstudio-model-details.json"

const mockFlushModels = vi.hoisted(() => vi.fn())
vi.mock("../modelCache", async (importOriginal) => ({
	...(await importOriginal<typeof import("../modelCache")>()),
	flushModels: mockFlushModels,
}))

const get = vi.spyOn(axios, "get")
const post = vi.spyOn(axios, "post")
// forceFullModelDetailsLoad passes the handler only to flushModels, which is mocked.
const handler = {} as ApiHandler

const baseUrl = "http://localhost:1234"
const modelKey = nativeFixture.models[0].key
const catalog = (loaded: boolean) => ({
	data: {
		models: [
			{
				...nativeFixture.models[0],
				loaded_instances: loaded ? [{ id: modelKey, config: { context_length: 1024 } }] : [],
			},
		],
	},
})

type Deferred = { promise: Promise<unknown>; resolve: (value: unknown) => void; reject: (error: Error) => void }
const deferred = (): Deferred => {
	const d = {} as Deferred
	d.promise = new Promise((resolve, reject) => Object.assign(d, { resolve, reject }))
	return d
}

beforeEach(async () => {
	get.mockResolvedValue({ data: { models: [] } })
	await getLMStudioModels(baseUrl)
	get.mockReset()
	post.mockReset()
	mockFlushModels.mockReset()
	vi.spyOn(console, "error").mockImplementation(() => {})
	vi.spyOn(console, "warn").mockImplementation(() => {})
	vi.spyOn(console, "info").mockImplementation(() => {})
})

// FreshWins: the settled refresh with the highest ticket decides the cache, in every settle order.
describe("refresh settle order", () => {
	it.each([
		{ older: "ok", newer: "ok", first: "newer" },
		{ older: "ok", newer: "ok", first: "older" },
		{ older: "fail", newer: "ok", first: "newer" },
		{ older: "fail", newer: "ok", first: "older" },
		{ older: "ok", newer: "fail", first: "newer" },
		{ older: "ok", newer: "fail", first: "older" },
		{ older: "fail", newer: "fail", first: "newer" },
		{ older: "fail", newer: "fail", first: "older" },
	])("the newer refresh wins: $older/$newer, $first settles first", async ({ older, newer, first }) => {
		const flights = { older: deferred(), newer: deferred() }
		get.mockReturnValueOnce(flights.older.promise as never).mockReturnValueOnce(flights.newer.promise as never)
		const olderRun = getLMStudioModels(baseUrl)
		const newerRun = getLMStudioModels(baseUrl)
		const settle = (which: "older" | "newer", result: string) =>
			result === "ok"
				? // Only the newer response shows a loaded model, so a stale overwrite is visible.
					flights[which].resolve(catalog(which === "newer"))
				: flights[which].reject(new Error("HTTP 500"))
		const order = first === "newer" ? (["newer", "older"] as const) : (["older", "newer"] as const)
		for (const which of order) {
			settle(which, which === "older" ? older : newer)
			await { older: olderRun, newer: newerRun }[which]
		}
		expect(hasLoadedFullDetails(modelKey, baseUrl)).toBe(newer === "ok")
	})
})

// NoLeak, NoAbortWithWaiter, OneLive: callers share one operation. The last caller to leave aborts it.
describe("shared load operation", () => {
	it.each([
		{ cancel: [], aborted: false },
		{ cancel: [0], aborted: false },
		{ cancel: [1], aborted: false },
		{ cancel: [0, 1], aborted: true },
	])("cancel callers $cancel: aborted=$aborted", async ({ cancel, aborted }) => {
		const flight = deferred()
		let requestSignal: AbortSignal | undefined
		get.mockImplementation((_url, config) => {
			requestSignal = config?.signal as AbortSignal | undefined
			return flight.promise as never
		})
		const controllers = [new AbortController(), new AbortController()]
		const runs = controllers.map((c) => forceFullModelDetailsLoad(baseUrl, modelKey, handler, c.signal))
		await vi.waitFor(() => expect(requestSignal).toBeDefined())
		for (const i of cancel) controllers[i].abort()
		await Promise.all(cancel.map((i) => runs[i]))

		expect(get).toHaveBeenCalledOnce()
		expect(requestSignal?.aborted).toBe(aborted)
		flight.reject(new Error("done"))
		await Promise.all(runs)
	})

	it("starts a new operation after the last caller leaves", async () => {
		const flight = deferred()
		get.mockReturnValueOnce(flight.promise as never)
		const controller = new AbortController()
		const first = forceFullModelDetailsLoad(baseUrl, modelKey, handler, controller.signal)
		await vi.waitFor(() => expect(get).toHaveBeenCalledOnce())
		controller.abort()
		await first

		get.mockResolvedValueOnce(catalog(true))
		await forceFullModelDetailsLoad(baseUrl, modelKey, handler)
		expect(get).toHaveBeenCalledTimes(2)
		flight.reject(new Error("done"))
	})
})

// NoOrphanCommit: the flush refresh stops when no caller waits. Another caller keeps it running.
describe("flush refresh", () => {
	it.each([
		{ cancel: [0, 1], aborted: true },
		{ cancel: [0], aborted: false },
	])("cancel callers $cancel: flush aborted=$aborted", async ({ cancel, aborted }) => {
		get.mockResolvedValue(catalog(true))
		const flush = deferred()
		mockFlushModels.mockReturnValue(flush.promise)
		const controllers = [new AbortController(), new AbortController()]
		const runs = controllers.map((c) => forceFullModelDetailsLoad(baseUrl, modelKey, handler, c.signal))
		await vi.waitFor(() => expect(mockFlushModels).toHaveBeenCalledOnce())
		for (const i of cancel) controllers[i].abort()
		await Promise.all(cancel.map((i) => runs[i]))

		expect(mockFlushModels.mock.calls[0][0].signal?.aborted ?? false).toBe(aborted)
		flush.resolve(undefined)
		await Promise.all(runs)
	})
})
