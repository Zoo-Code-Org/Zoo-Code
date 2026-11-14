// npx vitest core/config/__tests__/ContextProxy.spec.ts

import * as vscode from "vscode"

import { GLOBAL_STATE_KEYS, SECRET_STATE_KEYS, GLOBAL_SECRET_KEYS } from "@roo-code/types"

import { clearAllMocks } from "../../../test-utils/reset"
import { makeExtensionContext, makeUri } from "../../../test-utils/vscode"

import { logger } from "../../../utils/logging"
import { ContextProxy, SettingsWriteError } from "../ContextProxy"
import { providerIdentifiers, retiredProviderIdentifiers } from "@roo-code/types/provider-identifiers"

vi.mock("vscode", () => ({
	Uri: {
		file: vi.fn((path) => ({ path })),
	},
	ExtensionMode: {
		Development: 1,
		Production: 2,
		Test: 3,
	},
}))

describe("ContextProxy", () => {
	let proxy: ContextProxy
	let mockContext: any
	let mockGlobalState: any
	let mockSecrets: any

	beforeEach(async () => {
		// Reset mocks
		clearAllMocks()

		// Mock globalState
		mockGlobalState = {
			get: vi.fn(),
			update: vi.fn().mockResolvedValue(undefined),
		}

		// Mock secrets
		mockSecrets = {
			get: vi.fn().mockResolvedValue("test-secret"),
			store: vi.fn().mockResolvedValue(undefined),
			delete: vi.fn().mockResolvedValue(undefined),
		}

		// Mock the extension context
		mockContext = {
			...makeExtensionContext({
				globalState: mockGlobalState,
				secrets: mockSecrets,
				extensionUri: makeUri("/test/extension"),
				extensionPath: "/test/extension",
				extensionMode: vscode.ExtensionMode.Development,
			}),
			globalStorageUri: makeUri("/test/storage"),
			logUri: makeUri("/test/logs"),
			extension: { packageJSON: { version: "1.0.0" } },
		}

		// Create proxy instance
		proxy = new ContextProxy(mockContext)
		await proxy.initialize()
	})

	describe("read-only pass-through properties", () => {
		it("should return extension properties from the original context", () => {
			expect(proxy.extensionUri).toBe(mockContext.extensionUri)
			expect(proxy.extensionPath).toBe(mockContext.extensionPath)
			expect(proxy.globalStorageUri).toBe(mockContext.globalStorageUri)
			expect(proxy.logUri).toBe(mockContext.logUri)
			expect(proxy.extension).toBe(mockContext.extension)
			expect(proxy.extensionMode).toBe(mockContext.extensionMode)
		})
	})

	describe("constructor", () => {
		it("should initialize state cache with all global state keys", () => {
			// +3 for the migration checks:
			// 1. openRouterImageGenerationSettings
			// 2. customCondensingPrompt
			// 3. customSupportPrompts (for migrateOldDefaultCondensingPrompt)
			expect(mockGlobalState.get).toHaveBeenCalledTimes(GLOBAL_STATE_KEYS.length + 3)
			for (const key of GLOBAL_STATE_KEYS) {
				expect(mockGlobalState.get).toHaveBeenCalledWith(key)
			}
			// Also check for migration calls
			expect(mockGlobalState.get).toHaveBeenCalledWith("openRouterImageGenerationSettings")
			expect(mockGlobalState.get).toHaveBeenCalledWith("customCondensingPrompt")
			expect(mockGlobalState.get).toHaveBeenCalledWith("customSupportPrompts")
		})

		it("should initialize secret cache with all secret keys", () => {
			expect(mockSecrets.get).toHaveBeenCalledTimes(SECRET_STATE_KEYS.length + GLOBAL_SECRET_KEYS.length)
			for (const key of SECRET_STATE_KEYS) {
				expect(mockSecrets.get).toHaveBeenCalledWith(key)
			}
			for (const key of GLOBAL_SECRET_KEYS) {
				expect(mockSecrets.get).toHaveBeenCalledWith(key)
			}
		})
	})

	describe("getGlobalState", () => {
		it("should return value from cache when it exists", async () => {
			// Manually set a value in the cache
			await proxy.updateGlobalState("apiProvider", "deepseek")

			// Should return the cached value
			const result = proxy.getGlobalState("apiProvider")
			expect(result).toBe("deepseek")

			// Original context should be called once during updateGlobalState (+3 for migration checks)
			expect(mockGlobalState.get).toHaveBeenCalledTimes(GLOBAL_STATE_KEYS.length + 3) // From initialization + migration checks
		})

		it("should handle default values correctly", async () => {
			// No value in cache
			const result = proxy.getGlobalState("apiProvider", "deepseek")
			expect(result).toBe("deepseek")
		})

		it("should bypass cache for pass-through state keys", async () => {
			// Setup mock return value
			mockGlobalState.get.mockReturnValue("pass-through-value")

			// Use a pass-through key (taskHistory)
			const result = proxy.getGlobalState("taskHistory")

			// Should get value directly from original context
			expect(result).toBe("pass-through-value")
			expect(mockGlobalState.get).toHaveBeenCalledWith("taskHistory")
		})

		it("should respect default values for pass-through state keys", async () => {
			// Setup mock to return undefined
			mockGlobalState.get.mockReturnValue(undefined)

			// Use a pass-through key with default value
			const historyItems = [
				{
					id: "1",
					number: 1,
					ts: 1,
					task: "test",
					tokensIn: 1,
					tokensOut: 1,
					totalCost: 1,
				},
			]

			const result = proxy.getGlobalState("taskHistory", historyItems)

			// Should return default value when original context returns undefined
			expect(result).toBe(historyItems)
		})
	})

	describe("updateGlobalState", () => {
		it("should update state directly in original context", async () => {
			await proxy.updateGlobalState("apiProvider", "deepseek")

			// Should have called original context
			expect(mockGlobalState.update).toHaveBeenCalledWith("apiProvider", "deepseek")

			// Should have stored the value in cache
			const storedValue = await proxy.getGlobalState("apiProvider")
			expect(storedValue).toBe("deepseek")
		})

		it("should bypass cache for pass-through state keys", async () => {
			const historyItems = [
				{
					id: "1",
					number: 1,
					ts: 1,
					task: "test",
					tokensIn: 1,
					tokensOut: 1,
					totalCost: 1,
				},
			]

			await proxy.updateGlobalState("taskHistory", historyItems)

			// Should update original context
			expect(mockGlobalState.update).toHaveBeenCalledWith("taskHistory", historyItems)

			// Setup mock for subsequent get
			mockGlobalState.get.mockReturnValue(historyItems)

			// Should get fresh value from original context
			const storedValue = proxy.getGlobalState("taskHistory")
			expect(storedValue).toBe(historyItems)
			expect(mockGlobalState.get).toHaveBeenCalledWith("taskHistory")
		})
	})

	describe("getSecret", () => {
		it("should return value from cache when it exists", async () => {
			// Manually set a value in the cache
			await proxy.storeSecret("apiKey", "cached-secret")

			// Should return the cached value
			const result = proxy.getSecret("apiKey")
			expect(result).toBe("cached-secret")
		})
	})

	describe("storeSecret", () => {
		it("should store secret directly in original context", async () => {
			await proxy.storeSecret("apiKey", "new-secret")

			// Should have called original context
			expect(mockSecrets.store).toHaveBeenCalledWith("apiKey", "new-secret")

			// Should have stored the value in cache
			const storedValue = await proxy.getSecret("apiKey")
			expect(storedValue).toBe("new-secret")
		})

		it("should handle undefined value for secret deletion", async () => {
			await proxy.storeSecret("apiKey", undefined)

			// Should have called delete on original context
			expect(mockSecrets.delete).toHaveBeenCalledWith("apiKey")

			// Should have stored undefined in cache
			const storedValue = await proxy.getSecret("apiKey")
			expect(storedValue).toBeUndefined()
		})
	})

	describe("setValue", () => {
		it("should route secret keys to storeSecret", async () => {
			// Spy on storeSecret
			const storeSecretSpy = vi.spyOn(proxy, "storeSecret")

			// Test with a known secret key
			await proxy.setValue("openAiApiKey", "test-api-key")

			// Should have called storeSecret
			expect(storeSecretSpy).toHaveBeenCalledWith("openAiApiKey", "test-api-key")

			// Should have stored the value in secret cache
			const storedValue = proxy.getSecret("openAiApiKey")
			expect(storedValue).toBe("test-api-key")
		})

		it("should route global state keys to updateGlobalState", async () => {
			// Spy on updateGlobalState
			const updateGlobalStateSpy = vi.spyOn(proxy, "updateGlobalState")

			// Test with a known global state key
			await proxy.setValue("apiModelId", "gpt-4")

			// Should have called updateGlobalState
			expect(updateGlobalStateSpy).toHaveBeenCalledWith("apiModelId", "gpt-4")

			// Should have stored the value in state cache
			const storedValue = proxy.getGlobalState("apiModelId")
			expect(storedValue).toBe("gpt-4")
		})
	})

	describe("setValues", () => {
		it("should process multiple values correctly", async () => {
			// Spy on setValue
			const setValueSpy = vi.spyOn(proxy, "setValue")

			// Test with multiple values
			await proxy.setValues({
				apiModelId: "gpt-4",
				apiProvider: providerIdentifiers.openai,
				mode: "test-mode",
			})

			// Should have called setValue for each key
			expect(setValueSpy).toHaveBeenCalledTimes(3)
			expect(setValueSpy).toHaveBeenCalledWith("apiModelId", "gpt-4")
			expect(setValueSpy).toHaveBeenCalledWith("apiProvider", "openai")
			expect(setValueSpy).toHaveBeenCalledWith("mode", "test-mode")

			// Should have stored all values in state cache
			expect(proxy.getGlobalState("apiModelId")).toBe("gpt-4")
			expect(proxy.getGlobalState("apiProvider")).toBe("openai")
			expect(proxy.getGlobalState("mode")).toBe("test-mode")
		})

		it("is not a transaction: if one store rejects, the others stay, the cache is read back, and the keys are reported", async () => {
			// Storage that really holds values: what was stored before, and what a failed store leaves behind.
			const storage = new Map<string, unknown>([
				["timeFormat", "auto"],
				["dateFormat", "auto"],
				["showRelativeTimes", true],
			])
			mockGlobalState.get.mockImplementation((key: string) => storage.get(key))
			const failure = new Error("storage unavailable")
			mockGlobalState.update.mockImplementation(async (key: string, value: unknown) => {
				if (key === "dateFormat") throw failure // rejects without having stored anything
				storage.set(key, value)
			})
			await proxy.initialize()

			const error = await proxy
				.setValues({ timeFormat: "24h", dateFormat: "ymd", showRelativeTimes: false })
				.catch((e: unknown) => e)

			expect(error).toBeInstanceOf(SettingsWriteError)
			expect((error as Error).name).toBe("SettingsWriteError")
			expect(error).toMatchObject({
				committed: ["timeFormat", "showRelativeTimes"],
				failed: ["dateFormat"],
				cause: failure,
			})
			expect((error as Error).message).toBe(
				"Could not store dateFormat (stored: timeFormat, showRelativeTimes): storage unavailable",
			)
			// The stores that worked were not undone, and the failed key's cache shows what the Memento holds.
			expect(storage.get("timeFormat")).toBe("24h")
			expect(proxy.getGlobalState("timeFormat")).toBe("24h")
			expect(proxy.getGlobalState("showRelativeTimes")).toBe(false)
			expect(proxy.getGlobalState("dateFormat")).toBe("auto")
		})

		it("reads the cache back from storage for a key whose store failed after changing it", async () => {
			const storage = new Map<string, unknown>([["dateFormat", "auto"]])
			mockGlobalState.get.mockImplementation((key: string) => storage.get(key))
			mockGlobalState.update.mockImplementation(async (key: string, value: unknown) => {
				storage.set(key, value)
				throw new Error("failed after storing")
			})
			await proxy.initialize()

			await expect(proxy.setValues({ dateFormat: "ymd" })).rejects.toBeInstanceOf(SettingsWriteError)

			// Storage did change, so the cache shows the stored value, not a value it assumed.
			expect(proxy.getGlobalState("dateFormat")).toBe("ymd")
		})

		it("reads a secret whose store failed back from the secret storage", async () => {
			mockSecrets.get.mockImplementation(async (key: string) =>
				key === "openAiApiKey" ? "stored-key" : undefined,
			)
			mockSecrets.store.mockRejectedValue(new Error("keychain locked"))
			await proxy.initialize()

			const error = await proxy.setValues({ openAiApiKey: "new-key" }).catch((e: unknown) => e)

			expect(error).toMatchObject({ committed: [], failed: ["openAiApiKey"] })
			// The cache shows what the keychain holds, not the key that was never saved.
			expect(proxy.getSecret("openAiApiKey")).toBe("stored-key")
		})

		it("reports a failed secret delete with the delete error, and reads the secret back into the cache", async () => {
			mockSecrets.get.mockResolvedValue("stored-key") // the delete did not take effect
			await proxy.initialize()
			const failure = new Error("keychain locked")
			mockSecrets.delete.mockRejectedValue(failure)

			await expect(proxy.storeSecret("openAiApiKey", undefined)).rejects.toBe(failure)

			expect(mockSecrets.store).not.toHaveBeenCalled()
			// The cache shows what the keychain still holds, not the deletion that never happened.
			expect(proxy.getSecret("openAiApiKey")).toBe("stored-key")
			expect(proxy["secretWriteOwner"].size).toBe(0)
		})

		it("turns a store that throws at once into a rejection, and corrects the cache", async () => {
			mockSecrets.get.mockResolvedValue("stored-key")
			await proxy.initialize()
			const failure = new Error("keychain unavailable")
			mockSecrets.store.mockImplementation(() => {
				throw failure
			})

			await expect(proxy.storeSecret("openAiApiKey", "new-key")).rejects.toBe(failure)

			expect(proxy.getSecret("openAiApiKey")).toBe("stored-key")
			expect(proxy["secretWriteOwner"].size).toBe(0)
		})

		it("turns a global state update that throws at once into a rejection, and corrects the cache", async () => {
			mockGlobalState.get.mockImplementation((key: string) => (key === "dateFormat" ? "auto" : undefined))
			await proxy.initialize()
			const failure = new Error("storage unavailable")
			mockGlobalState.update.mockImplementation(() => {
				throw failure
			})

			await expect(proxy.updateGlobalState("dateFormat", "ymd")).rejects.toBe(failure)

			expect(proxy.getGlobalState("dateFormat")).toBe("auto")
			expect(proxy["stateWriteOwner"].size).toBe(0)
		})

		it.each([
			["succeeds", false],
			["fails", true],
		])("keeps no write owner once a write of a setting or a secret %s", async (_name, fails) => {
			await proxy.initialize()
			if (fails) {
				mockGlobalState.update.mockRejectedValue(new Error("no"))
				mockSecrets.store.mockRejectedValue(new Error("no"))
			}

			const writes = [proxy.updateGlobalState("dateFormat", "ymd"), proxy.storeSecret("openAiApiKey", "key")]
			expect(proxy["stateWriteOwner"].size).toBe(1) // while the writes are in flight
			expect(proxy["secretWriteOwner"].size).toBe(1)
			await Promise.allSettled(writes)

			expect(proxy["stateWriteOwner"].size).toBe(0)
			expect(proxy["secretWriteOwner"].size).toBe(0)
		})

		it("keeps the owner of a newer secret write when an older write of the key finishes first", async () => {
			let finishOlder: () => void = () => {}
			mockSecrets.store
				.mockImplementationOnce(() => new Promise<void>((resolve) => (finishOlder = resolve)))
				.mockImplementationOnce(() => new Promise<void>(() => {})) // the newer write is still in flight
			await proxy.initialize()

			const older = proxy.storeSecret("openAiApiKey", "older")
			void proxy.storeSecret("openAiApiKey", "newer")
			finishOlder()
			await older

			expect(proxy["secretWriteOwner"].size).toBe(1)
		})

		it("keeps the owner of a newer write when an older write of the key finishes first", async () => {
			let finishOlder: () => void = () => {}
			mockGlobalState.update
				.mockImplementationOnce(() => new Promise<void>((resolve) => (finishOlder = resolve)))
				.mockImplementationOnce(() => new Promise<void>(() => {})) // the newer write is still in flight
			await proxy.initialize()

			const older = proxy.updateGlobalState("dateFormat", "ymd")
			void proxy.updateGlobalState("dateFormat", "dmy")
			finishOlder()
			await older

			expect(proxy["stateWriteOwner"].size).toBe(1)
		})

		it("does not let a failed write whose read-back times out hide a secret that refreshSecrets loaded", async () => {
			vi.useFakeTimers()
			try {
				mockSecrets.store.mockRejectedValue(new Error("keychain locked"))
				await proxy.initialize()
				let readBackSettles: (value: string) => void = () => {}
				mockSecrets.get
					.mockImplementationOnce(() => new Promise((resolve) => (readBackSettles = resolve))) // the read-back, queued first
					.mockResolvedValue("loaded-key") // what the refresh reads

				const failed = expect(proxy.storeSecret("openAiApiKey", "new-key")).rejects.toThrow("keychain locked")
				await vi.advanceTimersByTimeAsync(0) // the store has failed and the read-back has started
				await proxy.refreshSecrets()
				expect(proxy.getSecret("openAiApiKey")).toBe("loaded-key")
				await vi.advanceTimersByTimeAsync(5_000) // the read-back times out
				await failed

				expect(proxy.getSecret("openAiApiKey")).toBe("loaded-key")
				expect(proxy["secretWriteOwner"].size).toBe(0)
				readBackSettles("late")
			} finally {
				vi.useRealTimers()
			}
		})

		it("does not replace a secret written while refreshSecrets was reading it", async () => {
			await proxy.initialize()
			mockSecrets.get.mockClear() // initialize() read the secrets too: wait for the read of the refresh
			let finishRead: (value: string) => void = () => {}
			// Only the read of this key is held back; the other keys resolve as usual.
			mockSecrets.get.mockImplementation((key: string) =>
				key === "openAiApiKey" ? new Promise((resolve) => (finishRead = resolve)) : Promise.resolve(undefined),
			)

			const refreshing = proxy.refreshSecrets()
			await vi.waitFor(() => expect(mockSecrets.get).toHaveBeenCalledWith("openAiApiKey"))
			await proxy.storeSecret("openAiApiKey", "written-key") // starts and succeeds during the read
			finishRead("older-key")
			await refreshing

			expect(proxy.getSecret("openAiApiKey")).toBe("written-key")
		})

		it("still reports the failure when the secret cannot be read back either", async () => {
			mockSecrets.store.mockRejectedValue(new Error("keychain locked"))
			await proxy.initialize()
			mockSecrets.get.mockRejectedValue(new Error("keychain locked"))

			await expect(proxy.setValues({ openAiApiKey: "new-key" })).rejects.toBeInstanceOf(SettingsWriteError)

			// The key that was never saved is not served: the cache is empty until the next write or a refresh.
			expect(proxy.getSecret("openAiApiKey")).toBeUndefined()
		})

		it("words the report for a failure that is not an Error, and when nothing was stored", async () => {
			mockGlobalState.update.mockRejectedValue("disk full")
			await proxy.initialize()

			const error = await proxy.setValues({ dateFormat: "ymd" }).catch((e: unknown) => e)

			expect(error).toMatchObject({ committed: [], failed: ["dateFormat"], cause: "disk full" })
			expect((error as Error).message).toBe("Could not store dateFormat: disk full")
		})

		it("reports a failed pass-through key without touching the cache, which does not hold it", async () => {
			mockGlobalState.update.mockRejectedValue(new Error("storage unavailable"))
			await proxy.initialize()
			mockGlobalState.get.mockClear()

			const error = await proxy.setValues({ taskHistory: [] }).catch((e: unknown) => e)

			expect(error).toMatchObject({ committed: [], failed: ["taskHistory"] })
			expect(mockGlobalState.get).not.toHaveBeenCalled() // no read-back: this key is never cached
		})

		it("logs a secret that cannot be read back as text when the failure is not an Error", async () => {
			mockSecrets.store.mockRejectedValue(new Error("keychain locked"))
			await proxy.initialize()
			mockSecrets.get.mockRejectedValue("locked")
			const logged = vi.spyOn(logger, "error").mockImplementation(() => {})

			await expect(proxy.setValues({ openAiApiKey: "new-key" })).rejects.toBeInstanceOf(SettingsWriteError)

			expect(logged).toHaveBeenCalledWith("Error reading back secret openAiApiKey: locked")
			logged.mockRestore()
		})

		it("still rejects with the write error, and drops the unsaved secret, when the read-back never settles", async () => {
			vi.useFakeTimers()
			try {
				const failure = new Error("keychain locked")
				mockSecrets.store.mockRejectedValue(failure)
				await proxy.initialize()
				mockSecrets.get.mockImplementation(() => new Promise(() => {})) // never settles
				const logged = vi.spyOn(logger, "error").mockImplementation(() => {})

				const storing = expect(proxy.storeSecret("openAiApiKey", "new-key")).rejects.toBe(failure)
				await vi.advanceTimersByTimeAsync(4_999)
				expect(proxy.getSecret("openAiApiKey")).toBe("new-key") // still waiting for the read-back
				await vi.advanceTimersByTimeAsync(1)
				await storing

				expect(proxy.getSecret("openAiApiKey")).toBeUndefined()
				expect(logged).toHaveBeenCalledWith(
					"Error reading back secret openAiApiKey: Reading back openAiApiKey did not finish in 5 seconds",
				)
				expect(vi.getTimerCount()).toBe(0)
				logged.mockRestore()
			} finally {
				vi.useRealTimers()
			}
		})

		it("releases the read-back deadline when the read settles in time", async () => {
			vi.useFakeTimers()
			try {
				mockSecrets.store.mockRejectedValue(new Error("keychain locked"))
				await proxy.initialize()
				mockSecrets.get.mockResolvedValue("stored-key")

				await expect(proxy.storeSecret("openAiApiKey", "new-key")).rejects.toThrow("keychain locked")

				expect(proxy.getSecret("openAiApiKey")).toBe("stored-key")
				expect(vi.getTimerCount()).toBe(0)
			} finally {
				vi.useRealTimers()
			}
		})

		it("does not read a secret back for a failed store that a newer write of the key has already superseded", async () => {
			let failOlder: () => void = () => {}
			mockSecrets.store
				.mockImplementationOnce(
					() => new Promise((_resolve, reject) => (failOlder = () => reject(new Error("no")))),
				)
				.mockResolvedValue(undefined)
			await proxy.initialize()
			mockSecrets.get.mockClear()

			const older = proxy.storeSecret("openAiApiKey", "older").catch((e: unknown) => e)
			await proxy.storeSecret("openAiApiKey", "newer") // the newer write has its own outcome
			failOlder()
			await older

			expect(mockSecrets.get).not.toHaveBeenCalled()
			expect(proxy.getSecret("openAiApiKey")).toBe("newer")
		})

		it("keeps a newer value written while a failed secret is being read back", async () => {
			mockSecrets.store.mockRejectedValueOnce(new Error("keychain locked")).mockResolvedValue(undefined)
			await proxy.initialize()
			let readBack: (value: string | undefined) => void = () => {}
			mockSecrets.get.mockImplementation(() => new Promise((resolve) => (readBack = resolve)))
			mockSecrets.get.mockClear() // initialize() read the secrets too: wait for the read-back of this write

			const failing = proxy.setValues({ openAiApiKey: "old-attempt" }).catch((e: unknown) => e)
			await vi.waitFor(() => expect(mockSecrets.get).toHaveBeenCalled())
			await proxy.setValues({ openAiApiKey: "newer-key" }) // starts and succeeds during the read-back
			readBack("stale-from-storage")
			await failing

			expect(proxy.getSecret("openAiApiKey")).toBe("newer-key")
		})

		it("does not clear a newer value of the same key when an older write's read-back fails", async () => {
			mockSecrets.store.mockRejectedValueOnce(new Error("keychain locked")).mockResolvedValue(undefined)
			await proxy.initialize()
			let failReadBack: () => void = () => {}
			mockSecrets.get.mockImplementation(
				() => new Promise((_resolve, reject) => (failReadBack = () => reject(new Error("keychain locked")))),
			)
			mockSecrets.get.mockClear() // initialize() read the secrets too: wait for the read-back of this write
			const logged = vi.spyOn(logger, "error").mockImplementation(() => {})

			const failing = proxy.setValues({ openAiApiKey: "same-value" }).catch((e: unknown) => e)
			await vi.waitFor(() => expect(mockSecrets.get).toHaveBeenCalled())
			await proxy.setValues({ openAiApiKey: "same-value" }) // a newer write of the same value succeeds
			failReadBack()
			await failing

			expect(proxy.getSecret("openAiApiKey")).toBe("same-value")
			logged.mockRestore()
		})

		// A Memento can keep the attempted value in memory after a rejected update, or drop it: the cache shows
		// whichever it holds.
		it.each([
			["keeps the attempted value in memory", true, "ymd"],
			["does not keep the attempted value", false, "auto"],
		])(
			"reads a global setting back from a Memento that %s, when a single setValue fails",
			async (_name, keeps, expected) => {
				const memento = new Map<string, unknown>([["dateFormat", "auto"]])
				mockGlobalState.get.mockImplementation((key: string) => memento.get(key))
				mockGlobalState.update.mockImplementation(async (key: string, value: unknown) => {
					if (keeps) memento.set(key, value)
					throw new Error("storage unavailable")
				})
				await proxy.initialize()

				await expect(proxy.setValue("dateFormat", "ymd")).rejects.toThrow("storage unavailable")

				expect(proxy.getGlobalState("dateFormat")).toBe(expected)
				expect(proxy.getGlobalState("dateFormat")).toBe(memento.get("dateFormat"))
			},
		)

		it("does not let an older failed write replace the value of a newer write of the same key that is still being stored", async () => {
			const storage = new Map<string, unknown>([["dateFormat", "auto"]])
			mockGlobalState.get.mockImplementation((key: string) => storage.get(key))
			let failOlder: () => void = () => {}
			let landNewer: () => void = () => {}
			mockGlobalState.update
				.mockImplementationOnce(
					() => new Promise((_resolve, reject) => (failOlder = () => reject(new Error("no")))),
				)
				.mockImplementationOnce(
					(key: string, value: unknown) =>
						new Promise<void>((resolve) => (landNewer = () => (storage.set(key, value), resolve()))),
				)
			await proxy.initialize()

			const older = proxy.setValue("dateFormat", "dmy").catch((e: unknown) => e)
			const newer = proxy.setValue("dateFormat", "ymd") // still being stored
			failOlder()
			await older

			// Storage still holds "auto", but the newer write has its own outcome: its value stays in the cache.
			expect(proxy.getGlobalState("dateFormat")).toBe("ymd")
			landNewer()
			await newer
			expect(proxy.getGlobalState("dateFormat")).toBe("ymd")
		})

		it("stays pending until every store has settled, then reports the committed and failed keys", async () => {
			let settleSlow: () => void = () => {}
			mockGlobalState.update.mockImplementation((key: string) => {
				if (key === "dateFormat") return Promise.reject(new Error("storage unavailable")) // fails at once
				return new Promise<void>((resolve) => (settleSlow = resolve)) // the others are slow
			})
			await proxy.initialize()
			let outcome: unknown = "pending"
			const writing = proxy
				.setValues({ dateFormat: "ymd", timeFormat: "24h" })
				.catch((e: unknown) => (outcome = e))
			await new Promise((resolve) => setTimeout(resolve, 0))

			expect(outcome).toBe("pending") // the rejection has happened, the slow store has not settled

			settleSlow()
			await writing

			expect(outcome).toBeInstanceOf(SettingsWriteError)
			expect(outcome).toMatchObject({ committed: ["timeFormat"], failed: ["dateFormat"] })
		})

		it("keeps the first failure as the cause even when it was rejected without a reason", async () => {
			mockGlobalState.update.mockImplementation((key: string) =>
				key === "dateFormat" ? Promise.reject(undefined) : Promise.reject(new Error("later failure")),
			)
			await proxy.initialize()

			const error = await proxy.setValues({ dateFormat: "ymd", timeFormat: "24h" }).catch((e: unknown) => e)

			expect(error).toMatchObject({ failed: ["dateFormat", "timeFormat"], cause: undefined })
			expect((error as Error).message).toContain("undefined")
			expect((error as Error).message).not.toContain("later failure")
		})

		it("does not report a failure when every store succeeds", async () => {
			await expect(proxy.setValues({ timeFormat: "24h", dateFormat: "ymd" })).resolves.toBeUndefined()
		})

		it("should handle both secret and global state keys", async () => {
			// Spy on storeSecret and updateGlobalState
			const storeSecretSpy = vi.spyOn(proxy, "storeSecret")
			const updateGlobalStateSpy = vi.spyOn(proxy, "updateGlobalState")

			// Test with mixed keys
			await proxy.setValues({
				apiModelId: "gpt-4", // global state
				openAiApiKey: "test-api-key", // secret
			})

			// Should have called appropriate methods
			expect(storeSecretSpy).toHaveBeenCalledWith("openAiApiKey", "test-api-key")
			expect(updateGlobalStateSpy).toHaveBeenCalledWith("apiModelId", "gpt-4")

			// Should have stored values in appropriate caches
			expect(proxy.getSecret("openAiApiKey")).toBe("test-api-key")
			expect(proxy.getGlobalState("apiModelId")).toBe("gpt-4")
		})
	})

	describe("setProviderSettings", () => {
		it("stores and returns the complete IO Intelligence configuration across secret and global state", async () => {
			await proxy.setProviderSettings({
				apiProvider: providerIdentifiers.ioIntelligence,
				ioIntelligenceApiKey: "ionet-secret",
				ioIntelligenceModelId: "meta-llama/Llama-3.3-70B-Instruct",
			})

			expect(mockSecrets.store).toHaveBeenCalledWith("ioIntelligenceApiKey", "ionet-secret")
			expect(mockGlobalState.update).toHaveBeenCalledWith(
				"ioIntelligenceModelId",
				"meta-llama/Llama-3.3-70B-Instruct",
			)
			expect(proxy.getProviderSettings()).toMatchObject({
				apiProvider: providerIdentifiers.ioIntelligence,
				ioIntelligenceApiKey: "ionet-secret",
				ioIntelligenceModelId: "meta-llama/Llama-3.3-70B-Instruct",
			})
		})

		it("stores and returns the complete NanoGPT configuration across secret and global state", async () => {
			await proxy.setProviderSettings({
				apiProvider: providerIdentifiers.nanogpt,
				nanoGptApiKey: "nanogpt-secret",
				nanoGptModelId: "openai/model",
				nanoGptRoutingPreference: "throughput",
			})

			expect(mockSecrets.store).toHaveBeenCalledWith("nanoGptApiKey", "nanogpt-secret")
			expect(mockGlobalState.update).toHaveBeenCalledWith("nanoGptModelId", "openai/model")
			expect(mockGlobalState.update).toHaveBeenCalledWith("nanoGptRoutingPreference", "throughput")
			expect(proxy.getProviderSettings()).toMatchObject({
				apiProvider: providerIdentifiers.nanogpt,
				nanoGptApiKey: "nanogpt-secret",
				nanoGptModelId: "openai/model",
				nanoGptRoutingPreference: "throughput",
			})
		})

		it("should clear old API configuration values and set new ones", async () => {
			// Set up initial API configuration values
			await proxy.updateGlobalState("apiModelId", "old-model")
			await proxy.updateGlobalState("openAiBaseUrl", "https://old-url.com")
			await proxy.updateGlobalState("modelTemperature", 0.7)

			// Spy on setValues
			const setValuesSpy = vi.spyOn(proxy, "setValues")

			// Call setProviderSettings with new configuration
			await proxy.setProviderSettings({
				apiModelId: "new-model",
				apiProvider: providerIdentifiers.anthropic,
				// Note: openAiBaseUrl is not included in the new config
			})

			// Verify setValues was called with the correct parameters
			// It should include undefined for openAiBaseUrl (to clear it)
			// and the new values for apiModelId and apiProvider
			expect(setValuesSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					apiModelId: "new-model",
					apiProvider: providerIdentifiers.anthropic,
					openAiBaseUrl: undefined,
					modelTemperature: undefined,
				}),
			)

			// Verify the state cache has been updated correctly
			expect(proxy.getGlobalState("apiModelId")).toBe("new-model")
			expect(proxy.getGlobalState("apiProvider")).toBe("anthropic")
			expect(proxy.getGlobalState("openAiBaseUrl")).toBeUndefined()
			expect(proxy.getGlobalState("modelTemperature")).toBeUndefined()
		})

		it("should handle empty API configuration", async () => {
			// Set up initial API configuration values
			await proxy.updateGlobalState("apiModelId", "old-model")
			await proxy.updateGlobalState("openAiBaseUrl", "https://old-url.com")

			// Spy on setValues
			const setValuesSpy = vi.spyOn(proxy, "setValues")

			// Call setProviderSettings with empty configuration
			await proxy.setProviderSettings({})

			// Verify setValues was called with undefined for all existing API config keys
			expect(setValuesSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					apiModelId: undefined,
					openAiBaseUrl: undefined,
				}),
			)

			// Verify the state cache has been cleared
			expect(proxy.getGlobalState("apiModelId")).toBeUndefined()
			expect(proxy.getGlobalState("openAiBaseUrl")).toBeUndefined()
		})
	})

	describe("export()", () => {
		it("omits host-owned viewStates from a settings export", async () => {
			await proxy.setValue("viewStates", {
				"export-view": { claimToken: "export-claim-token", mode: "architect" },
			})
			// A portable global setting the export schema keeps: without it the test would pass on an
			// empty export, because every remaining check only asserts absence.
			await proxy.setValue("customInstructions", "retain these instructions")
			// The cache carries the key; only the export must not.
			expect(Object.keys(proxy.getValues())).toContain("viewStates")
			const exported = await proxy.export()
			expect(exported?.customInstructions).toBe("retain these instructions")
			expect(exported && Object.keys(exported)).not.toContain("viewStates")
			expect(exported && "viewStates" in exported).toBe(false)
			// The value must not escape under another name either: the claim token is host state.
			expect(JSON.stringify(exported)).not.toContain("export-claim-token")
		})
	})

	describe("resetAllState", () => {
		it("should clear all in-memory caches", async () => {
			// Setup initial state in caches
			await proxy.setValues({
				apiModelId: "gpt-4", // global state
				openAiApiKey: "test-api-key", // secret
			})

			// Verify initial state
			expect(proxy.getGlobalState("apiModelId")).toBe("gpt-4")
			expect(proxy.getSecret("openAiApiKey")).toBe("test-api-key")

			// Reset all state
			await proxy.resetAllState()

			// Caches should be reinitialized with values from the context
			// Since our mock globalState.get returns undefined by default,
			// the cache should now contain undefined values
			expect(proxy.getGlobalState("apiModelId")).toBeUndefined()
		})

		it("should update all global state keys to undefined", async () => {
			// Setup initial state
			await proxy.updateGlobalState("apiModelId", "gpt-4")
			await proxy.updateGlobalState("apiProvider", "openai")

			// Reset all state
			await proxy.resetAllState()

			// Should have called update with undefined for each key
			for (const key of GLOBAL_STATE_KEYS) {
				expect(mockGlobalState.update).toHaveBeenCalledWith(key, undefined)
			}

			// Total calls should include initial setup + reset operations
			const expectedUpdateCalls = 2 + GLOBAL_STATE_KEYS.length
			expect(mockGlobalState.update).toHaveBeenCalledTimes(expectedUpdateCalls)
		})

		it("should delete all secrets", async () => {
			// Setup initial secrets
			await proxy.storeSecret("apiKey", "test-api-key")
			await proxy.storeSecret("openAiApiKey", "test-openai-key")

			// Reset all state
			await proxy.resetAllState()

			// Should have called delete for each key
			for (const key of SECRET_STATE_KEYS) {
				expect(mockSecrets.delete).toHaveBeenCalledWith(key)
			}
			for (const key of GLOBAL_SECRET_KEYS) {
				expect(mockSecrets.delete).toHaveBeenCalledWith(key)
			}

			// Total calls should equal the number of secret keys
			expect(mockSecrets.delete).toHaveBeenCalledTimes(SECRET_STATE_KEYS.length + GLOBAL_SECRET_KEYS.length)
		})

		it("should reinitialize caches after reset", async () => {
			// Spy on initialization methods
			const initializeSpy = vi.spyOn(proxy, "initialize")

			// Reset all state
			await proxy.resetAllState()

			// Should reinitialize caches
			expect(initializeSpy).toHaveBeenCalledTimes(1)
		})
	})

	describe("invalid apiProvider migration", () => {
		it("should clear Roo provider state during initialization", async () => {
			clearAllMocks()
			mockGlobalState.get.mockImplementation((key: string) => {
				if (key === "apiProvider") {
					return "roo"
				}
				if (key === "apiModelId") {
					return "roo/code-supernova"
				}
				if (key === "rooApiKey") {
					return "router-key"
				}
				return undefined
			})

			const proxyWithRooProvider = new ContextProxy(mockContext)
			await proxyWithRooProvider.initialize()

			expect(mockGlobalState.update).toHaveBeenCalledWith("apiProvider", undefined)
			expect(mockGlobalState.update).toHaveBeenCalledWith("apiModelId", undefined)
			expect(mockGlobalState.update).toHaveBeenCalledWith("rooApiKey", undefined)
		})

		it("should clear invalid apiProvider from storage during initialization", async () => {
			// Reset and create a new proxy with invalid provider in state
			clearAllMocks()
			mockGlobalState.get.mockImplementation((key: string) => {
				if (key === "apiProvider") {
					return "invalid-removed-provider" // Invalid/removed provider
				}
				return undefined
			})

			const proxyWithInvalidProvider = new ContextProxy(mockContext)
			await proxyWithInvalidProvider.initialize()

			// Should have cleared the invalid apiProvider
			expect(mockGlobalState.update).toHaveBeenCalledWith("apiProvider", undefined)
		})

		it("should not clear retired apiProvider from storage during initialization", async () => {
			// Reset and create a new proxy with retired provider in state
			clearAllMocks()
			mockGlobalState.get.mockImplementation((key: string) => {
				if (key === "apiProvider") {
					return "groq" // Retired provider
				}
				return undefined
			})

			const proxyWithRetiredProvider = new ContextProxy(mockContext)
			await proxyWithRetiredProvider.initialize()

			// Should NOT have called update for apiProvider (retired should be preserved)
			const updateCalls = mockGlobalState.update.mock.calls
			const apiProviderUpdateCalls = updateCalls.filter((call: unknown[]) => call[0] === "apiProvider")
			expect(apiProviderUpdateCalls).toHaveLength(0)
		})

		it("should not modify valid apiProvider during initialization", async () => {
			// Reset and create a new proxy with valid provider in state
			clearAllMocks()
			mockGlobalState.get.mockImplementation((key: string) => {
				if (key === "apiProvider") {
					return "anthropic" // Valid provider
				}
				return undefined
			})

			const proxyWithValidProvider = new ContextProxy(mockContext)
			await proxyWithValidProvider.initialize()

			// Should NOT have called update for apiProvider (it's valid)
			const updateCalls = mockGlobalState.update.mock.calls
			const apiProviderUpdateCalls = updateCalls.filter((call: unknown[]) => call[0] === "apiProvider")
			expect(apiProviderUpdateCalls.length).toBe(0)
		})
	})

	describe("getProviderSettings", () => {
		it("should sanitize invalid apiProvider before parsing", async () => {
			// Reset and create a new proxy with an unknown provider in state
			clearAllMocks()
			mockGlobalState.get.mockImplementation((key: string) => {
				if (key === "apiProvider") {
					return "invalid-removed-provider"
				}
				if (key === "apiModelId") {
					return "some-model"
				}
				return undefined
			})

			const proxyWithInvalidProvider = new ContextProxy(mockContext)
			await proxyWithInvalidProvider.initialize()

			const settings = proxyWithInvalidProvider.getProviderSettings()

			// The invalid apiProvider should be sanitized (removed)
			expect(settings.apiProvider).toBeUndefined()
			// Other settings should still be present
			expect(settings.apiModelId).toBe("some-model")
		})

		it("should preserve retired apiProvider and provider fields", async () => {
			await proxy.setValues({
				apiProvider: retiredProviderIdentifiers.groq,
				apiModelId: "llama3-70b",
				openAiBaseUrl: "https://api.retired-provider.example/v1",
				apiKey: "retired-provider-key",
			})

			const settings = proxy.getProviderSettings()

			expect(settings.apiProvider).toBe("groq")
			expect(settings.apiModelId).toBe("llama3-70b")
			expect(settings.openAiBaseUrl).toBe("https://api.retired-provider.example/v1")
			expect(settings.apiKey).toBe("retired-provider-key")
		})

		it("should pass through valid apiProvider", async () => {
			// Set a valid provider in state
			await proxy.updateGlobalState("apiProvider", "anthropic")
			await proxy.updateGlobalState("apiModelId", "claude-3-opus-20240229")

			const settings = proxy.getProviderSettings()

			// Valid provider should be returned
			expect(settings.apiProvider).toBe("anthropic")
			expect(settings.apiModelId).toBe("claude-3-opus-20240229")
		})

		it("should handle undefined apiProvider gracefully", async () => {
			// Ensure no provider is set
			await proxy.updateGlobalState("apiProvider", undefined)

			const settings = proxy.getProviderSettings()

			// Should not throw and should return undefined
			expect(settings.apiProvider).toBeUndefined()
		})
	})

	describe("old default condensing prompt migration", () => {
		// The old v1 default condensing prompt from before PR #10873
		const OLD_V1_DEFAULT_CONDENSE_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing with the conversation and supporting any continuing tasks.

Your summary should be structured as follows:
Context: The context to continue the conversation with. If applicable based on the current task, this should include:
		1. Previous Conversation: High level details about what was discussed throughout the entire conversation with the user. This should be written to allow someone to be able to follow the general overarching conversation flow.
		2. Current Work: Describe in detail what was being worked on prior to this request to summarize the conversation. Pay special attention to the more recent messages in the conversation.
		3. Key Technical Concepts: List all important technical concepts, technologies, coding conventions, and frameworks discussed, which might be relevant for continuing with this work.
		4. Relevant Files and Code: If applicable, enumerate specific files and code sections examined, modified, or created for the task continuation. Pay special attention to the most recent messages and changes.
		5. Problem Solving: Document problems solved thus far and any ongoing troubleshooting efforts.
		6. Pending Tasks and Next Steps: Outline all pending tasks that you have explicitly been asked to work on, as well as list the next steps you will take for all outstanding work, if applicable. Include code snippets where they add clarity. For any next steps, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off. This should be verbatim to ensure there's no information loss in context between tasks.

Example summary structure:
1. Previous Conversation:
		[Detailed description]
2. Current Work:
		[Detailed description]
3. Key Technical Concepts:
		- [Concept 1]
		- [Concept 2]
		- [...]
4. Relevant Files and Code:
		- [File Name 1]
	- [Summary of why this file is important]
	- [Summary of the changes made to this file, if any]
	- [Important Code Snippet]
		- [File Name 2]
	- [Important Code Snippet]
		- [...]
5. Problem Solving:
		[Detailed description]
6. Pending Tasks and Next Steps:
		- [Task 1 details & next steps]
		- [Task 2 details & next steps]
		- [...]

Output only the summary of the conversation so far, without any additional commentary or explanation.`

		it("should clear old v1 default condensing prompt from customSupportPrompts during initialization", async () => {
			// Reset and create a new proxy with old v1 default prompt in customSupportPrompts
			clearAllMocks()
			mockGlobalState.get.mockImplementation((key: string) => {
				if (key === "customSupportPrompts") {
					return { CONDENSE: OLD_V1_DEFAULT_CONDENSE_PROMPT }
				}
				return undefined
			})

			const proxyWithOldDefault = new ContextProxy(mockContext)
			await proxyWithOldDefault.initialize()

			// Should have cleared the old default by updating customSupportPrompts to undefined
			// (since CONDENSE was the only key)
			expect(mockGlobalState.update).toHaveBeenCalledWith("customSupportPrompts", undefined)
		})

		it("should preserve other custom prompts when clearing old v1 default", async () => {
			// Reset and create a new proxy with old v1 default plus other custom prompts
			clearAllMocks()
			mockGlobalState.get.mockImplementation((key: string) => {
				if (key === "customSupportPrompts") {
					return {
						CONDENSE: OLD_V1_DEFAULT_CONDENSE_PROMPT,
						EXPLAIN: "Custom explain prompt",
					}
				}
				return undefined
			})

			const proxyWithOldDefault = new ContextProxy(mockContext)
			await proxyWithOldDefault.initialize()

			// Should have updated customSupportPrompts to keep EXPLAIN but remove CONDENSE
			expect(mockGlobalState.update).toHaveBeenCalledWith("customSupportPrompts", {
				EXPLAIN: "Custom explain prompt",
			})
		})

		it("should not clear truly customized condensing prompts", async () => {
			// Reset and create a new proxy with a truly customized condensing prompt
			clearAllMocks()
			const customPrompt = "My custom condensing instructions"
			mockGlobalState.get.mockImplementation((key: string) => {
				if (key === "customSupportPrompts") {
					return { CONDENSE: customPrompt }
				}
				return undefined
			})

			const proxyWithCustomPrompt = new ContextProxy(mockContext)
			await proxyWithCustomPrompt.initialize()

			// Should NOT have called update for customSupportPrompts (custom prompt should be preserved)
			const updateCalls = mockGlobalState.update.mock.calls
			const customSupportPromptsUpdateCalls = updateCalls.filter(
				(call: any[]) => call[0] === "customSupportPrompts",
			)
			expect(customSupportPromptsUpdateCalls.length).toBe(0)
		})

		it("should not fail when customSupportPrompts is undefined", async () => {
			// Reset and create a new proxy with no customSupportPrompts
			clearAllMocks()
			mockGlobalState.get.mockReturnValue(undefined)

			const proxyWithNoPrompts = new ContextProxy(mockContext)
			await proxyWithNoPrompts.initialize()

			// Should not have called update for customSupportPrompts
			const updateCalls = mockGlobalState.update.mock.calls
			const customSupportPromptsUpdateCalls = updateCalls.filter(
				(call: any[]) => call[0] === "customSupportPrompts",
			)
			expect(customSupportPromptsUpdateCalls.length).toBe(0)
		})
	})

	it("keeps host-owned viewStates out of a configuration write and stores every other key", async () => {
		// Every caller of setValues takes input that did not originate inside the extension host - a posted
		// updateSettings, a newTask taskConfiguration, the external API, an imported settings file - so the
		// guard has to live on this path rather than at whichever caller a reviewer happened to point at.
		const viewStates = { "sidebar-1": { claimToken: "token-a", updatedAt: 1 } }
		await proxy.setValues({ mode: "code", viewStates })

		expect(mockGlobalState.update).toHaveBeenCalledWith("mode", "code")
		const viewStatesWrites = mockGlobalState.update.mock.calls.filter((call: unknown[]) => call[0] === "viewStates")
		expect(viewStatesWrites).toHaveLength(0)
		expect(proxy.getValue("viewStates")).toBeUndefined()
	})

	it("still persists viewStates written through the host-only setValue path", async () => {
		// The filter above exists so the host can keep writing its own map: closing both paths would strand
		// every per-view selection.
		const viewStates = { "sidebar-1": { claimToken: "token-a", updatedAt: 1 } }
		await proxy.setValue("viewStates", viewStates)

		expect(mockGlobalState.update).toHaveBeenCalledWith("viewStates", viewStates)
		expect(proxy.getValue("viewStates")).toEqual(viewStates)
	})
})
