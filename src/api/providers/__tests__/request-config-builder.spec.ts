import { describe, expect, test, vi } from "vitest"

import { makeCreateMessageMetadata } from "../../../test-utils/api"
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

		test("should ignore undefined values from defaultOptions", () => {
			const builder = new RequestConfigBuilder({ modelId: undefined })

			expect(builder.build()).toBeUndefined()
		})

		test("should keep falsy-but-defined values", () => {
			const builder = new RequestConfigBuilder({ count: 0, enabled: false, label: "" })

			expect(builder.build()).toEqual({ count: 0, enabled: false, label: "" })
		})

		test("should not alias the caller's default headers", () => {
			const defaults = { headers: { A: "1" } }
			const builder = new RequestConfigBuilder(defaults)

			defaults.headers.A = "2"

			expect(builder.getOption("headers")).toEqual({ A: "1" })
		})
	})

	describe("setAbortSignal", () => {
		test("should set signal when metadata contains abortSignal", () => {
			const controller = new AbortController()
			const metadata = makeCreateMessageMetadata({ abortSignal: controller.signal })

			const builder = new RequestConfigBuilder()
			const result = builder.setAbortSignal(metadata)

			expect(result).toBe(builder) // chainable
			const config = builder.build() as { signal?: AbortSignal }
			expect(config?.signal).toBe(controller.signal)
		})

		test("should do nothing when metadata is undefined", () => {
			const builder = new RequestConfigBuilder({ initial: "value" })
			builder.setAbortSignal(undefined)

			const config = builder.build() as { signal?: AbortSignal }
			expect(config.signal).toBeUndefined()
		})

		test("should do nothing when metadata.abortSignal is undefined", () => {
			const metadata = makeCreateMessageMetadata()

			const builder = new RequestConfigBuilder({ initial: "value" })
			builder.setAbortSignal(metadata)

			const config = builder.build() as { signal?: AbortSignal }
			expect(config.signal).toBeUndefined()
		})

		test("should replace existing signal if metadata contains abortSignal", () => {
			const controller1 = new AbortController()
			const controller2 = new AbortController()

			const builder = new RequestConfigBuilder({ signal: controller1.signal })
			builder.setAbortSignal(makeCreateMessageMetadata({ abortSignal: controller2.signal }))

			const config = builder.build() as { signal?: AbortSignal }
			expect(config?.signal).toBe(controller2.signal)
		})

		test("should support chaining with other methods", () => {
			const controller = new AbortController()
			const metadata = makeCreateMessageMetadata({ abortSignal: controller.signal })

			const builder = new RequestConfigBuilder()
			const result = builder.setAbortSignal(metadata).setOption("customKey", "customValue")

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

		test("should do nothing when headers are undefined", () => {
			const builder = new RequestConfigBuilder({ initial: "value" })
			const result = builder.addHeaders()

			expect(result).toBe(builder) // chainable
			const config = builder.build() as { headers?: Record<string, string> }
			expect(config.headers).toBeUndefined()
		})

		test("should do nothing when headers object is empty", () => {
			const builder = new RequestConfigBuilder({ initial: "value" })
			const result = builder.addHeaders({})

			expect(result).toBe(builder) // chainable
			const config = builder.build() as { headers?: Record<string, string> }
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
			builder.setOption("initial", undefined as unknown as string)

			const config = builder.build() as { initial?: string }
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

			const config = builder.build() as {
				stringKey?: string
				numberKey?: number
				booleanKey?: boolean
				objectKey?: { nested: boolean }
			}
			expect(config.stringKey).toBe("stringValue")
			expect(config.numberKey).toBe(42)
			expect(config.booleanKey).toBe(true)
			expect(config.objectKey).toEqual({ nested: true })
		})

		test("should keep falsy-but-defined values", () => {
			const builder = new RequestConfigBuilder()
			builder.setOption("count", 0).setOption("enabled", false).setOption("label", "")

			const config = builder.build() as { count?: number; enabled?: boolean; label?: string }
			expect(config.count).toBe(0)
			expect(config.enabled).toBe(false)
			expect(config.label).toBe("")
		})

		test("should support chaining", () => {
			const builder = new RequestConfigBuilder()
			const result = builder.setOption("key1", "value1").setOption("key2", "value2")

			expect(result).toBe(builder)
			const config = builder.build() as { key1?: string; key2?: string }
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
			expect(builder.getOption("nonExistent")).toBeUndefined()
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
			const result = builder.build() as { key: string }

			result.key = "modified"
			expect(builder.getOption("key")).toBe("value")
		})

		test("mutating returned headers should not affect internal state", () => {
			const builder = new RequestConfigBuilder({ headers: { Authorization: "Bearer x" } })
			const config = builder.build() as { headers?: Record<string, string> }

			config.headers!.Authorization = "TAMPERED"

			expect(builder.getOption("headers")).toEqual({ Authorization: "Bearer x" })
		})

		test("should return all set options", () => {
			const controller = new AbortController()
			const metadata = makeCreateMessageMetadata({ abortSignal: controller.signal })

			const builder = new RequestConfigBuilder()
			builder.setAbortSignal(metadata).addHeaders({ "X-Custom": "value" }).setOption("modelId", "test-model")

			const config = builder.build() as {
				signal?: AbortSignal
				headers?: Record<string, string>
				modelId?: string
			}
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
			const metadata = makeCreateMessageMetadata({ abortSignal: controller.signal })

			const result = RequestConfigBuilder.fromMetadata(metadata) as { signal?: AbortSignal }
			expect(result.signal).toBe(controller.signal)
		})

		test("should merge extraOptions with metadata signal", () => {
			const controller = new AbortController()
			const metadata = makeCreateMessageMetadata({ abortSignal: controller.signal })
			const extraOptions = { modelId: "test-model", customKey: "customValue" }

			const result = RequestConfigBuilder.fromMetadata(metadata, extraOptions) as {
				signal?: AbortSignal
				modelId?: string
				customKey?: string
			}
			expect(result.signal).toBe(controller.signal)
			expect(result.modelId).toBe("test-model")
			expect(result.customKey).toBe("customValue")
		})

		test("should return only extraOptions when metadata is undefined", () => {
			const extraOptions = { modelId: "test-model" }
			const result = RequestConfigBuilder.fromMetadata(undefined, extraOptions) as { modelId?: string }
			expect(result.modelId).toBe("test-model")
		})

		test("should treat undefined extraOptions values as absent", () => {
			const result = RequestConfigBuilder.fromMetadata(undefined, { signal: undefined })

			expect(result).toBeUndefined()
		})

		test("should not set signal when metadata.abortSignal is undefined", () => {
			const metadata = makeCreateMessageMetadata()
			const extraOptions = { modelId: "test-model" }

			const result = RequestConfigBuilder.fromMetadata(metadata, extraOptions) as {
				signal?: AbortSignal
				modelId?: string
			}
			expect(result.signal).toBeUndefined()
			expect(result.modelId).toBe("test-model")
		})
	})

	describe("addMergedSignal", () => {
		test("should add internal controller signal when metadata and timeout are absent", () => {
			const internalController = new AbortController()
			const builder = new RequestConfigBuilder()

			const result = builder.addMergedSignal(internalController)

			expect(result).toBe(builder)
			const config = builder.build() as { signal?: AbortSignal }
			expect(config.signal).toBe(internalController.signal)
		})

		test("should merge internal controller signal with metadata abort signal", () => {
			const internalController = new AbortController()
			const externalController = new AbortController()
			const builder = new RequestConfigBuilder()

			builder.addMergedSignal(
				internalController,
				makeCreateMessageMetadata({ abortSignal: externalController.signal }),
			)

			const config = builder.build() as { signal?: AbortSignal }
			expect(config.signal).not.toBe(internalController.signal)
			expect(config.signal).not.toBe(externalController.signal)

			externalController.abort()
			expect(config.signal?.aborted).toBe(true)
		})

		test("should abort merged signal when internal controller is aborted", () => {
			const internalController = new AbortController()
			const externalController = new AbortController()
			const builder = new RequestConfigBuilder()

			builder.addMergedSignal(
				internalController,
				makeCreateMessageMetadata({ abortSignal: externalController.signal }),
			)

			const config = builder.build() as { signal?: AbortSignal }
			expect(config.signal?.aborted).toBe(false)

			internalController.abort()
			expect(config.signal?.aborted).toBe(true)
		})

		test("should abort merged signal after timeout elapses without manual cleanup", async () => {
			const internalController = new AbortController()
			const builder = new RequestConfigBuilder()

			builder.addMergedSignal(internalController, undefined, 50)

			const config = builder.build() as { signal?: AbortSignal }
			expect(config.signal).not.toBe(internalController.signal)
			expect(config.signal?.aborted).toBe(false)

			await vi.waitFor(() => expect(config.signal?.aborted).toBe(true))
		})

		test("should immediately abort when metadata signal is already aborted", () => {
			const internalController = new AbortController()
			const externalController = new AbortController()
			externalController.abort()
			const builder = new RequestConfigBuilder()

			builder.addMergedSignal(
				internalController,
				makeCreateMessageMetadata({ abortSignal: externalController.signal }),
			)

			const config = builder.build() as { signal?: AbortSignal }
			expect(config.signal?.aborted).toBe(true)
		})

		test("should propagate abort from internal controller when all three sources are merged", () => {
			const internalController = new AbortController()
			const externalController = new AbortController()
			const builder = new RequestConfigBuilder()

			builder.addMergedSignal(
				internalController,
				makeCreateMessageMetadata({ abortSignal: externalController.signal }),
				10_000,
			)

			const config = builder.build() as { signal?: AbortSignal }
			expect(config.signal?.aborted).toBe(false)

			internalController.abort()
			expect(config.signal?.aborted).toBe(true)
		})
	})

	describe("integration tests", () => {
		test("should support full chain of operations", () => {
			const controller = new AbortController()
			const metadata = makeCreateMessageMetadata({ abortSignal: controller.signal })

			type TestOptions = {
				modelId?: string
				signal?: AbortSignal
				headers?: Record<string, string>
				maxTokens?: number
			}

			const builder = new RequestConfigBuilder<TestOptions>({ modelId: "default-model" })
			builder.setAbortSignal(metadata)
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
			expect(builder.getOption("anyKey")).toBeUndefined()
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

		test("should accept interface-based options without an index signature", () => {
			interface SdkOptions {
				modelId?: string
				signal?: AbortSignal
				headers?: Record<string, string>
				maxTokens?: number
			}

			const builder = new RequestConfigBuilder<SdkOptions>({ modelId: "default-model" })
			builder.setOption("maxTokens", 2000)

			const config = builder.build() as SdkOptions
			expect(config.modelId).toBe("default-model")
			expect(config.maxTokens).toBe(2000)
		})
	})
})
