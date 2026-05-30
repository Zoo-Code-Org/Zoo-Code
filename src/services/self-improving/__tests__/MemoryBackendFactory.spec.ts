import { describe, expect, it, vi } from "vitest"

import { AgentMemoryAdapter } from "../AgentMemoryAdapter"
import { MemoryBackendFactory } from "../MemoryBackendFactory"
import { MemoryStore } from "../MemoryStore"

describe("MemoryBackendFactory", () => {
	const logger = { appendLine: vi.fn() }
	const baseDir = "/tmp/test"

	it("should create built-in backend by default", () => {
		const backend = MemoryBackendFactory.create("builtin", baseDir, logger)
		expect(backend).toBeInstanceOf(MemoryStore)
	})

	it("should create agentmemory backend when specified", () => {
		const backend = MemoryBackendFactory.create("agentmemory", baseDir, logger)
		expect(backend).toBeInstanceOf(AgentMemoryAdapter)
	})

	it("should create built-in backend for unknown type", () => {
		const backend = MemoryBackendFactory.create("unknown-backend" as any, baseDir, logger)
		expect(backend).toBeInstanceOf(MemoryStore)
	})

	it("should pass agentMemoryUrl to AgentMemoryAdapter", () => {
		const backend = MemoryBackendFactory.create("agentmemory", baseDir, logger, "http://custom:5000")
		expect(backend).toBeInstanceOf(AgentMemoryAdapter)
	})
})
