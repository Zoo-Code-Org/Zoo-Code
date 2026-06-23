import { describe, expect, test } from "vitest"

import type { ApiHandlerCreateMessageMetadata } from "../../index"
import { RequestConfigBuilder } from "../config-builder/request-config-builder"

describe("RequestConfigBuilder", () => {
	describe("constructor", () => {
		test("should initialize with empty options by default", () => {
			const builder = new RequestConfigBuilder()
			expect(builder.build()).toBeUndefined()
		})

		test("should initialize with provided defaultOptions", () => {
			const defaults = { modelId: "test-model" }
			const builder = new RequestConfigBuilder(defaults)
			const result = builder.build()
			expect(result).toEqual({ modelId: "test-model" })
		})

		test("should create a shallow copy of defaultOptions", () => {
			const defaults = { modelId: "test-model" }
			const builder = new RequestConfigBuilder(defaults)
			defaults.modelId = "modified-model"
			const result = builder.build()
			expect(result?.modelId).toBe("test-model")
		})
	})

	describe("addAbortSignal", () => {
		test("should set signal when metadata contains abortSignal", () => {
			const controller = new AbortController()
			const metadata: ApiHandlerCreateMessageMetadata = {
				taskId: "test-task",
				abortSignal: controller.signal,
			}

			const builder = new RequestConfigBuilder()
			const result = builder.addAbortSignal(metadata)

			expect(result).toBe(builder) // chainable
			const config = builder.build() as { signal?: AbortSignal }
			expect(config?.signal).toBe(controller.signal)
		})

		test("should do nothing when metadata is undefined", () => {
			const builder = new RequestConfigBuilder({ initial: "value" })
			builder.addAbortSignal(undefined)

			const config = builder.build() as Record<string, any>
			expect(config.signal).toBeUndefined()
		})

		test("should do nothing when metadata.abortSignal is undefined", () => {
			const metadata: ApiHandlerCreateMessageMetadata = {
				taskId: "test-task",
			}

			const builder = new RequestConfigBuilder({ initial: "value" })
			builder.addAbortSignal(metadata)

			const config = builder.build() as Record<string, any>
			expect(config.signal).toBeUndefined()
		})

		test("should replace existing signal if metadata contains abortSignal", () => {
			const controller1 = new AbortController()
			const controller2 = new AbortController()

			const builder = new RequestConfigBuilder({ signal: controller1.signal })
			builder.addAbortSignal({
				taskId: "test-task",
				abortSignal: controller2.signal,
			} as ApiHandlerCreateMessageMetadata)

			const config = builder.build() as { signal?: AbortSignal }
			expect(config?.signal).toBe(controller2.signal)
		})

		test("should support chaining with other methods", () => {
			const controller = new AbortController()
			const metadata: ApiHandlerCreateMessageMetadata = {
				taskId: "test-task",
				abortSignal: controller.signal,
			}

			const builder = new RequestConfigBuilder()
			const result = builder.addAbortSignal(metadata).setOption("customKey", "customValue")

			expect(result).toBe(builder)
			const config = builder.build() as { signal?: AbortSignal; customKey?: string }
			expect(config?.signal).toBe(controller.signal)
			expect(config?.customKey).toBe("customValue")
		})
	})

	describe("addHeaders", () => {
		test("should merge headers when provided", () => {
			const builder = new RequestConfigBuilder()
			const result = builder.addHeaders({ "X-Custom": "value1" })

			expect(result).toBe(builder) // chainable
			const config = builder.build() as { headers?: Record<string, string> }
			expect(config?.headers).toEqual({ "X-Custom": "value1" })
		})

		test("should do nothing when headers object is empty", () => {
			const builder = new RequestConfigBuilder({ initial: "value" })
			const result = builder.addHeaders({})

			expect(result).toBe(builder) // chainable
			const config = builder.build() as Record<string, any>
			expect(config.headers).toBeUndefined()
		})

		test("should override existing header values", () => {
			const builder = new RequestConfigBuilder({ headers: { "X-Existing": "old" } })
			builder.addHeaders({ "X-Existing": "new" })

			const config = builder.build() as { headers?: Record<string, string> }
			expect(config?.headers?.["X-Existing"]).toBe("new")
		})

		test("should merge with existing headers without overwriting unrelated keys", () => {
			const builder = new RequestConfigBuilder({ headers: { "X-Existing": "value" } })
			builder.addHeaders({ "X-New": "newValue" })

			const config = builder.build() as { headers?: Record<string, string> }
			expect(config?.headers).toEqual({ "X-Existing": "value", "X-New": "newValue" })
		})

		test("should create headers object if none exists", () => {
			const builder = new RequestConfigBuilder()
			builder.addHeaders({ "X-Custom": "value" })

			const config = builder.build() as { headers?: Record<string, string> }
			expect(config?.headers).toEqual({ "X-Custom": "value" })
		})

		test("should support chaining with other methods", () => {
			const builder = new RequestConfigBuilder()
			builder.addHeaders({ "X-First": "1" }).addHeaders({ "X-Second": "2" })

			const config = builder.build() as { headers?: Record<string, string> }
			expect(config?.headers).toEqual({ "X-First": "1", "X-Second": "2" })
		})
	})

	describe("setOption", () => {
		test("should set option when value is defined", () => {
			const builder = new RequestConfigBuilder()
			const result = builder.setOption("modelId", "test-model")

			expect(result).toBe(builder) // chainable
			const config = builder.build() as { modelId?: string }
			expect(config?.modelId).toBe("test-model")
		})

		test("should do nothing when value is undefined", () => {
			const builder = new RequestConfigBuilder({ initial: "value" })
			builder.setOption("initial", undefined as any)

			const config = builder.build() as Record<string, any>
			// When setOption receives undefined, it should NOT modify the existing value
			expect(config.initial).toBe("value")
		})

		test("should replace existing option value", () => {
			const builder = new RequestConfigBuilder({ modelId: "old-model" })
			builder.setOption("modelId", "new-model")

			const config = builder.build() as { modelId?: string }
			expect(config?.modelId).toBe("new-model")
		})

		test("should support different value types", () => {
			const builder = new RequestConfigBuilder()

			builder.setOption("stringKey", "stringValue")
			builder.setOption("numberKey", 42)
			builder.setOption("booleanKey", true)
			builder.setOption("objectKey", { nested: true })

			const config = builder.build() as Record<string, any>
			expect(config.stringKey).toBe("stringValue")
			expect(config.numberKey).toBe(42)
			expect(config.booleanKey).toBe(true)
			expect(config.objectKey).toEqual({ nested: true })
		})

		test("should support chaining", () => {
			const builder = new RequestConfigBuilder()
			const result = builder.setOption("key1", "value1").setOption("key2", "value2")

			expect(result).toBe(builder)
			const config = builder.build() as Record<string, any>
			expect(config.key1).toBe("value1")
			expect(config.key2).toBe("value2")
		})
	})

	describe("getOption", () => {
		test("should return existing option value", () => {
			const builder = new RequestConfigBuilder({ modelId: "test-model" })
			expect(builder.getOption("modelId")).toBe("test-model")
		})

		test("should return undefined for non-existent key", () => {
			const builder = new RequestConfigBuilder()
			expect(builder.getOption("nonExistent" as any)).toBeUndefined()
		})
	})

	describe("build", () => {
		test("should return shallow copy of options", () => {
			const builder = new RequestConfigBuilder({ key: "value" })
			const result1 = builder.build()
			const result2 = builder.build()

			expect(result1).toEqual(result2)
			expect(result1).not.toBe(result2) // different references
		})

		test("should return undefined when options are empty", () => {
			const builder = new RequestConfigBuilder()
			expect(builder.build()).toBeUndefined()
		})

		test("modifying build result should not affect internal state", () => {
			const builder = new RequestConfigBuilder({ key: "value" })
			const result = builder.build() as Record<string, any>

			result.key = "modified"
			expect(builder.getOption("key")).toBe("value")
		})

		test("should return all set options", () => {
			const controller = new AbortController()
			const metadata: ApiHandlerCreateMessageMetadata = {
				taskId: "test-task",
				abortSignal: controller.signal,
			}

			const builder = new RequestConfigBuilder()
			builder.addAbortSignal(metadata).addHeaders({ "X-Custom": "value" }).setOption("modelId", "test-model")

			const config = builder.build() as Record<string, any>
			expect(config.signal).toBe(controller.signal)
			expect(config.headers).toEqual({ "X-Custom": "value" })
			expect(config.modelId).toBe("test-model")
		})
	})

	describe("static fromMetadata", () => {
		test("should return undefined when both metadata and extraOptions are undefined", () => {
			const result = RequestConfigBuilder.fromMetadata()
			expect(result).toBeUndefined()
		})

		test("should set signal from metadata.abortSignal", () => {
			const controller = new AbortController()
			const metadata: ApiHandlerCreateMessageMetadata = {
				taskId: "test-task",
				abortSignal: controller.signal,
			}

			const result = RequestConfigBuilder.fromMetadata(metadata) as Record<string, any>
			expect(result.signal).toBe(controller.signal)
		})

		test("should merge extraOptions with metadata signal", () => {
			const controller = new AbortController()
			const metadata: ApiHandlerCreateMessageMetadata = {
				taskId: "test-task",
				abortSignal: controller.signal,
			}
			const extraOptions = { modelId: "test-model", customKey: "customValue" }

			const result = RequestConfigBuilder.fromMetadata(metadata, extraOptions) as Record<string, any>
			expect(result.signal).toBe(controller.signal)
			expect(result.modelId).toBe("test-model")
			expect(result.customKey).toBe("customValue")
		})

		test("should return only extraOptions when metadata is undefined", () => {
			const extraOptions = { modelId: "test-model" }
			const result = RequestConfigBuilder.fromMetadata(undefined, extraOptions) as Record<string, any>
			expect(result.modelId).toBe("test-model")
		})

		test("should not set signal when metadata.abortSignal is undefined", () => {
			const metadata: ApiHandlerCreateMessageMetadata = { taskId: "test-task" }
			const extraOptions = { modelId: "test-model" }

			const result = RequestConfigBuilder.fromMetadata(metadata, extraOptions) as Record<string, any>
			expect(result.signal).toBeUndefined()
			expect(result.modelId).toBe("test-model")
		})
	})

	describe("static mergeAbortSignals", () => {
		test("should return primarySignal when secondarySignal is undefined", () => {
			const controller = new AbortController()
			const result = RequestConfigBuilder.mergeAbortSignals(controller.signal)
			expect(result).toBe(controller.signal)
		})

		test("should return primarySignal when secondarySignal is already aborted", () => {
			const primaryController = new AbortController()
			const secondaryController = new AbortController()
			secondaryController.abort()

			const result = RequestConfigBuilder.mergeAbortSignals(primaryController.signal, secondaryController.signal)
			expect(result).toBe(primaryController.signal)
		})

		test("should return merged signal when both signals are active", () => {
			const primaryController = new AbortController()
			const secondaryController = new AbortController()

			const result = RequestConfigBuilder.mergeAbortSignals(primaryController.signal, secondaryController.signal)
			expect(result).not.toBe(primaryController.signal)
			expect(result).not.toBe(secondaryController.signal)
		})

		test("should abort merged signal when primarySignal is aborted", async () => {
			const primaryController = new AbortController()
			const secondaryController = new AbortController()

			const mergedSignal = RequestConfigBuilder.mergeAbortSignals(
				primaryController.signal,
				secondaryController.signal,
			)

			let aborted = false
			mergedSignal.addEventListener(
				"abort",
				() => {
					aborted = true
				},
				{ once: true },
			)

			primaryController.abort()

			// Wait for event to propagate
			await new Promise((resolve) => setTimeout(resolve, 10))
			expect(aborted).toBe(true)
		})

		test("should abort merged signal when secondarySignal is aborted", async () => {
			const primaryController = new AbortController()
			const secondaryController = new AbortController()

			const mergedSignal = RequestConfigBuilder.mergeAbortSignals(
				primaryController.signal,
				secondaryController.signal,
			)

			let aborted = false
			mergedSignal.addEventListener(
				"abort",
				() => {
					aborted = true
				},
				{ once: true },
			)

			secondaryController.abort()

			// Wait for event to propagate
			await new Promise((resolve) => setTimeout(resolve, 10))
			expect(aborted).toBe(true)
		})

		test("should not abort merged signal when neither signal is aborted", async () => {
			const primaryController = new AbortController()
			const secondaryController = new AbortController()

			const mergedSignal = RequestConfigBuilder.mergeAbortSignals(
				primaryController.signal,
				secondaryController.signal,
			)

			let aborted = false
			mergedSignal.addEventListener(
				"abort",
				() => {
					aborted = true
				},
				{ once: true },
			)

			await new Promise((resolve) => setTimeout(resolve, 10))
			expect(aborted).toBe(false)
		})

		test("should handle primary already aborted before merge", () => {
			const primaryController = new AbortController()
			const secondaryController = new AbortController()

			primaryController.abort()

			const mergedSignal = RequestConfigBuilder.mergeAbortSignals(
				primaryController.signal,
				secondaryController.signal,
			)
			expect(mergedSignal.aborted).toBe(true)
		})
	})

	describe("integration tests", () => {
		test("should support full chain of operations", () => {
			const controller = new AbortController()
			const metadata: ApiHandlerCreateMessageMetadata = {
				taskId: "test-task",
				abortSignal: controller.signal,
			}

			type TestOptions = {
				modelId?: string
				signal?: AbortSignal
				headers?: Record<string, string>
				maxTokens?: number
			}

			const builder = new RequestConfigBuilder<TestOptions>({ modelId: "default-model" })
			builder.addAbortSignal(metadata)
			builder.addHeaders({ "X-API-Key": "secret" })
			builder.setOption("maxTokens", 2000)

			const config = builder.build() as TestOptions
			expect(config.modelId).toBe("default-model")
			expect(config.signal).toBe(controller.signal)
			expect(config.headers).toEqual({ "X-API-Key": "secret" })
			expect(config.maxTokens).toBe(2000)
		})

		test("should handle empty builder through full lifecycle", () => {
			const builder = new RequestConfigBuilder()
			expect(builder.build()).toBeUndefined()
			expect(builder.getOption("anyKey" as any)).toBeUndefined()
		})

		test("should work with custom default options type", () => {
			type CustomOptions = { apiUrl: string; timeout: number; retryCount?: number }

			const defaults: Partial<CustomOptions> = {
				apiUrl: "https://api.example.com",
				timeout: 30000,
			}

			const builder = new RequestConfigBuilder<CustomOptions>(defaults)
			builder.setOption("retryCount", 3)

			const config = builder.build() as CustomOptions
			expect(config.apiUrl).toBe("https://api.example.com")
			expect(config.timeout).toBe(30000)
			expect(config.retryCount).toBe(3)
		})
	})
})
