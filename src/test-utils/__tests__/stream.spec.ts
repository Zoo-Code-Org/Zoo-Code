import { asyncStreamFrom, collectStream } from "../stream"

describe("stream test utils", () => {
	it("collects chunks in order", async () => {
		await expect(collectStream(asyncStreamFrom([1, 2, 3]))).resolves.toEqual([1, 2, 3])
	})

	it("collects empty streams", async () => {
		await expect(collectStream(asyncStreamFrom([]))).resolves.toEqual([])
	})

	it("propagates stream errors", async () => {
		async function* failingStream() {
			yield 1
			throw new Error("boom")
		}

		await expect(collectStream(failingStream())).rejects.toThrow("boom")
	})
})
