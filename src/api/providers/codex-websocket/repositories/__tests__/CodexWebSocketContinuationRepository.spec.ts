import { CodexWebSocketContinuationRepository } from "../CodexWebSocketContinuationRepository"
import { CodexWebSocketResponseLocalDataSource } from "../../data/local/CodexWebSocketResponseLocalDataSource"

describe("CodexWebSocketContinuationRepository", () => {
	const body = (input: unknown[] = [{ role: "user", content: "private prompt" }]) => ({
		model: "test-model",
		stream: true,
		input,
	})
	let store: CodexWebSocketResponseLocalDataSource
	let repository: CodexWebSocketContinuationRepository

	beforeEach(() => {
		store = new CodexWebSocketResponseLocalDataSource()
		repository = new CodexWebSocketContinuationRepository(store)
	})

	it("only receives dependencies in its constructor", () => {
		const read = vi.spyOn(store, "read")
		const write = vi.spyOn(store, "write")
		const clear = vi.spyOn(store, "clear")
		new CodexWebSocketContinuationRepository(store)
		expect(read).not.toHaveBeenCalled()
		expect(write).not.toHaveBeenCalled()
		expect(clear).not.toHaveBeenCalled()
	})

	it("uses the injected store to continue from a previously recorded response", () => {
		const prepared = repository.prepare(body())
		expect(prepared.fullContextReason).toBe("no cached response")
		repository.record(prepared, { id: "resp_1", output: [] }, [])
		const nextInput = [...body().input, { role: "user", content: "Next" }]
		const nextRepository = new CodexWebSocketContinuationRepository(store)
		expect(nextRepository.prepare(body(nextInput))).toMatchObject({
			previousResponseId: "resp_1",
			offset: 1,
			fullContextReason: undefined,
		})
	})

	it("stores only hashes and replayable reasoning snapshots", () => {
		const reasoning = { type: "reasoning", id: "rs_1", encrypted_content: "private encrypted reasoning" }
		const message = { role: "assistant", content: [{ type: "output_text", text: "private answer" }] }
		const output = [
			{ type: "reasoning", summary: [{ type: "summary_text", text: "private unencrypted reasoning" }] },
			reasoning,
			message,
		]
		repository.record(repository.prepare(body()), { id: "resp_1", output }, [])
		const cached = store.read()
		expect(cached?.input).toHaveLength(3)
		expect(cached?.input.map((item) => item.type)).toEqual(["message", "reasoning", "message"])
		expect(JSON.stringify(cached)).not.toContain("private")
		expect(repository.prepare(body([...body().input, reasoning, message]))).toMatchObject({
			previousResponseId: "resp_1",
			offset: 3,
			fullContextReason: undefined,
		})
	})

	it("uses streamed output when the completed response omits output", () => {
		const output = [{ role: "assistant", content: "Answer" }]
		repository.record(repository.prepare(body()), { id: "resp_1" }, output)
		expect(store.read()?.input).toHaveLength(2)
		expect(repository.prepare(body([...body().input, ...output])).fullContextReason).toBeUndefined()
	})

	it("clears stored continuation when a response has no usable ID", () => {
		const prepared = repository.prepare(body())
		repository.record(prepared, { id: "resp_1", output: [] }, [])
		repository.record(prepared, { output: [] }, [])
		expect(store.read()).toBeUndefined()
		expect(repository.prepare(body()).fullContextReason).toBe("no cached response")
	})

	it("resets continuation by clearing the local store", () => {
		repository.record(repository.prepare(body()), { id: "resp_1", output: [] }, [])
		repository.reset()
		expect(store.read()).toBeUndefined()
		expect(repository.prepare(body()).previousResponseId).toBeUndefined()
	})

	it("requires full context when the reconstructed history is shortened", () => {
		const input = [...body().input, { role: "user", content: "Follow-up" }]
		repository.record(repository.prepare(body(input)), { id: "resp_1", output: [] }, [])
		expect(repository.prepare(body())).toMatchObject({
			previousResponseId: "resp_1",
			fullContextReason: "history shortened",
		})
	})
})
