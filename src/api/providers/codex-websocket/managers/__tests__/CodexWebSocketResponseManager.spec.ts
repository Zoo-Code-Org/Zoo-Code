import { CodexWebSocketResponseManager } from "../CodexWebSocketResponseManager"
import { CodexWebSocketResponseLocalDataSource } from "../../data/local/CodexWebSocketResponseLocalDataSource"
import { CodexWebSocketContinuationRepository } from "../../repositories/CodexWebSocketContinuationRepository"
import { CodexWebSocketResponseStateHolder } from "../../state-holders/CodexWebSocketResponseStateHolder"
import type { CodexResponseEvent } from "../../models/protocol"

describe("CodexWebSocketResponseManager state transitions", () => {
	const body = { model: "test-model", input: [{ role: "user", content: "Hello" }] }
	const cacheMiss: CodexResponseEvent = { type: "error", error: { code: "previous_response_not_found" } }
	let repository: CodexWebSocketContinuationRepository
	let manager: CodexWebSocketResponseManager

	beforeEach(() => {
		repository = new CodexWebSocketContinuationRepository(new CodexWebSocketResponseLocalDataSource())
		manager = new CodexWebSocketResponseManager(repository, new CodexWebSocketResponseStateHolder())
	})

	it("requires explicit initialization and rejects repeated initialization", () => {
		const prepare = vi.spyOn(repository, "prepare")
		expect(prepare).not.toHaveBeenCalled()
		expect(() => manager.preparedRequest).toThrow("not initialized")
		expect(() => manager.accept({ type: "response.created" })).toThrow("not initialized")
		manager.init(body)
		expect(prepare).toHaveBeenCalledOnce()
		expect(manager.completed).toBe(false)
		expect(() => manager.init(body)).toThrow("already initialized")
	})

	it.each(["response.completed", "response.done"])("records streamed items in order on %s", (type: string) => {
		manager.init(body)
		const prepared = manager.preparedRequest
		const record = vi.spyOn(repository, "record")
		const first = { role: "assistant", content: "First" }
		const second = { role: "assistant", content: "Second" }
		manager.accept({ type: "response.output_item.done", item: first })
		manager.accept({ type: "response.output_text.delta", delta: "Text" })
		manager.accept({ type: "response.output_item.done", item: second })
		expect(manager.completed).toBe(false)
		const response = { id: "resp_1" }
		expect(manager.accept({ type, response })).toBe("emit")
		expect(record).toHaveBeenCalledWith(prepared, response, [first, second])
		expect(manager.completed).toBe(true)
		expect(() => manager.accept({ type: "response.created" })).toThrow("already completed")
		expect(record).toHaveBeenCalledOnce()
	})

	it("completes an empty response without entering streaming", () => {
		manager.init(body)
		const record = vi.spyOn(repository, "record")
		manager.accept({ type: "response.completed", response: { id: "resp_1", output: [] } })
		expect(record).toHaveBeenCalledWith(manager.preparedRequest, { id: "resp_1", output: [] }, [])
		expect(manager.completed).toBe(true)
	})

	it("allows cache-miss recovery once while awaiting the first event", () => {
		repository.record(repository.prepare(body), { id: "resp_cached", output: [] }, [])
		manager.init(body)
		const reset = vi.spyOn(repository, "reset")
		expect(manager.accept(cacheMiss)).toBe("retry")
		expect(reset).toHaveBeenCalledOnce()
		expect(() => manager.accept(cacheMiss)).toThrow("previous_response_not_found")
		expect(reset).toHaveBeenCalledOnce()
	})

	it("rejects cache-miss recovery after streaming starts", () => {
		repository.record(repository.prepare(body), { id: "resp_cached", output: [] }, [])
		manager.init(body)
		manager.accept({ type: "response.created" })
		const reset = vi.spyOn(repository, "reset")
		expect(() => manager.accept(cacheMiss)).toThrow("previous_response_not_found")
		expect(reset).not.toHaveBeenCalled()
	})

	it.each(["response.failed", "response.incomplete"])("does not record completion for %s", (type: string) => {
		manager.init(body)
		const record = vi.spyOn(repository, "record")
		expect(() => manager.accept({ type, response: { error: { message: "Failed" } } })).toThrow("Failed")
		expect(record).not.toHaveBeenCalled()
		expect(manager.completed).toBe(false)
	})
})
