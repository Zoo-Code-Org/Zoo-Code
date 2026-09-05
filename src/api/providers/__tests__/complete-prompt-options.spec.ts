import { describe, it, expect } from "vitest"

import type { CompletePromptOptions } from "../../index"

describe("CompletePromptOptions", () => {
	it("should allow abortSignal property", () => {
		const controller = new AbortController()
		const options: CompletePromptOptions = { abortSignal: controller.signal }
		expect(options.abortSignal).toBe(controller.signal)
	})

	it("should allow timeoutMs property", () => {
		const options: CompletePromptOptions = { timeoutMs: 5000 }
		expect(options.timeoutMs).toBe(5000)
	})

	it("should allow both abortSignal and timeoutMs together", () => {
		const controller = new AbortController()
		const options: CompletePromptOptions = { abortSignal: controller.signal, timeoutMs: 10000 }
		expect(options.abortSignal).toBe(controller.signal)
		expect(options.timeoutMs).toBe(10000)
	})

	it("should allow empty options object", () => {
		const options: CompletePromptOptions = {}
		expect(options.abortSignal).toBeUndefined()
		expect(options.timeoutMs).toBeUndefined()
	})
})
