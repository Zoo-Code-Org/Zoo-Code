import { describe, it, expect } from "vitest"

import type { CompletePromptOptions } from "../../index"

describe("CompletePromptOptions", () => {
	it("should allow signal property", () => {
		const controller = new AbortController()
		const options: CompletePromptOptions = { signal: controller.signal }
		expect(options.signal).toBe(controller.signal)
	})

	it("should allow timeoutMs property", () => {
		const options: CompletePromptOptions = { timeoutMs: 5000 }
		expect(options.timeoutMs).toBe(5000)
	})

	it("should allow both signal and timeoutMs together", () => {
		const controller = new AbortController()
		const options: CompletePromptOptions = { signal: controller.signal, timeoutMs: 10000 }
		expect(options.signal).toBe(controller.signal)
		expect(options.timeoutMs).toBe(10000)
	})

	it("should allow empty options object", () => {
		const options: CompletePromptOptions = {}
		expect(options.signal).toBeUndefined()
		expect(options.timeoutMs).toBeUndefined()
	})
})
