// npx vitest run src/api/providers/__tests__/stream-cleanup.spec.ts

import { withFinallyCleanup } from "../stream-cleanup"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"

describe("withFinallyCleanup", () => {
	it("forwards every chunk and runs the cleanup after the stream completes", async () => {
		const cleanup = vitest.fn()

		const chunks = await collectStream(withFinallyCleanup(asyncStreamFrom(["a", "b", "c"]), cleanup))

		expect(chunks).toEqual(["a", "b", "c"])
		expect(cleanup).toHaveBeenCalledTimes(1)
	})

	it("runs the cleanup when the consumer stops early", async () => {
		const cleanup = vitest.fn()
		const stream = withFinallyCleanup(asyncStreamFrom(["a", "b", "c"]), cleanup)
		const iterator = stream[Symbol.asyncIterator]()

		expect((await iterator.next()).value).toBe("a")
		await iterator.return(undefined)

		expect(cleanup).toHaveBeenCalledTimes(1)
	})

	it("runs the cleanup when the underlying stream fails", async () => {
		const cleanup = vitest.fn()
		async function* failing() {
			yield "a"
			throw new Error("boom")
		}

		await expect(collectStream(withFinallyCleanup(failing(), cleanup))).rejects.toThrow("boom")
		expect(cleanup).toHaveBeenCalledTimes(1)
	})

	it("runs the cleanup at most once when the consumer stops after a failure", async () => {
		const cleanup = vitest.fn()
		async function* failing() {
			yield* []
			throw new Error("boom")
		}
		const stream = withFinallyCleanup(failing(), cleanup)
		const iterator = stream[Symbol.asyncIterator]()

		await expect(iterator.next()).rejects.toThrow("boom")
		await iterator.return(undefined)

		expect(cleanup).toHaveBeenCalledTimes(1)
	})
})
