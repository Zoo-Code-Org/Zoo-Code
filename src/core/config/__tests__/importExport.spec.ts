// npx vitest src/core/config/__tests__/importExport.spec.ts

import fs from "fs/promises"
import * as path from "path"

import * as vscode from "vscode"

import { TelemetryService } from "@roo-code/telemetry"

import { clearAllMocks } from "../../../test-utils/reset"
import { makeExtensionContext } from "../../../test-utils/vscode"

import {
	importSettings,
	importSettingsFromFile,
	importSettingsFromPath,
	importSettingsWithFeedback,
	exportSettings,
} from "../importExport"
import type { SettingsImportRefresh } from "../importExport"
import { ProviderSettingsManager } from "../ProviderSettingsManager"
import { ContextProxy, SettingsWriteError } from "../ContextProxy"
import {
	beginSettingWrite,
	disposeSettingWrites,
	performSettingWrite,
	writeValuesThroughWriteChain,
	settingWriteBookkeepingSize,
	undoSettingWrite,
} from "../appearanceSettingWrites"

/** A write that throws the failure, as the report gives it: what the tests of the write chain read. */
const setValuesThroughWriteChain = async (...args: Parameters<typeof writeValuesThroughWriteChain>) => {
	const { failure } = await writeValuesThroughWriteChain(...args)
	if (failure) throw failure.reason
}
import { CustomModesManager } from "../CustomModesManager"
import { safeWriteJson } from "../../../utils/safeWriteJson"

import type { Mock } from "vitest"
import { providerIdentifiers, retiredProviderIdentifiers } from "@roo-code/types/provider-identifiers"

function createDeferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise
	})
	return { promise, resolve }
}

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn(),
		}),
	},
	window: {
		showOpenDialog: vi.fn(),
		showSaveDialog: vi.fn(),
		showErrorMessage: vi.fn(),
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
	},
	Uri: {
		file: vi.fn((filePath) => ({ fsPath: filePath })),
	},
}))

vi.mock("fs/promises", () => ({
	default: {
		readFile: vi.fn(),
		mkdir: vi.fn(),
		writeFile: vi.fn(),
		access: vi.fn(),
		constants: {
			F_OK: 0,
			R_OK: 4,
		},
	},
	readFile: vi.fn(),
	mkdir: vi.fn(),
	writeFile: vi.fn(),
	access: vi.fn(),
	constants: {
		F_OK: 0,
		R_OK: 4,
	},
}))

vi.mock("os", () => ({
	default: {
		homedir: vi.fn(() => "/mock/home"),
	},
	homedir: vi.fn(() => "/mock/home"),
}))

vi.mock("../../../utils/safeWriteJson")

// Mock buildApiHandler to avoid issues with provider instantiation in tests
vi.mock("../../../api", () => ({
	buildApiHandler: vi.fn().mockImplementation((config) => {
		// Return different model info based on the provider and model
		const getModelInfo = () => {
			if (
				config.apiProvider === providerIdentifiers.anthropic &&
				config.apiModelId === "claude-3-5-sonnet-20241022"
			) {
				return {
					id: "claude-3-5-sonnet-20241022",
					info: {
						supportsReasoningBudget: true,
						requiredReasoningBudget: true,
					},
				}
			}
			// Default fallback
			return {
				id: config.apiModelId || "claude-sonnet-4-5",
				info: {
					supportsReasoningBudget: false,
					requiredReasoningBudget: false,
				},
			}
		}

		return {
			getModel: vi.fn().mockReturnValue(getModelInfo()),
		}
	}),
}))

describe("importExport", () => {
	let mockProviderSettingsManager: ReturnType<typeof vi.mocked<ProviderSettingsManager>>
	let mockContextProxy: ReturnType<typeof vi.mocked<ContextProxy>>
	let mockExtensionContext: vscode.ExtensionContext
	let mockCustomModesManager: ReturnType<typeof vi.mocked<CustomModesManager>>

	beforeEach(() => {
		clearAllMocks()

		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		mockProviderSettingsManager = {
			export: vi.fn(),
			import: vi.fn(),
			listConfig: vi.fn(),
		} as unknown as ReturnType<typeof vi.mocked<ProviderSettingsManager>>

		mockContextProxy = {
			setValues: vi.fn(),
			setValue: vi.fn(),
			export: vi.fn().mockImplementation(() => {
				return Promise.resolve({})
			}),
			setProviderSettings: vi.fn(),
			getValue: vi.fn(),
		} as unknown as ReturnType<typeof vi.mocked<ContextProxy>>

		mockCustomModesManager = { updateCustomMode: vi.fn() } as unknown as ReturnType<
			typeof vi.mocked<CustomModesManager>
		>

		const map = new Map<string, string>()

		// Secrets are Map-backed so real ProviderSettingsManager instances can
		// round-trip configs; the rest of the context comes from the shared builder.
		const baseContext = makeExtensionContext()
		mockExtensionContext = makeExtensionContext({
			secrets: {
				...baseContext.secrets,
				get: vi.fn().mockImplementation((key: string) => {
					return map.get(key)
				}),
				store: vi.fn().mockImplementation((key: string, value: string) => {
					return map.set(key, value)
				}),
			},
		})
	})

	describe("importSettingsFromPath persistence", () => {
		const validFileContent = JSON.stringify({
			providerProfiles: {
				currentApiConfigName: "test",
				apiConfigs: {
					test: { apiProvider: providerIdentifiers.openai, apiKey: "test-key", id: "test-id" },
				},
			},
			globalSettings: { mode: "code" },
		})
		const previousProviderProfiles = {
			currentApiConfigName: "default",
			apiConfigs: { default: { apiProvider: providerIdentifiers.anthropic, id: "default-id" } },
		}
		const profileMetadata = [
			{ name: "test", id: "test-id", apiProvider: providerIdentifiers.openai },
			{ name: "default", id: "default-id", apiProvider: providerIdentifiers.anthropic },
		]

		beforeEach(() => {
			;(fs.readFile as Mock).mockResolvedValue(validFileContent)
			mockProviderSettingsManager.export.mockResolvedValue(previousProviderProfiles)
			mockProviderSettingsManager.import.mockResolvedValue(undefined)
			mockProviderSettingsManager.listConfig.mockResolvedValue(profileMetadata)
			mockContextProxy.setValues.mockResolvedValue(undefined)
			mockContextProxy.setValue.mockResolvedValue(undefined)
			mockContextProxy.setProviderSettings.mockResolvedValue(undefined)
		})

		it("waits for each provider-state write before reporting success", async () => {
			const currentProfileWrite = createDeferred<void>()
			const providerSettingsWrite = createDeferred<void>()
			const profileMetadataWrite = createDeferred<void>()
			mockContextProxy.setValue.mockImplementation((key) => {
				if (key === "currentApiConfigName") return currentProfileWrite.promise
				if (key === "listApiConfigMeta") return profileMetadataWrite.promise
				return Promise.resolve()
			})
			mockContextProxy.setProviderSettings.mockReturnValue(providerSettingsWrite.promise)

			const resultPromise = importSettingsFromPath("/mock/path/settings.json", {
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
				customModesManager: mockCustomModesManager,
			})
			let settled = false
			void resultPromise.then(() => {
				settled = true
			})

			await vi.waitFor(() =>
				expect(mockContextProxy.setValue).toHaveBeenCalledWith("currentApiConfigName", "test"),
			)
			expect(mockContextProxy.setProviderSettings).not.toHaveBeenCalled()
			expect(settled).toBe(false)

			currentProfileWrite.resolve()
			await vi.waitFor(() => expect(mockContextProxy.setProviderSettings).toHaveBeenCalled())
			expect(mockContextProxy.setValue).not.toHaveBeenCalledWith("listApiConfigMeta", expect.anything())
			expect(settled).toBe(false)

			providerSettingsWrite.resolve()
			await vi.waitFor(() =>
				expect(mockContextProxy.setValue).toHaveBeenCalledWith("listApiConfigMeta", profileMetadata),
			)
			expect(settled).toBe(false)

			profileMetadataWrite.resolve()
			await expect(resultPromise).resolves.toMatchObject({ success: true })
		})

		it("reports failure without continuing after a provider-state write rejects", async () => {
			mockContextProxy.setValue.mockRejectedValueOnce(new Error("current profile write failed"))

			const result = await importSettingsFromPath("/mock/path/settings.json", {
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
				customModesManager: mockCustomModesManager,
			})

			expect(result).toEqual({
				success: false,
				error: "current profile write failed",
				settingsMayHaveChanged: true,
			})
			expect(mockContextProxy.setProviderSettings).not.toHaveBeenCalled()
			expect(mockContextProxy.setValue).not.toHaveBeenCalledWith("listApiConfigMeta", expect.anything())
		})
	})

	describe("importSettings", () => {
		it("should return success: false when user cancels file selection", async () => {
			;(vscode.window.showOpenDialog as Mock).mockResolvedValue(undefined)

			const result = await importSettings({
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
				customModesManager: mockCustomModesManager,
			})

			expect(result).toEqual({ success: false, error: "User cancelled file selection" })

			expect(vscode.window.showOpenDialog).toHaveBeenCalledWith({
				filters: { JSON: ["json"] },
				canSelectMany: false,
				defaultUri: expect.anything(), // Defaults to Downloads or last export path
			})

			expect(fs.readFile).not.toHaveBeenCalled()
			expect(mockProviderSettingsManager.import).not.toHaveBeenCalled()
			expect(mockContextProxy.setValues).not.toHaveBeenCalled()
		})

		describe("appearance settings go through the write chain of the saves", () => {
			const stored = new Map<string, unknown>()

			const importWith = (globalSettings: Record<string, unknown>) => {
				;(fs.readFile as Mock).mockResolvedValue(
					JSON.stringify({
						providerProfiles: {
							currentApiConfigName: "test",
							apiConfigs: {
								test: { apiProvider: providerIdentifiers.openai, apiKey: "test-key", id: "test-id" },
							},
						},
						globalSettings,
					}),
				)
				return importSettingsFromPath("/mock/path/settings.json", {
					providerSettingsManager: mockProviderSettingsManager,
					contextProxy: mockContextProxy,
					customModesManager: mockCustomModesManager,
				})
			}

			beforeEach(() => {
				stored.clear()
				stored.set("interfaceFontScale", 100)
				mockProviderSettingsManager.export.mockResolvedValue({
					currentApiConfigName: "default",
					apiConfigs: { default: { apiProvider: providerIdentifiers.anthropic, id: "default-id" } },
				})
				mockProviderSettingsManager.import.mockResolvedValue(undefined)
				mockProviderSettingsManager.listConfig.mockResolvedValue([])
				mockContextProxy.setProviderSettings.mockResolvedValue(undefined)
				mockContextProxy.getValue.mockImplementation(((key: string) =>
					stored.get(key)) as unknown as typeof mockContextProxy.getValue)
				mockContextProxy.setValue.mockImplementation((async (key: string, value: unknown) => {
					stored.set(key, value)
				}) as unknown as typeof mockContextProxy.setValue)
				mockContextProxy.setValues.mockResolvedValue(undefined)
			})

			it("stores an appearance value as a recorded write, and the rest through setValues", async () => {
				const result = await importWith({ interfaceFontScale: 120, mode: "code" })

				expect(result).toMatchObject({ success: true })
				expect(stored.get("interfaceFontScale")).toBe(120)
				expect(mockContextProxy.setValues).toHaveBeenCalledWith({ mode: "code" }, expect.any(Function))
				expect(settingWriteBookkeepingSize()).toEqual({ latestWrites: 0, queuedKeys: 0 })
			})

			type ImportMarks = {
				postStateToWebview: (refresh?: SettingsImportRefresh) => Promise<void>
			}

			describe("when a write of the import times out and is rolled back after the import was answered", () => {
				beforeEach(() => vi.useFakeTimers())
				afterEach(() => vi.useRealTimers())

				const importWithFeedback = async (
					postStateToWebview: () => Promise<void>,
					viaDialog = false,
					provider: ImportMarks = { postStateToWebview },
					waitForAnswer = true,
				) => {
					;(fs.access as Mock).mockResolvedValue(undefined)
					;(fs.readFile as Mock).mockResolvedValue(
						JSON.stringify({
							providerProfiles: {
								currentApiConfigName: "test",
								apiConfigs: {
									test: {
										apiProvider: providerIdentifiers.openai,
										apiKey: "test-key",
										id: "test-id",
									},
								},
							},
							globalSettings: { interfaceFontScale: 120 },
						}),
					)
					// The store of the value starts, and lands only when it is released: after the import timed out.
					const release = createDeferred<void>()
					mockContextProxy.setValue.mockImplementation((async (key: string, value: unknown) => {
						if (value === 120) {
							await release.promise
						}
						stored.set(key, value)
					}) as unknown as typeof mockContextProxy.setValue)
					const showErrorMessage = vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined)

					;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/settings.json" }])
					const done = importSettingsWithFeedback(
						{
							providerSettingsManager: mockProviderSettingsManager,
							contextProxy: mockContextProxy,
							customModesManager: mockCustomModesManager,
							provider,
						},
						viaDialog ? undefined : "/mock/path/settings.json",
					)
					await vi.advanceTimersByTimeAsync(15_000)
					// A refresh that is still being posted holds the answer: a test that wants it so does not wait for it.
					if (waitForAnswer) await done
					return { release, showErrorMessage, provider, done }
				}

				it.each([
					["a file path", false],
					["the file dialog", true],
				])(
					"shows the webview what is stored once the rollback has run, for an import from %s",
					async (_name, viaDialog) => {
						const postStateToWebview = vi.fn().mockResolvedValue(undefined)
						const { release, showErrorMessage } = await importWithFeedback(postStateToWebview, viaDialog)
						const refreshesWhenAnswered = postStateToWebview.mock.calls.length

						release.resolve() // the late store lands, and its rollback runs behind it
						await vi.advanceTimersByTimeAsync(0)

						expect(showErrorMessage).toHaveBeenCalled() // the import was answered as failed
						expect(stored.get("interfaceFontScale")).toBe(100)
						expect(postStateToWebview.mock.calls.length).toBe(refreshesWhenAnswered + 1)
						showErrorMessage.mockRestore()
					},
				)

				it.each([
					["a file path", false],
					["the file dialog", true],
				])(
					"does not call back into a provider that was disposed meanwhile, for an import from %s",
					async (_name, viaDialog) => {
						const postStateToWebview = vi.fn().mockResolvedValue(undefined)
						const { release, showErrorMessage, provider } = await importWithFeedback(
							postStateToWebview,
							viaDialog,
						)
						const refreshesWhenAnswered = postStateToWebview.mock.calls.length

						disposeSettingWrites(provider) // the view is closed before the late store lands
						release.resolve()
						await vi.advanceTimersByTimeAsync(0)

						expect(stored.get("interfaceFontScale")).toBe(100) // the value is still put back
						expect(postStateToWebview.mock.calls.length).toBe(refreshesWhenAnswered)
						showErrorMessage.mockRestore()
					},
				)

				it("marks the refresh after the rollback for the settings form too, with the uncertain settings, as another refresh", async () => {
					const seen: Array<SettingsImportRefresh | undefined> = []
					const provider: ImportMarks = {
						postStateToWebview: vi.fn(async (refresh?: SettingsImportRefresh) => {
							seen.push(refresh)
						}),
					}
					const { release, showErrorMessage } = await importWithFeedback(
						provider.postStateToWebview,
						false,
						provider,
					)
					expect(seen).toHaveLength(1) // the answer of the import: the form takes the value that failed to be stored
					expect(seen[0]).toMatchObject({ storedKeys: ["interfaceFontScale"], late: false })

					release.resolve()
					await vi.advanceTimersByTimeAsync(0)

					expect(seen).toHaveLength(2) // the rollback is over: the form takes the value that is really stored
					expect(seen[1]).toMatchObject({ storedKeys: ["interfaceFontScale"], late: true }) // a late refresh
					expect(seen[1]!.at).toBeGreaterThan(seen[0]!.at) // not the refresh that the form handled already
					expect(stored.get("interfaceFontScale")).toBe(100)
					showErrorMessage.mockRestore()
				})

				it("gives two refreshes in the same millisecond different marks", async () => {
					vi.setSystemTime(1_000_000)
					const seen: number[] = []
					const provider: ImportMarks = {
						postStateToWebview: vi.fn(async (refresh?: SettingsImportRefresh) => {
							seen.push(refresh!.at)
						}),
					}
					const { release, showErrorMessage } = await importWithFeedback(
						provider.postStateToWebview,
						false,
						provider,
					)
					vi.setSystemTime(Date.now() - 15_000) // as if the clock had not moved since the answer
					release.resolve()
					await vi.advanceTimersByTimeAsync(0)

					expect(seen).toHaveLength(2)
					expect(new Set(seen).size).toBe(2)
					showErrorMessage.mockRestore()
				})

				it("gives every refresh its own marks when they overlap: a slow post does not clear, or take, the marks of another", async () => {
					const posts: Array<{ refresh?: SettingsImportRefresh; finish: () => void }> = []
					const provider: ImportMarks = {
						postStateToWebview: vi.fn(
							(refresh?: SettingsImportRefresh) =>
								new Promise<void>((resolve) => posts.push({ refresh, finish: resolve })),
						),
					}
					const { release, showErrorMessage, done } = await importWithFeedback(
						provider.postStateToWebview,
						false,
						provider,
						false,
					)

					// The refresh for the answer is still being posted when the rollback finishes.
					expect(posts).toHaveLength(1)
					release.resolve()
					await vi.advanceTimersByTimeAsync(0)
					expect(posts).toHaveLength(2)

					// Each post carries the marks of its own refresh, whatever order they end in.
					posts[1].finish()
					posts[0].finish()
					await done
					await vi.advanceTimersByTimeAsync(0)
					expect(posts[0].refresh).toMatchObject({ storedKeys: ["interfaceFontScale"], late: false })
					expect(posts[1].refresh).toMatchObject({ storedKeys: ["interfaceFontScale"], late: true })
					expect(posts[1].refresh!.at).toBeGreaterThan(posts[0].refresh!.at)
					showErrorMessage.mockRestore()
				})

				it("keeps the answer of the import when that refresh fails", async () => {
					const unhandled: unknown[] = []
					const onUnhandled = (reason: unknown) => unhandled.push(reason)
					process.on("unhandledRejection", onUnhandled)
					let failRefresh = false
					const attempts: boolean[] = []
					// A plain function: a mock that rejects would be reported by the mock itself.
					const postStateToWebview = () => {
						attempts.push(failRefresh)
						return failRefresh ? Promise.reject(new Error("webview is gone")) : Promise.resolve()
					}
					const { release, showErrorMessage } = await importWithFeedback(postStateToWebview)

					failRefresh = true
					release.resolve()
					await vi.advanceTimersByTimeAsync(0)
					await vi.advanceTimersByTimeAsync(0)
					process.off("unhandledRejection", onUnhandled)

					expect(attempts).toContain(true) // the refresh was tried, and failed
					expect(unhandled).toEqual([])
					expect(stored.get("interfaceFontScale")).toBe(100)
					showErrorMessage.mockRestore()
				})
			})

			it("keeps an imported value when a save that wrote the same value fails afterwards", async () => {
				const save = beginSettingWrite("interfaceFontScale", 100, 120)
				await performSettingWrite(mockContextProxy as unknown as ContextProxy, save)

				await importWith({ interfaceFontScale: 120 }) // the same value, while the save is pending
				await undoSettingWrite(mockContextProxy as unknown as ContextProxy, save) // the save fails

				expect(stored.get("interfaceFontScale")).toBe(120)
			})

			it("undoes a write that failed, so an earlier save still pending keeps its own rollback", async () => {
				const proxy = mockContextProxy as unknown as ContextProxy
				const save = beginSettingWrite("interfaceFontScale", 100, 150)
				await performSettingWrite(proxy, save) // a save has stored 150 and is still pending

				mockContextProxy.setValue.mockImplementation((async (key: string, value: unknown) => {
					if (value === 120) throw new Error("storage unavailable") // the import's write fails
					stored.set(key, value)
				}) as unknown as typeof mockContextProxy.setValue)
				const result = await importWith({ interfaceFontScale: 120 })
				expect(result).toEqual({ success: false, error: "storage unavailable", settingsMayHaveChanged: true })

				await undoSettingWrite(proxy, save) // the save fails afterwards

				expect(stored.get("interfaceFontScale")).toBe(100)
				expect(settingWriteBookkeepingSize()).toEqual({ latestWrites: 0, queuedKeys: 0 })
			})

			it("names the other settings that were stored and those that were not, when the store says which", async () => {
				mockContextProxy.setValues.mockRejectedValue(
					new SettingsWriteError(["mode"], ["autoApprovalEnabled"], new Error("secret storage unavailable")),
				)
				mockContextProxy.setValue.mockImplementation((async (_key: string, value: unknown) => {
					if (value === 120) throw new Error("failed after storing")
				}) as unknown as typeof mockContextProxy.setValue)

				const result = await importWith({ interfaceFontScale: 120, terminalFontSize: 14, mode: "code" })

				expect(result).toEqual({
					success: false,
					settingsMayHaveChanged: true,
					storedSettings: ["mode", "terminalFontSize"],
					error: "secret storage unavailable (not stored: autoApprovalEnabled, interfaceFontScale; stored: mode, terminalFontSize)",
				})
			})

			it("names the other settings that were stored when an appearance value is what failed", async () => {
				mockContextProxy.setValue.mockImplementation((async (_key: string, value: unknown) => {
					if (value === 120) throw new Error("failed after storing")
				}) as unknown as typeof mockContextProxy.setValue)

				const result = await importWith({ interfaceFontScale: 120, mode: "code" })

				expect(result).toEqual({
					success: false,
					settingsMayHaveChanged: true,
					storedSettings: ["mode"],
					error: "failed after storing (not stored: interfaceFontScale; stored: mode)",
				})
			})

			it("names the other settings that were stored too when only they fail, with no appearance value", async () => {
				mockContextProxy.setValues.mockRejectedValue(
					new SettingsWriteError(["mode"], ["autoApprovalEnabled"], new Error("secret storage unavailable")),
				)

				const result = await importWith({ mode: "code", autoApprovalEnabled: true })

				expect(result).toEqual({
					success: false,
					settingsMayHaveChanged: true,
					storedSettings: ["mode"],
					error: "secret storage unavailable (not stored: autoApprovalEnabled; stored: mode)",
				})
			})

			it("keeps the appearance values that were stored when the other settings fail to store", async () => {
				mockContextProxy.setValues.mockRejectedValue(new Error("other settings failed"))

				const result = await importWith({ interfaceFontScale: 120, mode: "code" })

				expect(result).toEqual({
					success: false,
					settingsMayHaveChanged: true,
					storedSettings: ["interfaceFontScale"],
					error: "other settings failed (not stored: the other settings; stored: interfaceFontScale)",
				})
				expect(stored.get("interfaceFontScale")).toBe(120)
				expect(settingWriteBookkeepingSize()).toEqual({ latestWrites: 0, queuedKeys: 0 })
			})

			it("names every setting that was not stored when several fail, and says that nothing else was stored", async () => {
				mockContextProxy.setValue.mockImplementation((async () => {
					throw new Error("storage unavailable")
				}) as unknown as typeof mockContextProxy.setValue)

				const result = await importWith({ interfaceFontScale: 120, terminalFontSize: 14 })

				expect(result).toEqual({
					success: false,
					settingsMayHaveChanged: true,
					error: "storage unavailable (not stored: interfaceFontScale, terminalFontSize; stored: none)",
				})
				expect(stored.get("interfaceFontScale")).toBe(100)
			})

			it("names the other settings as not stored too when they fail together with an appearance value", async () => {
				mockContextProxy.setValues.mockRejectedValue(new Error("other settings failed"))
				mockContextProxy.setValue.mockImplementation((async (_key: string, value: unknown) => {
					if (value === 120) throw new Error("failed after storing")
				}) as unknown as typeof mockContextProxy.setValue)

				const result = await importWith({ interfaceFontScale: 120, mode: "code" })

				expect(result).toEqual({
					success: false,
					settingsMayHaveChanged: true,
					error: "other settings failed (not stored: the other settings, interfaceFontScale; stored: none)",
				})
			})

			describe("an import that failed part of the way, through importSettingsWithFeedback", () => {
				const importFailing = async (
					postStateToWebview: () => Promise<void>,
					provider: { postStateToWebview: (refresh?: SettingsImportRefresh) => Promise<void> } = {
						postStateToWebview,
					},
					globalSettings: Record<string, unknown> = { interfaceFontScale: 120, mode: "code" },
				) => {
					;(fs.access as Mock).mockResolvedValue(undefined)
					;(fs.readFile as Mock).mockResolvedValue(
						JSON.stringify({
							providerProfiles: {
								currentApiConfigName: "test",
								apiConfigs: {
									test: {
										apiProvider: providerIdentifiers.openai,
										apiKey: "test-key",
										id: "test-id",
									},
								},
							},
							globalSettings,
						}),
					)
					mockContextProxy.setValues.mockRejectedValue(new Error("other settings failed"))
					const showErrorMessage = vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined)
					await importSettingsWithFeedback(
						{
							providerSettingsManager: mockProviderSettingsManager,
							contextProxy: mockContextProxy,
							customModesManager: mockCustomModesManager,
							provider,
						},
						"/mock/path/settings.json",
					)
					return showErrorMessage
				}

				it("shows the webview what is stored, and tells the user the import failed", async () => {
					const postStateToWebview = vi.fn().mockResolvedValue(undefined)

					const showErrorMessage = await importFailing(postStateToWebview)

					expect(postStateToWebview).toHaveBeenCalledOnce()
					expect(showErrorMessage).toHaveBeenCalledOnce()
					showErrorMessage.mockRestore()
				})

				describe("a failure before the import changed anything", () => {
					const importBeforeAnyChange = async (prepare: () => void, filePath: string | undefined) => {
						prepare()
						const seen: Array<SettingsImportRefresh | undefined> = []
						const provider = {
							postStateToWebview: vi.fn(async (refresh?: SettingsImportRefresh) => {
								seen.push(refresh)
							}),
						}
						const showErrorMessage = vi
							.spyOn(vscode.window, "showErrorMessage")
							.mockResolvedValue(undefined)

						await importSettingsWithFeedback(
							{
								providerSettingsManager: mockProviderSettingsManager,
								contextProxy: mockContextProxy,
								customModesManager: mockCustomModesManager,
								provider,
							},
							filePath,
						)

						return { provider, seen, showErrorMessage }
					}

					it.each([
						[
							"a file that cannot be reached",
							() => (fs.access as Mock).mockRejectedValue(new Error("ENOENT")),
							"/mock/path/settings.json",
						],
						[
							"a file that is not valid",
							() => {
								;(fs.access as Mock).mockResolvedValue(undefined)
								;(fs.readFile as Mock).mockResolvedValue("not json")
							},
							"/mock/path/settings.json",
						],
						[
							"a file with no profile that can be imported",
							() => {
								;(fs.access as Mock).mockResolvedValue(undefined)
								;(fs.readFile as Mock).mockResolvedValue(
									JSON.stringify({
										providerProfiles: {
											currentApiConfigName: "bad",
											apiConfigs: { bad: { apiProvider: providerIdentifiers.openai, id: 42 } }, // not a valid profile
										},
										globalSettings: { mode: "code" },
									}),
								)
							},
							"/mock/path/settings.json",
						],
						[
							"a file dialog that is cancelled",
							() => (vscode.window.showOpenDialog as Mock).mockResolvedValue(undefined),
							undefined,
						],
					])(
						"does not refresh, or mark, anything after %s: the settings are as they were",
						async (_name, prepare, filePath) => {
							const { provider, seen, showErrorMessage } = await importBeforeAnyChange(
								prepare as () => void,
								filePath,
							)

							expect(provider.postStateToWebview).not.toHaveBeenCalled()
							expect(seen).toEqual([])
							showErrorMessage.mockRestore()
						},
					)
				})

				it("marks the refresh for the settings form while it is posted, with the settings that were stored, and only then", async () => {
					const seen: Array<SettingsImportRefresh | undefined> = []
					const provider = {
						postStateToWebview: vi.fn(async (refresh?: SettingsImportRefresh) => {
							seen.push(refresh)
						}),
					}

					const showErrorMessage = await importFailing(provider.postStateToWebview, provider)

					expect(seen).toHaveLength(1)
					expect(seen[0]!.at).toBeGreaterThan(0) // the form is told to take what the import stored
					expect(seen[0]!.storedKeys).toEqual(["interfaceFontScale"]) // and which settings those are
					expect(seen[0]!.late).toBe(false)
					showErrorMessage.mockRestore()
				})

				it("marks the refresh with no settings that were stored when the import stored none of them", async () => {
					const seen: Array<SettingsImportRefresh | undefined> = []
					const provider = {
						postStateToWebview: vi.fn(async (refresh?: SettingsImportRefresh) => {
							seen.push(refresh)
						}),
					}

					// Only settings that are not appearance values: the failed store of them names nothing that was stored.
					const showErrorMessage = await importFailing(provider.postStateToWebview, provider, {
						mode: "code",
					})

					expect(seen).toHaveLength(1)
					expect(seen[0]).toMatchObject({ storedKeys: [], late: false })
					showErrorMessage.mockRestore()
				})

				it("does not mark the state of an import that succeeded as a refresh: that import replaces the form", async () => {
					const seen: Array<SettingsImportRefresh | undefined> = []
					const provider = {
						settingsImportedAt: undefined as number | undefined,
						postStateToWebview: vi.fn(async (refresh?: SettingsImportRefresh) => {
							seen.push(refresh)
						}),
					}
					mockContextProxy.setValues.mockResolvedValue(undefined)
					;(fs.access as Mock).mockResolvedValue(undefined)
					;(fs.readFile as Mock).mockResolvedValue(
						JSON.stringify({
							providerProfiles: {
								currentApiConfigName: "test",
								apiConfigs: {
									test: {
										apiProvider: providerIdentifiers.openai,
										apiKey: "test-key",
										id: "test-id",
									},
								},
							},
							globalSettings: { mode: "code" },
						}),
					)
					const showInfoMessage = vi
						.spyOn(vscode.window, "showInformationMessage")
						.mockResolvedValue(undefined)

					await importSettingsWithFeedback(
						{
							providerSettingsManager: mockProviderSettingsManager,
							contextProxy: mockContextProxy,
							customModesManager: mockCustomModesManager,
							provider,
						},
						"/mock/path/settings.json",
					)

					expect(seen).toEqual([undefined])
					showInfoMessage.mockRestore()
				})

				it("still tells the user when that refresh fails", async () => {
					const postStateToWebview = () => Promise.reject(new Error("webview is gone")) // a plain function: a mock would record it
					const showErrorMessage = await importFailing(postStateToWebview)

					expect(showErrorMessage).toHaveBeenCalledOnce()
					showErrorMessage.mockRestore()
				})
			})

			describe("the report of a write through the chain", () => {
				const proxy = () => mockContextProxy as unknown as ContextProxy

				it("rejects with the original error, whatever else was stored, for the callers that do not report", async () => {
					const failure = new Error("other settings failed")
					mockContextProxy.setValues.mockRejectedValue(failure)

					await expect(
						setValuesThroughWriteChain(proxy(), { interfaceFontScale: 120, mode: "code" }),
					).rejects.toBe(failure)
					expect(stored.get("interfaceFontScale")).toBe(120)
				})

				it("names what was stored and what was not, with the first failure", async () => {
					const failure = new Error("other settings failed")
					mockContextProxy.setValues.mockRejectedValue(failure)

					const report = await writeValuesThroughWriteChain(proxy(), {
						interfaceFontScale: 120,
						mode: "code",
					})

					expect(report).toEqual({
						failure: { reason: failure },
						stored: ["interfaceFontScale"],
						notStored: ["the other settings"],
						uncertain: [],
					})
				})

				it("reports nothing when everything was stored, and a failure of settings without an appearance value", async () => {
					expect(await writeValuesThroughWriteChain(proxy(), { interfaceFontScale: 120 })).toEqual({
						stored: ["interfaceFontScale"],
						notStored: [],
						uncertain: [],
						failure: undefined,
					})

					const failure = new Error("other settings failed")
					mockContextProxy.setValues.mockRejectedValue(failure)
					expect(await writeValuesThroughWriteChain(proxy(), { mode: "code" })).toEqual({
						failure: { reason: failure },
						stored: [],
						notStored: ["the other settings"],
						uncertain: [],
					})
				})
			})

			it("stores every appearance value of an import that has several", async () => {
				const result = await importWith({ interfaceFontScale: 120, terminalFontSize: 14, spacingScale: 90 })

				expect(result).toMatchObject({ success: true })
				expect(stored.get("interfaceFontScale")).toBe(120)
				expect(stored.get("terminalFontSize")).toBe(14)
				expect(stored.get("spacingScale")).toBe(90)
				expect(settingWriteBookkeepingSize()).toEqual({ latestWrites: 0, queuedKeys: 0 })
			})

			it("puts back only the value whose write failed after storing it, when another appearance write succeeds", async () => {
				mockContextProxy.setValue.mockImplementation((async (key: string, value: unknown) => {
					stored.set(key, value)
					if (key === "interfaceFontScale" && value === 120) throw new Error("failed after storing")
				}) as unknown as typeof mockContextProxy.setValue)

				const result = await importWith({ interfaceFontScale: 120, terminalFontSize: 14 })

				expect(result).toEqual({
					success: false,
					settingsMayHaveChanged: true,
					storedSettings: ["terminalFontSize"],
					error: "failed after storing (not stored: interfaceFontScale; stored: terminalFontSize)",
				})
				expect(stored.get("interfaceFontScale")).toBe(100)
				expect(stored.get("terminalFontSize")).toBe(14)
				expect(settingWriteBookkeepingSize()).toEqual({ latestWrites: 0, queuedKeys: 0 })
			})

			it("puts back a value that was stored before its write failed, and still reports the failure", async () => {
				mockContextProxy.setValue.mockImplementation((async (key: string, value: unknown) => {
					stored.set(key, value)
					if (value === 120) throw new Error("failed after storing")
				}) as unknown as typeof mockContextProxy.setValue)

				const result = await importWith({ interfaceFontScale: 120 })

				expect(result).toEqual({ success: false, error: "failed after storing", settingsMayHaveChanged: true })
				expect(stored.get("interfaceFontScale")).toBe(100)
			})

			it("puts back an unset value as unset when the write failed after storing", async () => {
				stored.delete("interfaceFontScale") // cold start: nothing was ever stored for it
				mockContextProxy.setValue.mockImplementation((async (key: string, value: unknown) => {
					stored.set(key, value)
					if (value === 120) throw new Error("failed after storing")
				}) as unknown as typeof mockContextProxy.setValue)

				const result = await importWith({ interfaceFontScale: 120 })

				expect(result).toEqual({ success: false, error: "failed after storing", settingsMayHaveChanged: true })
				expect(stored.get("interfaceFontScale")).toBeUndefined()
				expect(mockContextProxy.setValue).toHaveBeenCalledWith("interfaceFontScale", undefined)
			})

			it("reports a value that could not be put back as uncertain, not as not stored, and names it for the form", async () => {
				const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
				mockContextProxy.setValue.mockImplementation((async (key: string, value: unknown) => {
					if (value === 100) throw new Error("restore failed")
					stored.set(key, value)
					if (value === 120) throw new Error("failed after storing")
				}) as unknown as typeof mockContextProxy.setValue)

				const result = await importWith({ interfaceFontScale: 120 })

				expect(result).toEqual({
					success: false,
					settingsMayHaveChanged: true,
					storedSettings: ["interfaceFontScale"], // the form takes what is really there for it
					error: "failed after storing (not stored: none; stored: none; uncertain, could not be put back: interfaceFontScale)",
				})
				expect(consoleError).toHaveBeenCalledTimes(1)
				expect(consoleError).toHaveBeenCalledWith(
					'Failed to restore setting "interfaceFontScale" after a failed write:',
					expect.objectContaining({ message: "restore failed" }),
				)
				consoleError.mockRestore()
			})

			it("leaves nothing in the chain, and reports the failure, when a write fails", async () => {
				mockContextProxy.setValue.mockRejectedValue(new Error("storage unavailable"))

				const result = await importWith({ interfaceFontScale: 120 })

				expect(result).toEqual({ success: false, error: "storage unavailable", settingsMayHaveChanged: true })
				expect(settingWriteBookkeepingSize()).toEqual({ latestWrites: 0, queuedKeys: 0 })
			})

			it("writes everything through setValues when the file has no appearance value", async () => {
				await importWith({ mode: "code" })

				expect(mockContextProxy.setValues).toHaveBeenCalledWith({ mode: "code" }, expect.any(Function))
				expect(mockContextProxy.setValue).not.toHaveBeenCalledWith("interfaceFontScale", expect.anything())
			})
		})

		it("should import settings successfully from a valid file", async () => {
			;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/settings.json" }])

			const mockFileContent = JSON.stringify({
				providerProfiles: {
					currentApiConfigName: "test",
					apiConfigs: {
						test: { apiProvider: providerIdentifiers.openai, apiKey: "test-key", id: "test-id" },
					},
				},
				globalSettings: { mode: "code", autoApprovalEnabled: true },
			})

			;(fs.readFile as Mock).mockResolvedValue(mockFileContent)

			const previousProviderProfiles = {
				currentApiConfigName: "default",
				apiConfigs: { default: { apiProvider: providerIdentifiers.anthropic, id: "default-id" } },
			}

			mockProviderSettingsManager.export.mockResolvedValue(previousProviderProfiles)

			mockProviderSettingsManager.listConfig.mockResolvedValue([
				{ name: "test", id: "test-id", apiProvider: providerIdentifiers.openai },
				{ name: "default", id: "default-id", apiProvider: providerIdentifiers.anthropic },
			])

			mockContextProxy.export.mockResolvedValue({ mode: "code" })

			const result = await importSettings({
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
				customModesManager: mockCustomModesManager,
			})

			expect(result.success).toBe(true)
			expect(fs.readFile).toHaveBeenCalledWith("/mock/path/settings.json", "utf-8")
			expect(mockProviderSettingsManager.export).toHaveBeenCalled()

			expect(mockProviderSettingsManager.import).toHaveBeenCalledWith({
				currentApiConfigName: "test",
				apiConfigs: {
					default: { apiProvider: providerIdentifiers.anthropic, id: "default-id" },
					test: { apiProvider: providerIdentifiers.openai, apiKey: "test-key", id: "test-id" },
				},
				modeApiConfigs: {},
			})

			expect(mockContextProxy.setValues).toHaveBeenCalledWith(
				{ mode: "code", autoApprovalEnabled: true },
				expect.any(Function),
			)
			expect(mockContextProxy.setValue).toHaveBeenCalledWith("currentApiConfigName", "test")

			expect(mockContextProxy.setValue).toHaveBeenCalledWith("listApiConfigMeta", [
				{ name: "test", id: "test-id", apiProvider: providerIdentifiers.openai },
				{ name: "default", id: "default-id", apiProvider: providerIdentifiers.anthropic },
			])
		})

		it("should return success: false when file content is invalid", async () => {
			;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/settings.json" }])

			// Invalid content (missing required fields).
			const mockInvalidContent = JSON.stringify({
				providerProfiles: { apiConfigs: {} },
				globalSettings: {},
			})

			;(fs.readFile as Mock).mockResolvedValue(mockInvalidContent)

			const result = await importSettings({
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
				customModesManager: mockCustomModesManager,
			})

			expect(result).toEqual({
				success: false,
				error: "[providerProfiles.currentApiConfigName]: Invalid input: expected string, received undefined",
			})
			expect(fs.readFile).toHaveBeenCalledWith("/mock/path/settings.json", "utf-8")
			expect(mockProviderSettingsManager.import).not.toHaveBeenCalled()
			expect(mockContextProxy.setValues).not.toHaveBeenCalled()
		})

		it("round-trips a prompt cache TTL through export and import", async () => {
			// The knob rides the provider profile, so the export/import schema is the
			// only thing that can lose it. Both classes are exercised because a
			// schema that only accepted "1h" would still pass a one-sided test.
			const profiles = {
				currentApiConfigName: "cache",
				apiConfigs: {
					cache: {
						apiProvider: providerIdentifiers.anthropic,
						apiModelId: "claude-sonnet-4-5",
						apiKey: "test-key",
						id: "cache-id",
						promptCacheTtl: "1h" as const,
					},
					explicit: {
						apiProvider: providerIdentifiers.anthropic,
						apiModelId: "claude-sonnet-4-5",
						apiKey: "test-key",
						id: "explicit-id",
						promptCacheTtl: "5m" as const,
					},
				},
			}

			;(vscode.window.showSaveDialog as Mock).mockResolvedValue({ fsPath: "/mock/path/export.json" })
			mockProviderSettingsManager.export.mockResolvedValue(profiles)
			mockContextProxy.export.mockResolvedValue({ mode: "code" })

			await exportSettings({
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
			})

			const exported = (safeWriteJson as Mock).mock.calls.at(-1)?.[1]
			expect(exported.providerProfiles.apiConfigs.cache.promptCacheTtl).toBe("1h")
			expect(exported.providerProfiles.apiConfigs.explicit.promptCacheTtl).toBe("5m")

			;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/export.json" }])
			;(fs.readFile as Mock).mockResolvedValue(JSON.stringify(exported))
			mockProviderSettingsManager.export.mockResolvedValue({ currentApiConfigName: "default", apiConfigs: {} })
			mockProviderSettingsManager.listConfig.mockResolvedValue([])

			const result = await importSettings({
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
				customModesManager: mockCustomModesManager,
			})

			expect(result.success).toBe(true)
			expect(mockProviderSettingsManager.import).toHaveBeenCalledWith(
				expect.objectContaining({
					apiConfigs: expect.objectContaining({
						cache: expect.objectContaining({ promptCacheTtl: "1h" }),
						explicit: expect.objectContaining({ promptCacheTtl: "5m" }),
					}),
				}),
			)
		})

		it("should import settings successfully when globalSettings key is missing", async () => {
			;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/settings.json" }])

			const mockFileContent = JSON.stringify({
				providerProfiles: {
					currentApiConfigName: "test",
					apiConfigs: {
						test: { apiProvider: providerIdentifiers.openai, apiKey: "test-key", id: "test-id" },
					},
				},
			})

			;(fs.readFile as Mock).mockResolvedValue(mockFileContent)

			const previousProviderProfiles = {
				currentApiConfigName: "default",
				apiConfigs: { default: { apiProvider: providerIdentifiers.anthropic, id: "default-id" } },
			}

			mockProviderSettingsManager.export.mockResolvedValue(previousProviderProfiles)

			mockProviderSettingsManager.listConfig.mockResolvedValue([
				{ name: "test", id: "test-id", apiProvider: providerIdentifiers.openai },
				{ name: "default", id: "default-id", apiProvider: providerIdentifiers.anthropic },
			])

			mockContextProxy.export.mockResolvedValue({ mode: "code" })

			const result = await importSettings({
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
				customModesManager: mockCustomModesManager,
			})

			expect(result.success).toBe(true)
			expect(fs.readFile).toHaveBeenCalledWith("/mock/path/settings.json", "utf-8")
			expect(mockProviderSettingsManager.export).toHaveBeenCalled()
			expect(mockProviderSettingsManager.import).toHaveBeenCalledWith({
				currentApiConfigName: "test",
				apiConfigs: {
					default: { apiProvider: providerIdentifiers.anthropic, id: "default-id" },
					test: { apiProvider: providerIdentifiers.openai, apiKey: "test-key", id: "test-id" },
				},
				modeApiConfigs: {},
			})

			// Should call setValues with an empty object since globalSettings is missing.
			expect(mockContextProxy.setValues).toHaveBeenCalledWith({}, expect.any(Function))
			expect(mockContextProxy.setValue).toHaveBeenCalledWith("currentApiConfigName", "test")
			expect(mockContextProxy.setValue).toHaveBeenCalledWith("listApiConfigMeta", [
				{ name: "test", id: "test-id", apiProvider: providerIdentifiers.openai },
				{ name: "default", id: "default-id", apiProvider: providerIdentifiers.anthropic },
			])
		})

		it("should return success: false when file content is not valid JSON", async () => {
			;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/settings.json" }])
			const mockInvalidJson = "{ this is not valid JSON }"
			;(fs.readFile as Mock).mockResolvedValue(mockInvalidJson)

			const result = await importSettings({
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
				customModesManager: mockCustomModesManager,
			})

			expect(result.success).toBe(false)
			expect(result.error).toMatch(/^Expected property name or '}' in JSON at position 2/)
			expect(fs.readFile).toHaveBeenCalledWith("/mock/path/settings.json", "utf-8")
			expect(mockProviderSettingsManager.import).not.toHaveBeenCalled()
			expect(mockContextProxy.setValues).not.toHaveBeenCalled()
		})

		it("should return success: false when reading file fails", async () => {
			;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/settings.json" }])
			;(fs.readFile as Mock).mockRejectedValue(new Error("File read error"))

			const result = await importSettings({
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
				customModesManager: mockCustomModesManager,
			})

			expect(result).toEqual({ success: false, error: "File read error" })
			expect(fs.readFile).toHaveBeenCalledWith("/mock/path/settings.json", "utf-8")
			expect(mockProviderSettingsManager.import).not.toHaveBeenCalled()
			expect(mockContextProxy.setValues).not.toHaveBeenCalled()
		})

		it("should not clobber existing api configs", async () => {
			const providerSettingsManager = new ProviderSettingsManager(mockExtensionContext)
			await providerSettingsManager.saveConfig("openai", {
				apiProvider: providerIdentifiers.openai,
				id: "openai",
			})

			const configs = await providerSettingsManager.listConfig()
			expect(configs[0].name).toBe("default")
			expect(configs[1].name).toBe("openai")
			;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/settings.json" }])

			const mockFileContent = JSON.stringify({
				globalSettings: { mode: "code" },
				providerProfiles: {
					currentApiConfigName: "anthropic",
					apiConfigs: { default: { apiProvider: providerIdentifiers.anthropic, id: "anthropic" } },
				},
			})

			;(fs.readFile as Mock).mockResolvedValue(mockFileContent)

			mockContextProxy.export.mockResolvedValue({ mode: "code" })

			const result = await importSettings({
				providerSettingsManager,
				contextProxy: mockContextProxy,
				customModesManager: mockCustomModesManager,
			})

			expect(result.success).toBe(true)
			if (result.success && "providerProfiles" in result) {
				expect(result.providerProfiles?.apiConfigs["openai"]).toBeDefined()
				expect(result.providerProfiles?.apiConfigs["default"]).toBeDefined()
				expect(result.providerProfiles?.apiConfigs["default"].apiProvider).toBe("anthropic")
			}
		})

		it("should call updateCustomMode for each custom mode in config", async () => {
			;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/settings.json" }])

			const customModes = [
				{ slug: "mode1", name: "Mode One", roleDefinition: "Custom role one", groups: [] },
				{ slug: "mode2", name: "Mode Two", roleDefinition: "Custom role two", groups: [] },
			]

			const mockFileContent = JSON.stringify({
				providerProfiles: { currentApiConfigName: "test", apiConfigs: {} },
				globalSettings: { mode: "code", customModes },
			})

			;(fs.readFile as Mock).mockResolvedValue(mockFileContent)

			mockProviderSettingsManager.export.mockResolvedValue({
				currentApiConfigName: "test",
				apiConfigs: {},
			})

			mockProviderSettingsManager.listConfig.mockResolvedValue([])

			const result = await importSettings({
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
				customModesManager: mockCustomModesManager,
			})

			expect(result.success).toBe(true)
			expect(mockCustomModesManager.updateCustomMode).toHaveBeenCalledTimes(customModes.length)

			customModes.forEach((mode) => {
				expect(mockCustomModesManager.updateCustomMode).toHaveBeenCalledWith(mode.slug, mode)
			})
		})

		it("should import settings from provided file path without showing dialog", async () => {
			const filePath = "/mock/path/settings.json"
			const mockFileContent = JSON.stringify({
				providerProfiles: {
					currentApiConfigName: "test",
					apiConfigs: {
						test: { apiProvider: providerIdentifiers.openai, apiKey: "test-key", id: "test-id" },
					},
				},
				globalSettings: { mode: "code", autoApprovalEnabled: true },
			})

			;(fs.readFile as Mock).mockResolvedValue(mockFileContent)
			;(fs.access as Mock).mockResolvedValue(undefined) // File exists and is readable

			const previousProviderProfiles = {
				currentApiConfigName: "default",
				apiConfigs: { default: { apiProvider: providerIdentifiers.anthropic, id: "default-id" } },
			}

			mockProviderSettingsManager.export.mockResolvedValue(previousProviderProfiles)
			mockProviderSettingsManager.listConfig.mockResolvedValue([
				{ name: "test", id: "test-id", apiProvider: providerIdentifiers.openai },
				{ name: "default", id: "default-id", apiProvider: providerIdentifiers.anthropic },
			])
			mockContextProxy.export.mockResolvedValue({ mode: "code" })

			const result = await importSettingsFromFile(
				{
					providerSettingsManager: mockProviderSettingsManager,
					contextProxy: mockContextProxy,
					customModesManager: mockCustomModesManager,
				},
				vscode.Uri.file(filePath),
			)

			expect(vscode.window.showOpenDialog).not.toHaveBeenCalled()
			expect(fs.readFile).toHaveBeenCalledWith(filePath, "utf-8")
			expect(result.success).toBe(true)
			expect(mockProviderSettingsManager.import).toHaveBeenCalledWith({
				currentApiConfigName: "test",
				apiConfigs: {
					default: { apiProvider: providerIdentifiers.anthropic, id: "default-id" },
					test: { apiProvider: providerIdentifiers.openai, apiKey: "test-key", id: "test-id" },
				},
				modeApiConfigs: {},
			})
			expect(mockContextProxy.setValues).toHaveBeenCalledWith(
				{ mode: "code", autoApprovalEnabled: true },
				expect.any(Function),
			)
		})

		it("should return error when provided file path does not exist", async () => {
			const filePath = "/nonexistent/path/settings.json"
			const accessError = new Error("ENOENT: no such file or directory")

			;(fs.access as Mock).mockRejectedValue(accessError)

			// Create a mock provider for the test
			const mockProvider = {
				settingsImportedAt: 0,
				postStateToWebview: vi.fn().mockResolvedValue(undefined),
				postStateToWebviewWithoutTaskHistory: vi.fn().mockResolvedValue(undefined),
			}

			// Mock the showErrorMessage to capture the error
			const showErrorMessageSpy = vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined)

			await importSettingsWithFeedback(
				{
					providerSettingsManager: mockProviderSettingsManager,
					contextProxy: mockContextProxy,
					customModesManager: mockCustomModesManager,
					provider: mockProvider,
				},
				filePath,
			)

			expect(vscode.window.showOpenDialog).not.toHaveBeenCalled()
			expect(fs.access).toHaveBeenCalledWith(filePath, fs.constants.F_OK | fs.constants.R_OK)
			expect(fs.readFile).not.toHaveBeenCalled()
			expect(showErrorMessageSpy).toHaveBeenCalledWith(expect.stringContaining("errors.settings_import_failed"))

			showErrorMessageSpy.mockRestore()
		})

		it("should handle import when reasoning budget fields are missing from config", async () => {
			// This test verifies that import works correctly when reasoning budget fields are not present

			;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/settings.json" }])

			const mockFileContent = JSON.stringify({
				providerProfiles: {
					currentApiConfigName: "openai-provider",
					apiConfigs: {
						"openai-provider": {
							apiProvider: providerIdentifiers.openai,
							apiModelId: "gpt-4",
							id: "openai-id",
							apiKey: "test-key",
							// No modelMaxTokens or modelMaxThinkingTokens fields
						},
					},
				},
				globalSettings: { mode: "code", autoApprovalEnabled: true },
			})

			;(fs.readFile as Mock).mockResolvedValue(mockFileContent)

			const previousProviderProfiles = {
				currentApiConfigName: "default",
				apiConfigs: { default: { apiProvider: providerIdentifiers.anthropic, id: "default-id" } },
			}

			mockProviderSettingsManager.export.mockResolvedValue(previousProviderProfiles)
			mockProviderSettingsManager.listConfig.mockResolvedValue([
				{ name: "openai-provider", id: "openai-id", apiProvider: providerIdentifiers.openai },
				{ name: "default", id: "default-id", apiProvider: providerIdentifiers.anthropic },
			])

			mockContextProxy.export.mockResolvedValue({ mode: "code" })

			const result = await importSettings({
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
				customModesManager: mockCustomModesManager,
			})

			expect(result.success).toBe(true)
			expect(fs.readFile).toHaveBeenCalledWith("/mock/path/settings.json", "utf-8")
			expect(mockProviderSettingsManager.export).toHaveBeenCalled()

			expect(mockProviderSettingsManager.import).toHaveBeenCalledWith({
				currentApiConfigName: "openai-provider",
				apiConfigs: {
					default: { apiProvider: providerIdentifiers.anthropic, id: "default-id" },
					"openai-provider": {
						apiProvider: providerIdentifiers.openai,
						apiModelId: "gpt-4",
						apiKey: "test-key",
						id: "openai-id",
					},
				},
				modeApiConfigs: {},
			})

			expect(mockContextProxy.setValues).toHaveBeenCalledWith(
				{ mode: "code", autoApprovalEnabled: true },
				expect.any(Function),
			)
			expect(mockContextProxy.setValue).toHaveBeenCalledWith("currentApiConfigName", "openai-provider")
		})

		describe("lenient import with invalid providers", () => {
			it("should sanitize profiles with invalid apiProvider and return warnings", async () => {
				// Test importing a profile with a removed/invalid provider like "claude-code"
				;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/settings.json" }])

				const mockFileContent = JSON.stringify({
					providerProfiles: {
						currentApiConfigName: "valid-profile",
						apiConfigs: {
							"valid-profile": {
								apiProvider: providerIdentifiers.openai,
								apiKey: "test-key",
								id: "valid-id",
							},
							"invalid-profile": {
								apiProvider: "claude-code", // Invalid/removed provider
								apiKey: "some-key",
								id: "invalid-id",
							},
						},
					},
					globalSettings: { mode: "code" },
				})

				;(fs.readFile as Mock).mockResolvedValue(mockFileContent)

				mockProviderSettingsManager.export.mockResolvedValue({
					currentApiConfigName: "default",
					apiConfigs: { default: { apiProvider: providerIdentifiers.anthropic, id: "default-id" } },
				})
				mockProviderSettingsManager.listConfig.mockResolvedValue([
					{ name: "valid-profile", id: "valid-id", apiProvider: providerIdentifiers.openai },
					{ name: "default", id: "default-id", apiProvider: providerIdentifiers.anthropic },
				])

				const result = await importSettings({
					providerSettingsManager: mockProviderSettingsManager,
					contextProxy: mockContextProxy,
					customModesManager: mockCustomModesManager,
				})

				// Import should succeed
				expect(result.success).toBe(true)

				// Should have warnings about the sanitized profile
				expect(result).toHaveProperty("warnings")
				expect((result as { warnings?: string[] }).warnings).toBeDefined()
				expect((result as { warnings?: string[] }).warnings!.length).toBeGreaterThan(0)
				expect((result as { warnings?: string[] }).warnings![0]).toContain("invalid-profile")
				expect((result as { warnings?: string[] }).warnings![0]).toContain("claude-code")

				// The valid profile should be imported
				expect(mockProviderSettingsManager.import).toHaveBeenCalled()
				const importedProfiles = mockProviderSettingsManager.import.mock.calls[0][0]
				expect(importedProfiles.apiConfigs["valid-profile"]).toBeDefined()
				expect(importedProfiles.apiConfigs["valid-profile"].apiProvider).toBe("openai")

				// The invalid profile should still be imported but without apiProvider
				expect(importedProfiles.apiConfigs["invalid-profile"]).toBeDefined()
				expect(importedProfiles.apiConfigs["invalid-profile"].apiProvider).toBeUndefined()
			})

			it("should skip completely invalid profiles and return warnings", async () => {
				;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/settings.json" }])

				const mockFileContent = JSON.stringify({
					providerProfiles: {
						currentApiConfigName: "valid-profile",
						apiConfigs: {
							"valid-profile": {
								apiProvider: providerIdentifiers.openai,
								apiKey: "test-key",
								id: "valid-id",
							},
							"type-invalid": {
								// Invalid type - modelTemperature should be a number, not a string
								modelTemperature: "not-a-number",
								id: "type-invalid-id",
							},
						},
					},
					globalSettings: { mode: "code" },
				})

				;(fs.readFile as Mock).mockResolvedValue(mockFileContent)

				mockProviderSettingsManager.export.mockResolvedValue({
					currentApiConfigName: "default",
					apiConfigs: { default: { apiProvider: providerIdentifiers.anthropic, id: "default-id" } },
				})
				mockProviderSettingsManager.listConfig.mockResolvedValue([
					{ name: "valid-profile", id: "valid-id", apiProvider: providerIdentifiers.openai },
				])

				const result = await importSettings({
					providerSettingsManager: mockProviderSettingsManager,
					contextProxy: mockContextProxy,
					customModesManager: mockCustomModesManager,
				})

				// Import should succeed (valid profile was imported)
				expect(result.success).toBe(true)

				// Should have warnings about the skipped profile
				expect((result as { warnings?: string[] }).warnings).toBeDefined()
				expect((result as { warnings?: string[] }).warnings!.some((w) => w.includes("type-invalid"))).toBe(true)
				expect((result as { warnings?: string[] }).warnings!.some((w) => w.includes("skipped"))).toBe(true)

				// The valid profile should be imported
				const importedProfiles = mockProviderSettingsManager.import.mock.calls[0][0]
				expect(importedProfiles.apiConfigs["valid-profile"]).toBeDefined()

				// The type-invalid profile should NOT be imported
				expect(importedProfiles.apiConfigs["type-invalid"]).toBeUndefined()
			})

			it("should fail when NO valid profiles can be imported", async () => {
				;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/settings.json" }])

				const mockFileContent = JSON.stringify({
					providerProfiles: {
						currentApiConfigName: "invalid-profile",
						apiConfigs: {
							"invalid-profile-1": {
								// Invalid type - rateLimitSeconds should be number
								rateLimitSeconds: "not-a-number",
								id: "invalid-1",
							},
							"invalid-profile-2": {
								// Invalid type - modelTemperature should be number
								modelTemperature: { invalid: "object" },
								id: "invalid-2",
							},
						},
					},
					globalSettings: { mode: "code" },
				})

				;(fs.readFile as Mock).mockResolvedValue(mockFileContent)

				mockProviderSettingsManager.export.mockResolvedValue({
					currentApiConfigName: "default",
					apiConfigs: { default: { apiProvider: providerIdentifiers.anthropic, id: "default-id" } },
				})

				const result = await importSettings({
					providerSettingsManager: mockProviderSettingsManager,
					contextProxy: mockContextProxy,
					customModesManager: mockCustomModesManager,
				})

				// Import should fail since all profiles have schema validation errors
				expect(result.success).toBe(false)
				expect(result.error).toContain("No valid profiles could be imported")

				// Should NOT have called import since there were no valid profiles
				expect(mockProviderSettingsManager.import).not.toHaveBeenCalled()
			})

			it("should show warning notification when importing with warnings via importSettingsWithFeedback", async () => {
				const filePath = "/mock/path/settings.json"
				const mockFileContent = JSON.stringify({
					providerProfiles: {
						currentApiConfigName: "valid-profile",
						apiConfigs: {
							"valid-profile": {
								apiProvider: providerIdentifiers.openai,
								apiKey: "test-key",
								id: "valid-id",
							},
							"problematic-profile": {
								apiProvider: "removed-provider", // Invalid provider
								apiKey: "some-key",
								id: "problematic-id",
							},
						},
					},
					globalSettings: { mode: "code" },
				})

				;(fs.readFile as Mock).mockResolvedValue(mockFileContent)
				;(fs.access as Mock).mockResolvedValue(undefined)

				mockProviderSettingsManager.export.mockResolvedValue({
					currentApiConfigName: "default",
					apiConfigs: { default: { apiProvider: providerIdentifiers.anthropic, id: "default-id" } },
				})
				mockProviderSettingsManager.listConfig.mockResolvedValue([
					{ name: "valid-profile", id: "valid-id", apiProvider: providerIdentifiers.openai },
				])

				const seenImportedAt: Array<number | undefined> = []
				const mockProvider = {
					settingsImportedAt: undefined as number | undefined,
					postStateToWebview: vi.fn().mockImplementation(async () => {
						seenImportedAt.push(mockProvider.settingsImportedAt)
					}),
				}

				const showWarningMessageSpy = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined)
				const showInfoMessageSpy = vi
					.spyOn(vscode.window, "showInformationMessage")
					.mockResolvedValue(undefined)
				const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

				await importSettingsWithFeedback(
					{
						providerSettingsManager: mockProviderSettingsManager,
						contextProxy: mockContextProxy,
						customModesManager: mockCustomModesManager,
						provider: mockProvider,
					},
					filePath,
				)

				// Should show warning message with short summary (not full details)
				expect(showWarningMessageSpy).toHaveBeenCalledWith(
					expect.stringContaining("1 item had issues during import."),
				)
				expect(showWarningMessageSpy).toHaveBeenCalledWith(
					expect.stringContaining("See Developer Tools console for details."),
				)
				// Should log full details to console
				expect(consoleWarnSpy).toHaveBeenCalledWith(
					"Settings import completed with warnings:",
					expect.arrayContaining([expect.stringContaining("problematic-profile")]),
				)
				expect(showInfoMessageSpy).not.toHaveBeenCalled()

				// Provider state should be delivered once, then cleared.
				expect(seenImportedAt).toHaveLength(1)
				expect(seenImportedAt[0]).toBeGreaterThan(0)
				expect(mockProvider.settingsImportedAt).toBeUndefined()
				expect(mockProvider.postStateToWebview).toHaveBeenCalled()

				showWarningMessageSpy.mockRestore()
				showInfoMessageSpy.mockRestore()
				consoleWarnSpy.mockRestore()
			})

			it("clears settingsImportedAt after posting the imported state so later launches do not replay it", async () => {
				const filePath = "/mock/path/settings.json"
				const mockFileContent = JSON.stringify({
					providerProfiles: {
						currentApiConfigName: "valid-profile",
						apiConfigs: {
							"valid-profile": {
								apiProvider: providerIdentifiers.openai,
								apiKey: "test-key",
								id: "valid-id",
							},
						},
					},
					globalSettings: { mode: "code" },
				})

				;(fs.readFile as Mock).mockResolvedValue(mockFileContent)
				;(fs.access as Mock).mockResolvedValue(undefined)

				mockProviderSettingsManager.export.mockResolvedValue({
					currentApiConfigName: "default",
					apiConfigs: { default: { apiProvider: providerIdentifiers.anthropic, id: "default-id" } },
				})
				mockProviderSettingsManager.listConfig.mockResolvedValue([
					{ name: "valid-profile", id: "valid-id", apiProvider: providerIdentifiers.openai },
				])

				const seenImportedAt: Array<number | undefined> = []
				const mockProvider = {
					settingsImportedAt: undefined as number | undefined,
					postStateToWebview: vi.fn().mockImplementation(async () => {
						seenImportedAt.push(mockProvider.settingsImportedAt)
					}),
				}

				await importSettingsWithFeedback(
					{
						providerSettingsManager: mockProviderSettingsManager,
						contextProxy: mockContextProxy,
						customModesManager: mockCustomModesManager,
						provider: mockProvider,
					},
					filePath,
				)

				expect(seenImportedAt).toHaveLength(1)
				expect(seenImportedAt[0]).toBeGreaterThan(0)
				expect(mockProvider.settingsImportedAt).toBeUndefined()
			})

			it("should handle multiple profiles with mixed valid and invalid providers", async () => {
				;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/settings.json" }])

				const mockFileContent = JSON.stringify({
					providerProfiles: {
						currentApiConfigName: "anthropic-profile",
						apiConfigs: {
							"anthropic-profile": {
								apiProvider: providerIdentifiers.anthropic,
								anthropicApiKey: "key-1",
								id: "anthropic-id",
							},
							"openai-profile": {
								apiProvider: providerIdentifiers.openai,
								apiKey: "key-2",
								id: "openai-id",
							},
							"old-claude-profile": {
								apiProvider: "claude-code", // Removed provider
								apiKey: "key-3",
								id: "claude-id",
							},
							"another-invalid": {
								apiProvider: "some-old-provider", // Another removed provider
								apiKey: "key-4",
								id: "another-id",
							},
						},
					},
					globalSettings: { mode: "code" },
				})

				;(fs.readFile as Mock).mockResolvedValue(mockFileContent)

				mockProviderSettingsManager.export.mockResolvedValue({
					currentApiConfigName: "default",
					apiConfigs: { default: { apiProvider: providerIdentifiers.anthropic, id: "default-id" } },
				})
				mockProviderSettingsManager.listConfig.mockResolvedValue([
					{ name: "anthropic-profile", id: "anthropic-id", apiProvider: providerIdentifiers.anthropic },
					{ name: "openai-profile", id: "openai-id", apiProvider: providerIdentifiers.openai },
				])

				const result = await importSettings({
					providerSettingsManager: mockProviderSettingsManager,
					contextProxy: mockContextProxy,
					customModesManager: mockCustomModesManager,
				})

				// Import should succeed
				expect(result.success).toBe(true)

				// Should have multiple warnings
				const warnings = (result as { warnings?: string[] }).warnings!
				expect(warnings.length).toBe(2) // Two profiles had invalid providers
				expect(warnings.some((w) => w.includes("old-claude-profile"))).toBe(true)
				expect(warnings.some((w) => w.includes("another-invalid"))).toBe(true)

				// Valid profiles should be imported correctly
				const importedProfiles = mockProviderSettingsManager.import.mock.calls[0][0]
				expect(importedProfiles.apiConfigs["anthropic-profile"].apiProvider).toBe("anthropic")
				expect(importedProfiles.apiConfigs["openai-profile"].apiProvider).toBe("openai")

				// Invalid provider profiles should have apiProvider removed
				expect(importedProfiles.apiConfigs["old-claude-profile"].apiProvider).toBeUndefined()
				expect(importedProfiles.apiConfigs["another-invalid"].apiProvider).toBeUndefined()
			})

			it("should downgrade imported Roo profiles without failing the import", async () => {
				;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/settings.json" }])

				const mockFileContent = JSON.stringify({
					providerProfiles: {
						currentApiConfigName: "router-profile",
						apiConfigs: {
							"router-profile": {
								apiProvider: retiredProviderIdentifiers.roo,
								apiModelId: "roo/code-supernova",
								rooApiKey: "router-key",
								id: "router-id",
							},
						},
					},
					globalSettings: { mode: "code" },
				})

				;(fs.readFile as Mock).mockResolvedValue(mockFileContent)

				mockProviderSettingsManager.export.mockResolvedValue({
					currentApiConfigName: "default",
					apiConfigs: { default: { apiProvider: providerIdentifiers.anthropic, id: "default-id" } },
				})

				const result = await importSettings({
					providerSettingsManager: mockProviderSettingsManager,
					contextProxy: mockContextProxy,
					customModesManager: mockCustomModesManager,
				})

				expect(result.success).toBe(true)
				expect((result as { warnings?: string[] }).warnings?.[0]).toContain("Roo Code Router was removed")

				const importedProfiles = mockProviderSettingsManager.import.mock.calls[0][0]
				expect(importedProfiles.currentApiConfigName).toBe("router-profile")
				expect(importedProfiles.apiConfigs["router-profile"]).toEqual({ id: "router-id" })
			})

			it("should fallback currentApiConfigName when the imported current profile was skipped", async () => {
				;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/settings.json" }])

				// Import file where currentApiConfigName points to an invalid profile that gets skipped
				const mockFileContent = JSON.stringify({
					providerProfiles: {
						currentApiConfigName: "invalid-current-profile", // This profile is completely invalid
						apiConfigs: {
							"invalid-current-profile": {
								// Invalid type - rateLimitSeconds should be number
								rateLimitSeconds: "not-a-number",
								id: "invalid-current-id",
							},
							"valid-fallback-profile": {
								apiProvider: providerIdentifiers.openai,
								apiKey: "test-key",
								id: "fallback-id",
							},
						},
					},
					globalSettings: { mode: "code" },
				})

				;(fs.readFile as Mock).mockResolvedValue(mockFileContent)

				mockProviderSettingsManager.export.mockResolvedValue({
					currentApiConfigName: "default",
					apiConfigs: { default: { apiProvider: providerIdentifiers.anthropic, id: "default-id" } },
				})
				mockProviderSettingsManager.listConfig.mockResolvedValue([
					{ name: "valid-fallback-profile", id: "fallback-id", apiProvider: providerIdentifiers.openai },
				])

				const result = await importSettings({
					providerSettingsManager: mockProviderSettingsManager,
					contextProxy: mockContextProxy,
					customModesManager: mockCustomModesManager,
				})

				// Import should succeed
				expect(result.success).toBe(true)

				// Should have warnings about the skipped profile AND the fallback
				const warnings = (result as { warnings?: string[] }).warnings!
				expect(warnings).toBeDefined()
				expect(warnings.some((w) => w.includes("invalid-current-profile") && w.includes("skipped"))).toBe(true)
				expect(
					warnings.some(
						(w) =>
							w.includes("invalid-current-profile") &&
							w.includes("not available") &&
							w.includes("valid-fallback-profile"),
					),
				).toBe(true)

				// The currentApiConfigName should be set to the valid fallback profile, not the invalid one
				const importedProfiles = mockProviderSettingsManager.import.mock.calls[0][0]
				expect(importedProfiles.currentApiConfigName).toBe("valid-fallback-profile")

				// contextProxy should also be set with the fallback profile name
				expect(mockContextProxy.setValue).toHaveBeenCalledWith("currentApiConfigName", "valid-fallback-profile")

				// The invalid profile should NOT be imported
				expect(importedProfiles.apiConfigs["invalid-current-profile"]).toBeUndefined()
				// The valid fallback profile should be imported
				expect(importedProfiles.apiConfigs["valid-fallback-profile"]).toBeDefined()
			})

			it("should keep previous currentApiConfigName when all imported profiles are invalid", async () => {
				;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/settings.json" }])

				// All profiles in the import are invalid, but we have existing profiles
				const mockFileContent = JSON.stringify({
					providerProfiles: {
						currentApiConfigName: "invalid-profile",
						apiConfigs: {
							"invalid-profile": {
								rateLimitSeconds: "not-a-number",
								id: "invalid-id",
							},
						},
					},
					globalSettings: { mode: "code" },
				})

				;(fs.readFile as Mock).mockResolvedValue(mockFileContent)

				mockProviderSettingsManager.export.mockResolvedValue({
					currentApiConfigName: "existing-profile",
					apiConfigs: {
						"existing-profile": { apiProvider: providerIdentifiers.anthropic, id: "existing-id" },
					},
				})

				const result = await importSettings({
					providerSettingsManager: mockProviderSettingsManager,
					contextProxy: mockContextProxy,
					customModesManager: mockCustomModesManager,
				})

				// Import should fail because no valid profiles could be imported
				expect(result.success).toBe(false)
				expect(result.error).toContain("No valid profiles could be imported")
			})

			it("should show plural summary for multiple profile warnings via importSettingsWithFeedback", async () => {
				const filePath = "/mock/path/settings.json"
				const mockFileContent = JSON.stringify({
					providerProfiles: {
						currentApiConfigName: "valid-profile",
						apiConfigs: {
							"valid-profile": {
								apiProvider: providerIdentifiers.openai,
								apiKey: "test-key",
								id: "valid-id",
							},
							"problematic-profile-1": {
								apiProvider: "removed-provider-1",
								apiKey: "key-1",
								id: "problematic-id-1",
							},
							"problematic-profile-2": {
								apiProvider: "removed-provider-2",
								apiKey: "key-2",
								id: "problematic-id-2",
							},
						},
					},
					globalSettings: { mode: "code" },
				})

				;(fs.readFile as Mock).mockResolvedValue(mockFileContent)
				;(fs.access as Mock).mockResolvedValue(undefined)

				mockProviderSettingsManager.export.mockResolvedValue({
					currentApiConfigName: "default",
					apiConfigs: { default: { apiProvider: providerIdentifiers.anthropic, id: "default-id" } },
				})
				mockProviderSettingsManager.listConfig.mockResolvedValue([
					{ name: "valid-profile", id: "valid-id", apiProvider: providerIdentifiers.openai },
				])

				const mockProvider = {
					settingsImportedAt: 0,
					postStateToWebview: vi.fn().mockResolvedValue(undefined),
				}

				const showWarningMessageSpy = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined)
				const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

				await importSettingsWithFeedback(
					{
						providerSettingsManager: mockProviderSettingsManager,
						contextProxy: mockContextProxy,
						customModesManager: mockCustomModesManager,
						provider: mockProvider,
					},
					filePath,
				)

				// Should show warning message with plural summary for multiple warnings
				expect(showWarningMessageSpy).toHaveBeenCalledWith(
					expect.stringContaining("2 items had issues during import."),
				)
				// Should log full details to console
				expect(consoleWarnSpy).toHaveBeenCalledWith(
					"Settings import completed with warnings:",
					expect.arrayContaining([
						expect.stringContaining("problematic-profile-1"),
						expect.stringContaining("problematic-profile-2"),
					]),
				)

				showWarningMessageSpy.mockRestore()
				consoleWarnSpy.mockRestore()
			})

			it.each([
				{ imageGenerationProvider: providerIdentifiers.openrouter, expectedWarnings: undefined },
				{
					imageGenerationProvider: retiredProviderIdentifiers.roo,
					expectedWarnings: [
						'Setting "globalSettings.imageGenerationProvider" used unsupported value "roo" and was cleared during import.',
					],
				},
			])(
				"only clears the retired image provider: $imageGenerationProvider",
				async ({ imageGenerationProvider, expectedWarnings }) => {
					;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/settings.json" }])
					;(fs.readFile as Mock).mockResolvedValue(
						JSON.stringify({
							providerProfiles: {
								currentApiConfigName: "valid-profile",
								apiConfigs: {
									"valid-profile": { apiProvider: providerIdentifiers.openai, id: "valid-id" },
								},
							},
							globalSettings: {
								imageGenerationProvider,
								customInstructions: "roo",
							},
						}),
					)
					mockProviderSettingsManager.export.mockResolvedValue({
						currentApiConfigName: "default",
						apiConfigs: { default: { apiProvider: providerIdentifiers.anthropic, id: "default-id" } },
					})
					mockProviderSettingsManager.listConfig.mockResolvedValue([
						{ name: "valid-profile", id: "valid-id", apiProvider: providerIdentifiers.openai },
					])

					const result = await importSettings({
						providerSettingsManager: mockProviderSettingsManager,
						contextProxy: mockContextProxy,
						customModesManager: mockCustomModesManager,
					})

					expect(result.success).toBe(true)
					expect(result.warnings).toEqual(expectedWarnings)
					expect(mockContextProxy.setValues).toHaveBeenCalledTimes(1)
					expect(mockContextProxy.setValues).toHaveBeenCalledWith(
						expect.objectContaining({
							imageGenerationProvider: expectedWarnings ? undefined : providerIdentifiers.openrouter,
							customInstructions: "roo",
						}),
						expect.any(Function),
					)
				},
			)

			it("should normalize imageGenerationProvider roo while preserving other global settings", async () => {
				;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/settings.json" }])

				const mockFileContent = JSON.stringify({
					providerProfiles: {
						currentApiConfigName: "valid-profile",
						apiConfigs: {
							"valid-profile": {
								apiProvider: providerIdentifiers.openai,
								apiKey: "test-key",
								id: "valid-id",
							},
						},
					},
					globalSettings: {
						imageGenerationProvider: retiredProviderIdentifiers.roo,
						openRouterImageGenerationSelectedModel: "openrouter/model-1",
						customInstructions: "Keep this setting",
					},
				})

				;(fs.readFile as Mock).mockResolvedValue(mockFileContent)
				mockProviderSettingsManager.export.mockResolvedValue({
					currentApiConfigName: "default",
					apiConfigs: { default: { apiProvider: providerIdentifiers.anthropic, id: "default-id" } },
				})
				mockProviderSettingsManager.listConfig.mockResolvedValue([
					{ name: "valid-profile", id: "valid-id", apiProvider: providerIdentifiers.openai },
				])

				const result = await importSettings({
					providerSettingsManager: mockProviderSettingsManager,
					contextProxy: mockContextProxy,
					customModesManager: mockCustomModesManager,
				})

				expect(result.success).toBe(true)
				expect((result as { warnings?: string[] }).warnings).toEqual(
					expect.arrayContaining([
						expect.stringContaining("globalSettings.imageGenerationProvider"),
						expect.stringContaining('unsupported value "roo"'),
					]),
				)

				const importedGlobalSettings = mockContextProxy.setValues.mock.calls[0][0]
				expect(importedGlobalSettings).toHaveProperty("imageGenerationProvider", undefined)
				expect(importedGlobalSettings.openRouterImageGenerationSelectedModel).toBe("openrouter/model-1")
				expect(importedGlobalSettings.customInstructions).toBe("Keep this setting")
			})

			it("should partially import valid global settings when invalid top-level keys are present", async () => {
				;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/settings.json" }])

				const mockFileContent = JSON.stringify({
					providerProfiles: {
						currentApiConfigName: "valid-profile",
						apiConfigs: {
							"valid-profile": {
								apiProvider: providerIdentifiers.openai,
								apiKey: "test-key",
								id: "valid-id",
							},
						},
					},
					globalSettings: {
						customInstructions: "Keep this setting",
						autoApprovalEnabled: true,
						requestDelaySeconds: "slow",
						telemetrySetting: "maybe",
					},
				})

				;(fs.readFile as Mock).mockResolvedValue(mockFileContent)
				mockProviderSettingsManager.export.mockResolvedValue({
					currentApiConfigName: "default",
					apiConfigs: { default: { apiProvider: providerIdentifiers.anthropic, id: "default-id" } },
				})
				mockProviderSettingsManager.listConfig.mockResolvedValue([
					{ name: "valid-profile", id: "valid-id", apiProvider: providerIdentifiers.openai },
				])

				const result = await importSettings({
					providerSettingsManager: mockProviderSettingsManager,
					contextProxy: mockContextProxy,
					customModesManager: mockCustomModesManager,
				})

				expect(result.success).toBe(true)
				expect((result as { warnings?: string[] }).warnings).toEqual(
					expect.arrayContaining([
						expect.stringContaining("globalSettings.requestDelaySeconds"),
						expect.stringContaining("globalSettings.telemetrySetting"),
					]),
				)

				const importedGlobalSettings = mockContextProxy.setValues.mock.calls[0][0]
				expect(importedGlobalSettings).toEqual({
					customInstructions: "Keep this setting",
					autoApprovalEnabled: true,
				})
			})

			it("should skip invalid customModes without aborting unrelated settings import", async () => {
				;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/settings.json" }])

				const mockFileContent = JSON.stringify({
					providerProfiles: {
						currentApiConfigName: "valid-profile",
						apiConfigs: {
							"valid-profile": {
								apiProvider: providerIdentifiers.openai,
								apiKey: "test-key",
								id: "valid-id",
							},
						},
					},
					globalSettings: {
						customInstructions: "Keep this setting",
						customModes: [
							{
								slug: "broken-mode",
								name: "",
								roleDefinition: "",
								groups: ["invalid-group"],
							},
						],
					},
				})

				;(fs.readFile as Mock).mockResolvedValue(mockFileContent)
				mockProviderSettingsManager.export.mockResolvedValue({
					currentApiConfigName: "default",
					apiConfigs: { default: { apiProvider: providerIdentifiers.anthropic, id: "default-id" } },
				})
				mockProviderSettingsManager.listConfig.mockResolvedValue([
					{ name: "valid-profile", id: "valid-id", apiProvider: providerIdentifiers.openai },
				])

				const result = await importSettings({
					providerSettingsManager: mockProviderSettingsManager,
					contextProxy: mockContextProxy,
					customModesManager: mockCustomModesManager,
				})

				expect(result.success).toBe(true)
				expect((result as { warnings?: string[] }).warnings).toEqual(
					expect.arrayContaining([expect.stringContaining("globalSettings.customModes")]),
				)
				expect(mockCustomModesManager.updateCustomMode).not.toHaveBeenCalled()
				expect(mockContextProxy.setValues).toHaveBeenCalledWith(
					{
						customInstructions: "Keep this setting",
					},
					expect.any(Function),
				)
			})

			it("should use generic warning wording when only global settings have issues", async () => {
				const filePath = "/mock/path/settings.json"
				const mockFileContent = JSON.stringify({
					providerProfiles: {
						currentApiConfigName: "valid-profile",
						apiConfigs: {
							"valid-profile": {
								apiProvider: providerIdentifiers.openai,
								apiKey: "test-key",
								id: "valid-id",
							},
						},
					},
					globalSettings: {
						requestDelaySeconds: "slow",
					},
				})

				;(fs.readFile as Mock).mockResolvedValue(mockFileContent)
				;(fs.access as Mock).mockResolvedValue(undefined)
				mockProviderSettingsManager.export.mockResolvedValue({
					currentApiConfigName: "default",
					apiConfigs: { default: { apiProvider: providerIdentifiers.anthropic, id: "default-id" } },
				})
				mockProviderSettingsManager.listConfig.mockResolvedValue([
					{ name: "valid-profile", id: "valid-id", apiProvider: providerIdentifiers.openai },
				])

				const mockProvider = {
					settingsImportedAt: 0,
					postStateToWebview: vi.fn().mockResolvedValue(undefined),
				}

				const showWarningMessageSpy = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined)
				const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

				await importSettingsWithFeedback(
					{
						providerSettingsManager: mockProviderSettingsManager,
						contextProxy: mockContextProxy,
						customModesManager: mockCustomModesManager,
						provider: mockProvider,
					},
					filePath,
				)

				expect(showWarningMessageSpy).toHaveBeenCalledWith(
					expect.stringContaining("1 item had issues during import."),
				)
				expect(showWarningMessageSpy).not.toHaveBeenCalledWith(expect.stringContaining("profile had issues"))
				expect(consoleWarnSpy).toHaveBeenCalledWith(
					"Settings import completed with warnings:",
					expect.arrayContaining([expect.stringContaining("globalSettings.requestDelaySeconds")]),
				)

				showWarningMessageSpy.mockRestore()
				consoleWarnSpy.mockRestore()
			})
		})
	})

	describe("exportSettings", () => {
		it("should not export settings when user cancels file selection", async () => {
			;(vscode.window.showSaveDialog as Mock).mockResolvedValue(undefined)

			await exportSettings({
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
			})

			expect(vscode.window.showSaveDialog).toHaveBeenCalledWith({
				filters: { JSON: ["json"] },
				defaultUri: expect.anything(),
			})

			expect(mockProviderSettingsManager.export).not.toHaveBeenCalled()
			expect(mockContextProxy.export).not.toHaveBeenCalled()
			expect(fs.writeFile).not.toHaveBeenCalled()
		})

		it("should export settings to the selected file location", async () => {
			;(vscode.window.showSaveDialog as Mock).mockResolvedValue({
				fsPath: "/mock/path/zoo-code-settings.json",
			})

			const mockProviderProfiles = {
				currentApiConfigName: "test",
				apiConfigs: { test: { apiProvider: providerIdentifiers.openai, id: "test-id" } },
				migrations: { rateLimitSecondsMigrated: false },
			}

			mockProviderSettingsManager.export.mockResolvedValue(mockProviderProfiles)
			const mockGlobalSettings = { mode: "code", autoApprovalEnabled: true }
			mockContextProxy.export.mockResolvedValue(mockGlobalSettings)

			await exportSettings({
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
			})

			expect(vscode.window.showSaveDialog).toHaveBeenCalledWith({
				filters: { JSON: ["json"] },
				defaultUri: expect.anything(),
			})

			expect(mockProviderSettingsManager.export).toHaveBeenCalled()
			expect(mockContextProxy.export).toHaveBeenCalled()
			expect(fs.mkdir).toHaveBeenCalledWith("/mock/path", { recursive: true })

			expect(safeWriteJson).toHaveBeenCalledWith("/mock/path/zoo-code-settings.json", {
				providerProfiles: mockProviderProfiles,
				globalSettings: mockGlobalSettings,
			})
		})

		it("should include globalSettings when allowedMaxRequests is null", async () => {
			;(vscode.window.showSaveDialog as Mock).mockResolvedValue({
				fsPath: "/mock/path/zoo-code-settings.json",
			})

			const mockProviderProfiles = {
				currentApiConfigName: "test",
				apiConfigs: { test: { apiProvider: providerIdentifiers.openai, id: "test-id" } },
				migrations: { rateLimitSecondsMigrated: false },
			}

			mockProviderSettingsManager.export.mockResolvedValue(mockProviderProfiles)

			const mockGlobalSettings = {
				mode: "code",
				autoApprovalEnabled: true,
				allowedMaxRequests: null,
			}

			mockContextProxy.export.mockResolvedValue(mockGlobalSettings)

			await exportSettings({
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
			})

			expect(safeWriteJson).toHaveBeenCalledWith("/mock/path/zoo-code-settings.json", {
				providerProfiles: mockProviderProfiles,
				globalSettings: mockGlobalSettings,
			})
		})

		it("should handle errors during the export process", async () => {
			;(vscode.window.showSaveDialog as Mock).mockResolvedValue({
				fsPath: "/mock/path/zoo-code-settings.json",
			})

			mockProviderSettingsManager.export.mockResolvedValue({
				currentApiConfigName: "test",
				apiConfigs: { test: { apiProvider: providerIdentifiers.openai, id: "test-id" } },
				migrations: { rateLimitSecondsMigrated: false },
			})

			mockContextProxy.export.mockResolvedValue({ mode: "code" })
			// Simulate an error during the safeWriteJson operation
			;(safeWriteJson as Mock).mockRejectedValueOnce(new Error("Safe write error"))

			await exportSettings({
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
			})

			expect(vscode.window.showSaveDialog).toHaveBeenCalled()
			expect(mockProviderSettingsManager.export).toHaveBeenCalled()
			expect(mockContextProxy.export).toHaveBeenCalled()
			expect(fs.mkdir).toHaveBeenCalledWith("/mock/path", { recursive: true })
			expect(safeWriteJson).toHaveBeenCalled() // safeWriteJson is called, but it will throw
			// The error is caught and the function exits silently.
			// Optionally, ensure no error message was shown if that's part of "silent"
			// expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
		})

		it("should handle errors during directory creation", async () => {
			;(vscode.window.showSaveDialog as Mock).mockResolvedValue({
				fsPath: "/mock/path/zoo-code-settings.json",
			})

			mockProviderSettingsManager.export.mockResolvedValue({
				currentApiConfigName: "test",
				apiConfigs: { test: { apiProvider: providerIdentifiers.openai, id: "test-id" } },
				migrations: { rateLimitSecondsMigrated: false },
			})

			mockContextProxy.export.mockResolvedValue({ mode: "code" })
			;(fs.mkdir as Mock).mockRejectedValue(new Error("Directory creation error"))

			await exportSettings({
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
			})

			expect(vscode.window.showSaveDialog).toHaveBeenCalled()
			expect(mockProviderSettingsManager.export).toHaveBeenCalled()
			expect(mockContextProxy.export).toHaveBeenCalled()
			expect(fs.mkdir).toHaveBeenCalled()
			expect(safeWriteJson).not.toHaveBeenCalled() // Should not be called since mkdir failed.
		})

		it("should use the correct default save location", async () => {
			;(vscode.window.showSaveDialog as Mock).mockResolvedValue(undefined)

			await exportSettings({
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
			})

			expect(vscode.window.showSaveDialog).toHaveBeenCalledWith({
				filters: { JSON: ["json"] },
				defaultUri: expect.anything(),
			})

			expect(vscode.Uri.file).toHaveBeenCalledWith(path.join("/mock/home", "Downloads", "zoo-code-settings.json"))
		})

		describe("codebase indexing export", () => {
			it("should export correct base URL for OpenAI Compatible provider", async () => {
				;(vscode.window.showSaveDialog as Mock).mockResolvedValue({
					fsPath: "/mock/path/zoo-code-settings.json",
				})

				const mockProviderProfiles = {
					currentApiConfigName: "openai-compatible-provider",
					apiConfigs: {
						"openai-compatible-provider": {
							apiProvider: providerIdentifiers.openai,
							id: "openai-compatible-id",
							// Remove OpenAI Compatible settings from provider profile
						},
						"ollama-provider": {
							apiProvider: providerIdentifiers.ollama,
							id: "ollama-id",
							codebaseIndexOllamaBaseUrl: "http://localhost:11434",
						},
					},
					modeApiConfigs: {},
				}

				const mockGlobalSettings = {
					mode: "code",
					codebaseIndexConfig: {
						codebaseIndexEnabled: true,
						codebaseIndexEmbedderProvider: "openai-compatible" as const,
						codebaseIndexEmbedderModelId: "text-embedding-3-small",
						codebaseIndexEmbedderBaseUrl: "http://localhost:11434", // Wrong URL from Ollama
						// OpenAI Compatible settings are now stored directly in codebaseIndexConfig
						codebaseIndexOpenAiCompatibleBaseUrl: "https://custom-openai-api.example.com/v1",
						codebaseIndexEmbedderModelDimension: 1536,
					},
				}

				mockProviderSettingsManager.export.mockResolvedValue(mockProviderProfiles)
				mockContextProxy.export.mockResolvedValue(mockGlobalSettings)
				;(fs.mkdir as Mock).mockResolvedValue(undefined)

				await exportSettings({
					providerSettingsManager: mockProviderSettingsManager,
					contextProxy: mockContextProxy,
				})

				expect(safeWriteJson).toHaveBeenCalledWith("/mock/path/zoo-code-settings.json", {
					providerProfiles: mockProviderProfiles,
					globalSettings: mockGlobalSettings,
				})
			})

			it("should export model dimension for OpenAI Compatible provider", async () => {
				;(vscode.window.showSaveDialog as Mock).mockResolvedValue({
					fsPath: "/mock/path/zoo-code-settings.json",
				})

				const mockProviderProfiles = {
					currentApiConfigName: "test-provider",
					apiConfigs: {
						"test-provider": {
							apiProvider: providerIdentifiers.openai,
							id: "test-id",
							// Remove OpenAI Compatible settings from provider profile
						},
					},
					modeApiConfigs: {},
				}

				const mockGlobalSettings = {
					mode: "code",
					codebaseIndexConfig: {
						codebaseIndexEnabled: true,
						codebaseIndexEmbedderProvider: "openai-compatible" as const,
						codebaseIndexEmbedderModelId: "custom-embedding-model",
						codebaseIndexEmbedderBaseUrl: "",
						// OpenAI Compatible settings are now stored directly in codebaseIndexConfig
						codebaseIndexOpenAiCompatibleBaseUrl: "https://api.example.com/v1",
						codebaseIndexEmbedderModelDimension: 768,
					},
				}

				mockProviderSettingsManager.export.mockResolvedValue(mockProviderProfiles)
				mockContextProxy.export.mockResolvedValue(mockGlobalSettings)
				;(fs.mkdir as Mock).mockResolvedValue(undefined)

				await exportSettings({
					providerSettingsManager: mockProviderSettingsManager,
					contextProxy: mockContextProxy,
				})

				const exportedData = (safeWriteJson as Mock).mock.calls[0][1]
				// Settings are now exported as-is from codebaseIndexConfig
				expect(exportedData.globalSettings.codebaseIndexConfig.codebaseIndexEmbedderModelDimension).toBe(768)
				expect(exportedData.globalSettings.codebaseIndexConfig.codebaseIndexOpenAiCompatibleBaseUrl).toBe(
					"https://api.example.com/v1",
				)
			})

			it("should not mix settings between different providers", async () => {
				;(vscode.window.showSaveDialog as Mock).mockResolvedValue({
					fsPath: "/mock/path/zoo-code-settings.json",
				})

				const mockProviderProfiles = {
					currentApiConfigName: "openai-compatible-provider",
					apiConfigs: {
						"openai-compatible-provider": {
							apiProvider: providerIdentifiers.openai,
							id: "openai-compatible-id",
							// Remove OpenAI Compatible settings from provider profile
						},
						"ollama-provider": {
							apiProvider: providerIdentifiers.ollama,
							id: "ollama-id",
							codebaseIndexOllamaBaseUrl: "http://localhost:11434",
						},
						"anthropic-provider": {
							apiProvider: providerIdentifiers.anthropic,
							id: "anthropic-id",
						},
					},
					modeApiConfigs: {},
				}

				const mockGlobalSettings = {
					mode: "code",
					codebaseIndexConfig: {
						codebaseIndexEnabled: true,
						codebaseIndexEmbedderProvider: "openai-compatible" as const,
						codebaseIndexEmbedderModelId: "text-embedding-3-small",
						codebaseIndexEmbedderBaseUrl: "http://localhost:11434", // Wrong URL from Ollama
						// OpenAI Compatible settings are now stored directly in codebaseIndexConfig
						codebaseIndexOpenAiCompatibleBaseUrl: "https://openai-compatible.example.com/v1",
						codebaseIndexEmbedderModelDimension: 1536,
					},
				}

				mockProviderSettingsManager.export.mockResolvedValue(mockProviderProfiles)
				mockContextProxy.export.mockResolvedValue(mockGlobalSettings)
				;(fs.mkdir as Mock).mockResolvedValue(undefined)

				await exportSettings({
					providerSettingsManager: mockProviderSettingsManager,
					contextProxy: mockContextProxy,
				})

				const exportedData = (safeWriteJson as Mock).mock.calls[0][1]
				// Settings are now exported as-is from codebaseIndexConfig
				expect(exportedData.globalSettings.codebaseIndexConfig.codebaseIndexOpenAiCompatibleBaseUrl).toBe(
					"https://openai-compatible.example.com/v1",
				)
				expect(exportedData.globalSettings.codebaseIndexConfig.codebaseIndexEmbedderModelDimension).toBe(1536)
				// The generic embedder base URL is still there
				expect(exportedData.globalSettings.codebaseIndexConfig.codebaseIndexEmbedderBaseUrl).toBe(
					"http://localhost:11434",
				)
			})

			it("should handle missing provider-specific settings gracefully", async () => {
				;(vscode.window.showSaveDialog as Mock).mockResolvedValue({
					fsPath: "/mock/path/zoo-code-settings.json",
				})

				const mockProviderProfiles = {
					currentApiConfigName: "incomplete-provider",
					apiConfigs: {
						"incomplete-provider": {
							apiProvider: providerIdentifiers.openai,
							id: "incomplete-id",
							// Missing codebaseIndexOpenAiCompatibleBaseUrl and dimension
						},
					},
					modeApiConfigs: {},
				}

				const mockGlobalSettings = {
					mode: "code",
					codebaseIndexConfig: {
						codebaseIndexEnabled: true,
						codebaseIndexEmbedderProvider: "openai-compatible" as const,
						codebaseIndexEmbedderModelId: "text-embedding-3-small",
						codebaseIndexEmbedderBaseUrl: "https://fallback.example.com/v1",
					},
				}

				// Mock getGlobalState to return undefined (no settings)
				mockContextProxy.getGlobalState = vi.fn().mockReturnValue(undefined)

				mockProviderSettingsManager.export.mockResolvedValue(mockProviderProfiles)
				mockContextProxy.export.mockResolvedValue(mockGlobalSettings)
				;(fs.mkdir as Mock).mockResolvedValue(undefined)

				await exportSettings({
					providerSettingsManager: mockProviderSettingsManager,
					contextProxy: mockContextProxy,
				})

				// Should not throw an error and should preserve original settings
				expect(safeWriteJson).toHaveBeenCalledWith("/mock/path/zoo-code-settings.json", {
					providerProfiles: mockProviderProfiles,
					globalSettings: mockGlobalSettings, // Should remain unchanged
				})
			})

			it("should maintain backward compatibility with existing exports", async () => {
				;(vscode.window.showSaveDialog as Mock).mockResolvedValue({
					fsPath: "/mock/path/zoo-code-settings.json",
				})

				const mockProviderProfiles = {
					currentApiConfigName: "openai-provider",
					apiConfigs: {
						"openai-provider": {
							apiProvider: providerIdentifiers.openai,
							id: "openai-id",
							// Regular OpenAI provider without OpenAI Compatible settings
						},
					},
					modeApiConfigs: {},
				}

				const mockGlobalSettings = {
					mode: "code",
					codebaseIndexConfig: {
						codebaseIndexEnabled: true,
						codebaseIndexEmbedderProvider: providerIdentifiers.openai, // Not openai-compatible
						codebaseIndexEmbedderModelId: "text-embedding-ada-002",
						codebaseIndexEmbedderBaseUrl: "https://api.openai.com/v1",
					},
				}

				mockProviderSettingsManager.export.mockResolvedValue(mockProviderProfiles)
				mockContextProxy.export.mockResolvedValue(mockGlobalSettings)
				;(fs.mkdir as Mock).mockResolvedValue(undefined)

				await exportSettings({
					providerSettingsManager: mockProviderSettingsManager,
					contextProxy: mockContextProxy,
				})

				// Should not modify settings for non-openai-compatible providers
				expect(safeWriteJson).toHaveBeenCalledWith("/mock/path/zoo-code-settings.json", {
					providerProfiles: mockProviderProfiles,
					globalSettings: mockGlobalSettings, // Should remain unchanged
				})
			})

			it("should handle missing current provider gracefully", async () => {
				;(vscode.window.showSaveDialog as Mock).mockResolvedValue({
					fsPath: "/mock/path/zoo-code-settings.json",
				})

				const mockProviderProfiles = {
					currentApiConfigName: "nonexistent-provider",
					apiConfigs: {
						"other-provider": {
							apiProvider: providerIdentifiers.openai,
							id: "other-id",
						},
					},
					modeApiConfigs: {},
				}

				const mockGlobalSettings = {
					mode: "code",
					codebaseIndexConfig: {
						codebaseIndexEnabled: true,
						codebaseIndexEmbedderProvider: "openai-compatible" as const,
						codebaseIndexEmbedderModelId: "text-embedding-3-small",
						codebaseIndexEmbedderBaseUrl: "https://fallback.example.com/v1",
					},
				}

				// Mock getGlobalState to return undefined (no settings)
				mockContextProxy.getGlobalState = vi.fn().mockReturnValue(undefined)

				mockProviderSettingsManager.export.mockResolvedValue(mockProviderProfiles)
				mockContextProxy.export.mockResolvedValue(mockGlobalSettings)
				;(fs.mkdir as Mock).mockResolvedValue(undefined)

				await exportSettings({
					providerSettingsManager: mockProviderSettingsManager,
					contextProxy: mockContextProxy,
				})

				// Should not throw an error and should preserve original settings
				expect(safeWriteJson).toHaveBeenCalledWith("/mock/path/zoo-code-settings.json", {
					providerProfiles: mockProviderProfiles,
					globalSettings: mockGlobalSettings, // Should remain unchanged
				})
			})
		})

		describe("import with OpenAI Compatible codebase indexing settings", () => {
			it("should properly import OpenAI Compatible settings in codebaseIndexConfig", async () => {
				;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/settings.json" }])

				const mockFileContent = JSON.stringify({
					providerProfiles: {
						currentApiConfigName: "openai-compatible-provider",
						apiConfigs: {
							"openai-compatible-provider": {
								apiProvider: providerIdentifiers.openai,
								id: "openai-compatible-id",
								// Provider-specific settings remain in provider profile
								codebaseIndexOpenAiCompatibleBaseUrl: "https://old-url.example.com/v1",
								codebaseIndexOpenAiCompatibleModelDimension: 512,
							},
						},
						modeApiConfigs: {},
					},
					globalSettings: {
						mode: "code",
						codebaseIndexConfig: {
							codebaseIndexEnabled: true,
							codebaseIndexEmbedderProvider: "openai-compatible" as const,
							codebaseIndexEmbedderModelId: "text-embedding-3-small",
							codebaseIndexEmbedderBaseUrl: "https://imported-url.example.com/v1",
							codebaseIndexEmbedderModelDimension: 1536,
							// OpenAI Compatible settings are now stored directly here
							codebaseIndexOpenAiCompatibleBaseUrl: "https://imported-url.example.com/v1",
						},
					},
				})

				;(fs.readFile as Mock).mockResolvedValue(mockFileContent)

				const previousProviderProfiles = {
					currentApiConfigName: "default",
					apiConfigs: { default: { apiProvider: providerIdentifiers.anthropic, id: "default-id" } },
				}

				mockProviderSettingsManager.export.mockResolvedValue(previousProviderProfiles)
				mockProviderSettingsManager.listConfig.mockResolvedValue([
					{
						name: "openai-compatible-provider",
						id: "openai-compatible-id",
						apiProvider: providerIdentifiers.openai,
					},
					{ name: "default", id: "default-id", apiProvider: providerIdentifiers.anthropic },
				])

				const result = await importSettings({
					providerSettingsManager: mockProviderSettingsManager,
					contextProxy: mockContextProxy,
					customModesManager: mockCustomModesManager,
				})

				expect(result.success).toBe(true)

				// Verify that the global settings were imported correctly
				expect(mockContextProxy.setValues).toHaveBeenCalledWith(
					expect.objectContaining({
						codebaseIndexConfig: expect.objectContaining({
							codebaseIndexOpenAiCompatibleBaseUrl: "https://imported-url.example.com/v1",
							codebaseIndexEmbedderModelDimension: 1536,
						}),
					}),
					expect.any(Function),
				)

				// Provider profiles are imported as-is
				const importedProviderProfiles = mockProviderSettingsManager.import.mock.calls[0][0]
				const importedProvider = importedProviderProfiles.apiConfigs["openai-compatible-provider"]

				// Provider still has its own settings (not modified by import)
				expect(importedProvider.codebaseIndexOpenAiCompatibleBaseUrl).toBe("https://old-url.example.com/v1")
				expect(importedProvider.codebaseIndexOpenAiCompatibleModelDimension).toBe(512)
			})

			it("should handle missing OpenAI Compatible settings gracefully during import", async () => {
				;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/settings.json" }])

				const mockFileContent = JSON.stringify({
					providerProfiles: {
						currentApiConfigName: "openai-compatible-provider",
						apiConfigs: {
							"openai-compatible-provider": {
								apiProvider: providerIdentifiers.openai,
								id: "openai-compatible-id",
							},
						},
						modeApiConfigs: {},
					},
					globalSettings: {
						mode: "code",
						codebaseIndexConfig: {
							codebaseIndexEnabled: true,
							codebaseIndexEmbedderProvider: "openai-compatible" as const,
							codebaseIndexEmbedderModelId: "text-embedding-3-small",
							// Missing base URL and model dimension
						},
					},
				})

				;(fs.readFile as Mock).mockResolvedValue(mockFileContent)

				const previousProviderProfiles = {
					currentApiConfigName: "default",
					apiConfigs: { default: { apiProvider: providerIdentifiers.anthropic, id: "default-id" } },
				}

				mockProviderSettingsManager.export.mockResolvedValue(previousProviderProfiles)
				mockProviderSettingsManager.listConfig.mockResolvedValue([
					{
						name: "openai-compatible-provider",
						id: "openai-compatible-id",
						apiProvider: providerIdentifiers.openai,
					},
				])

				const result = await importSettings({
					providerSettingsManager: mockProviderSettingsManager,
					contextProxy: mockContextProxy,
					customModesManager: mockCustomModesManager,
				})

				expect(result.success).toBe(true)
				// Should not throw an error when settings are missing
			})

			it("should not modify provider settings for non-openai-compatible providers during import", async () => {
				;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/settings.json" }])

				const mockFileContent = JSON.stringify({
					providerProfiles: {
						currentApiConfigName: "anthropic-provider",
						apiConfigs: {
							"anthropic-provider": {
								apiProvider: providerIdentifiers.anthropic,
								id: "anthropic-id",
							},
						},
						modeApiConfigs: {},
					},
					globalSettings: {
						mode: "code",
						codebaseIndexConfig: {
							codebaseIndexEnabled: true,
							codebaseIndexEmbedderProvider: providerIdentifiers.openai, // Not openai-compatible
							codebaseIndexEmbedderModelId: "text-embedding-ada-002",
							codebaseIndexEmbedderBaseUrl: "https://api.openai.com/v1",
							codebaseIndexEmbedderModelDimension: 1536,
						},
					},
				})

				;(fs.readFile as Mock).mockResolvedValue(mockFileContent)

				const previousProviderProfiles = {
					currentApiConfigName: "default",
					apiConfigs: { default: { apiProvider: providerIdentifiers.anthropic, id: "default-id" } },
				}

				mockProviderSettingsManager.export.mockResolvedValue(previousProviderProfiles)
				mockProviderSettingsManager.listConfig.mockResolvedValue([
					{ name: "anthropic-provider", id: "anthropic-id", apiProvider: providerIdentifiers.anthropic },
				])

				const result = await importSettings({
					providerSettingsManager: mockProviderSettingsManager,
					contextProxy: mockContextProxy,
					customModesManager: mockCustomModesManager,
				})

				expect(result.success).toBe(true)

				// Verify that the provider settings were not modified with OpenAI Compatible fields
				const importedProviderProfiles = mockProviderSettingsManager.import.mock.calls[0][0]
				const importedProvider = importedProviderProfiles.apiConfigs["anthropic-provider"]

				expect(importedProvider.codebaseIndexOpenAiCompatibleBaseUrl).toBeUndefined()
				expect(importedProvider.codebaseIndexOpenAiCompatibleModelDimension).toBeUndefined()
			})
		})

		it("should preserve model dimension exactly in export/import roundtrip", async () => {
			// This test specifically isolates the model dimension export/import roundtrip
			// to catch the exact issue the user is experiencing

			const testModelDimension = 768

			// Step 1: Set up a provider without OpenAI Compatible settings in profile
			const mockProviderProfiles = {
				currentApiConfigName: "test-openai-compatible",
				apiConfigs: {
					"test-openai-compatible": {
						apiProvider: providerIdentifiers.openai,
						id: "test-id",
						// Remove OpenAI Compatible settings from provider profile
					},
				},
				modeApiConfigs: {},
			}

			const mockGlobalSettings = {
				mode: "code",
				codebaseIndexConfig: {
					codebaseIndexEnabled: true,
					codebaseIndexEmbedderProvider: "openai-compatible" as const,
					codebaseIndexEmbedderModelId: "custom-embedding-model",
					codebaseIndexEmbedderBaseUrl: "https://api.example.com/v1",
					codebaseIndexEmbedderModelDimension: testModelDimension,
					// OpenAI Compatible settings are now stored directly in codebaseIndexConfig
					codebaseIndexOpenAiCompatibleBaseUrl: "https://api.example.com/v1",
				},
			}

			// Step 2: Mock export operation
			;(vscode.window.showSaveDialog as Mock).mockResolvedValue({
				fsPath: "/mock/path/test-settings.json",
			})

			mockProviderSettingsManager.export.mockResolvedValue(mockProviderProfiles)
			mockContextProxy.export.mockResolvedValue(mockGlobalSettings)
			;(fs.mkdir as Mock).mockResolvedValue(undefined)

			// Step 3: Export settings
			await exportSettings({
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
			})

			// Step 4: Verify the exported data includes the model dimension
			expect(safeWriteJson).toHaveBeenCalledWith("/mock/path/test-settings.json", {
				providerProfiles: mockProviderProfiles,
				globalSettings: mockGlobalSettings,
			})

			// Step 5: Get the exported data for import test
			const exportedData = (safeWriteJson as Mock).mock.calls[0][1]
			const exportedFileContent = JSON.stringify(exportedData)

			// Step 6: Mock import operation
			;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/test-settings.json" }])
			;(fs.readFile as Mock).mockResolvedValue(exportedFileContent)

			// Reset mocks for import
			clearAllMocks()
			mockProviderSettingsManager.export.mockResolvedValue({
				currentApiConfigName: "default",
				apiConfigs: { default: { apiProvider: providerIdentifiers.anthropic, id: "default-id" } },
			})
			mockProviderSettingsManager.listConfig.mockResolvedValue([
				{ name: "test-openai-compatible", id: "test-id", apiProvider: providerIdentifiers.openai },
			])

			// Step 7: Import the settings back
			const importResult = await importSettings({
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
				customModesManager: mockCustomModesManager,
			})

			// Step 8: Verify import was successful
			expect(importResult.success).toBe(true)

			// Step 9: Verify that the model dimension was preserved exactly in global settings
			const importedGlobalSettings = mockContextProxy.setValues.mock.calls[0][0]
			expect(importedGlobalSettings.codebaseIndexConfig?.codebaseIndexEmbedderModelDimension).toBe(
				testModelDimension,
			)
			expect(importedGlobalSettings.codebaseIndexConfig?.codebaseIndexOpenAiCompatibleBaseUrl).toBe(
				"https://api.example.com/v1",
			)

			// Step 10: Verify that the embedder settings were imported correctly
			expect(importedGlobalSettings.codebaseIndexConfig?.codebaseIndexEmbedderModelDimension).toBe(
				testModelDimension,
			)
		})

		it("should handle edge case model dimension values (0, null) correctly", async () => {
			// Test with model dimension = 0 (which is falsy but valid)
			const testModelDimension = 0

			const mockProviderProfiles = {
				currentApiConfigName: "test-openai-compatible",
				apiConfigs: {
					"test-openai-compatible": {
						apiProvider: providerIdentifiers.openai,
						id: "test-id",
						// Remove OpenAI Compatible settings from provider profile
					},
				},
				modeApiConfigs: {},
			}

			const mockGlobalSettings = {
				mode: "code",
				codebaseIndexConfig: {
					codebaseIndexEnabled: true,
					codebaseIndexEmbedderProvider: "openai-compatible" as const,
					codebaseIndexEmbedderModelId: "custom-embedding-model",
					codebaseIndexEmbedderBaseUrl: "https://api.example.com/v1",
					// OpenAI Compatible settings are now stored directly in codebaseIndexConfig
					codebaseIndexOpenAiCompatibleBaseUrl: "https://api.example.com/v1",
					codebaseIndexEmbedderModelDimension: testModelDimension, // 0 is a valid value
				},
			}

			// Mock export operation
			;(vscode.window.showSaveDialog as Mock).mockResolvedValue({
				fsPath: "/mock/path/test-settings.json",
			})

			mockProviderSettingsManager.export.mockResolvedValue(mockProviderProfiles)
			mockContextProxy.export.mockResolvedValue(mockGlobalSettings)
			;(fs.mkdir as Mock).mockResolvedValue(undefined)

			// Export settings
			await exportSettings({
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
			})

			// Verify the exported data includes the model dimension even when it's 0
			const exportedData = (safeWriteJson as Mock).mock.calls[0][1]
			expect(exportedData.globalSettings.codebaseIndexConfig.codebaseIndexEmbedderModelDimension).toBe(0)

			// Test import roundtrip
			const exportedFileContent = JSON.stringify(exportedData)
			;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/test-settings.json" }])
			;(fs.readFile as Mock).mockResolvedValue(exportedFileContent)

			// Reset mocks for import
			clearAllMocks()
			mockProviderSettingsManager.export.mockResolvedValue({
				currentApiConfigName: "default",
				apiConfigs: { default: { apiProvider: providerIdentifiers.anthropic, id: "default-id" } },
			})
			mockProviderSettingsManager.listConfig.mockResolvedValue([
				{ name: "test-openai-compatible", id: "test-id", apiProvider: providerIdentifiers.openai },
			])

			// Import the settings back
			const importResult = await importSettings({
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
				customModesManager: mockCustomModesManager,
			})

			expect(importResult.success).toBe(true)

			// Verify that model dimension 0 was preserved in global settings
			const setValuesCall = mockContextProxy.setValues.mock.calls[0][0]
			expect(setValuesCall.codebaseIndexConfig?.codebaseIndexEmbedderModelDimension).toBe(0)
		})

		it("should handle missing model dimension gracefully", async () => {
			// Test when model dimension is undefined in global state
			const mockProviderProfiles = {
				currentApiConfigName: "test-openai-compatible",
				apiConfigs: {
					"test-openai-compatible": {
						apiProvider: providerIdentifiers.openai,
						id: "test-id",
						// Remove OpenAI Compatible settings from provider profile
					},
				},
				modeApiConfigs: {},
			}

			const mockGlobalSettings = {
				mode: "code",
				codebaseIndexConfig: {
					codebaseIndexEnabled: true,
					codebaseIndexEmbedderProvider: "openai-compatible" as const,
					codebaseIndexEmbedderModelId: "custom-embedding-model",
					codebaseIndexEmbedderBaseUrl: "https://api.example.com/v1",
				},
			}

			// Mock getGlobalState to return undefined for model dimension
			mockContextProxy.getGlobalState = vi.fn().mockImplementation((key: string) => {
				if (key === "codebaseIndexOpenAiCompatibleBaseUrl") {
					return "https://api.example.com/v1"
				}
				if (key === "codebaseIndexOpenAiCompatibleModelDimension") {
					return undefined
				}
				return undefined
			})

			// Mock export operation
			;(vscode.window.showSaveDialog as Mock).mockResolvedValue({
				fsPath: "/mock/path/test-settings.json",
			})

			mockProviderSettingsManager.export.mockResolvedValue(mockProviderProfiles)
			mockContextProxy.export.mockResolvedValue(mockGlobalSettings)
			;(fs.mkdir as Mock).mockResolvedValue(undefined)

			// Export settings
			await exportSettings({
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
			})

			// Verify the exported data does NOT include model dimension when it's undefined
			const exportedData = (safeWriteJson as Mock).mock.calls[0][1]
			expect(exportedData.globalSettings.codebaseIndexConfig.codebaseIndexEmbedderModelDimension).toBeUndefined()
		})

		it("should handle provider mismatch during import - BUG REPRODUCTION", async () => {
			// This test reproduces the bug where model dimension is lost when importing
			// settings where the current provider is different from the exported provider

			// Step 1: Create exported settings from "provider-a" with model dimension
			const exportedSettings = {
				providerProfiles: {
					currentApiConfigName: "provider-a",
					apiConfigs: {
						"provider-a": {
							apiProvider: providerIdentifiers.openai,
							id: "provider-a-id",
							codebaseIndexOpenAiCompatibleBaseUrl: "https://api-a.example.com/v1",
							codebaseIndexOpenAiCompatibleModelDimension: 1536,
						},
						"provider-b": {
							apiProvider: providerIdentifiers.anthropic,
							id: "provider-b-id",
						},
					},
					modeApiConfigs: {},
				},
				globalSettings: {
					mode: "code",
					codebaseIndexConfig: {
						codebaseIndexEnabled: true,
						codebaseIndexEmbedderProvider: "openai-compatible" as const,
						codebaseIndexEmbedderModelId: "text-embedding-3-small",
						codebaseIndexEmbedderBaseUrl: "https://api-a.example.com/v1",
						codebaseIndexEmbedderModelDimension: 1536,
					},
				},
			}

			// Step 2: Set up import environment where current provider is "provider-b" (different!)
			const currentProviderProfiles = {
				currentApiConfigName: "provider-b", // Different from exported settings!
				apiConfigs: {
					"provider-b": {
						apiProvider: providerIdentifiers.anthropic,
						id: "provider-b-id",
					},
				},
			}

			// Step 3: Mock import operation
			;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/settings.json" }])
			;(fs.readFile as Mock).mockResolvedValue(JSON.stringify(exportedSettings))

			mockProviderSettingsManager.export.mockResolvedValue(currentProviderProfiles)
			mockProviderSettingsManager.listConfig.mockResolvedValue([
				{ name: "provider-a", id: "provider-a-id", apiProvider: providerIdentifiers.openai },
				{ name: "provider-b", id: "provider-b-id", apiProvider: providerIdentifiers.anthropic },
			])

			// Step 4: Import the settings
			const importResult = await importSettings({
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
				customModesManager: mockCustomModesManager,
			})

			expect(importResult.success).toBe(true)

			// Step 5: Check what was imported
			const importedProviderProfiles = mockProviderSettingsManager.import.mock.calls[0][0]

			// The bug: provider-a should have its model dimension preserved, but it might be lost
			// because the import logic only updates the CURRENT provider (provider-b)
			const providerA = importedProviderProfiles.apiConfigs["provider-a"]
			const providerB = importedProviderProfiles.apiConfigs["provider-b"]

			// This should pass but might fail due to the bug
			expect(providerA.codebaseIndexOpenAiCompatibleModelDimension).toBe(1536)
			expect(providerA.codebaseIndexOpenAiCompatibleBaseUrl).toBe("https://api-a.example.com/v1")

			// Provider B should not have OpenAI Compatible settings
			expect(providerB.codebaseIndexOpenAiCompatibleModelDimension).toBeUndefined()
			expect(providerB.codebaseIndexOpenAiCompatibleBaseUrl).toBeUndefined()
		})

		it("should NOT copy OpenAI Compatible settings to provider profiles - FIXED BEHAVIOR", async () => {
			// This test verifies the FIXED behavior: OpenAI Compatible settings stay in global settings only

			const exportedSettings = {
				providerProfiles: {
					currentApiConfigName: "openai-compatible-provider",
					apiConfigs: {
						"openai-compatible-provider": {
							apiProvider: providerIdentifiers.openai,
							id: "openai-compatible-id",
							// NO OpenAI Compatible settings here in the fixed version
						},
						"anthropic-provider": {
							apiProvider: providerIdentifiers.anthropic,
							id: "anthropic-id",
						},
					},
					modeApiConfigs: {},
				},
				globalSettings: {
					mode: "code",
					codebaseIndexConfig: {
						codebaseIndexEnabled: true,
						codebaseIndexEmbedderProvider: "openai-compatible" as const,
						codebaseIndexEmbedderModelId: "text-embedding-3-small",
						codebaseIndexEmbedderBaseUrl: "https://new-url.example.com/v1",
						codebaseIndexEmbedderModelDimension: 1536,
						// OpenAI Compatible settings are stored here
						codebaseIndexOpenAiCompatibleBaseUrl: "https://new-url.example.com/v1",
						codebaseIndexOpenAiCompatibleModelDimension: 1536,
					},
				},
			}

			const currentProviderProfiles = {
				currentApiConfigName: "anthropic-provider",
				apiConfigs: {
					"anthropic-provider": {
						apiProvider: providerIdentifiers.anthropic,
						id: "anthropic-id",
					},
				},
			}

			;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/settings.json" }])
			;(fs.readFile as Mock).mockResolvedValue(JSON.stringify(exportedSettings))

			mockProviderSettingsManager.export.mockResolvedValue(currentProviderProfiles)
			mockProviderSettingsManager.listConfig.mockResolvedValue([
				{
					name: "openai-compatible-provider",
					id: "openai-compatible-id",
					apiProvider: providerIdentifiers.openai,
				},
				{ name: "anthropic-provider", id: "anthropic-id", apiProvider: providerIdentifiers.anthropic },
			])

			const importResult = await importSettings({
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
				customModesManager: mockCustomModesManager,
			})

			expect(importResult.success).toBe(true)

			// Verify OpenAI Compatible settings are imported to global settings
			const importedGlobalSettings = mockContextProxy.setValues.mock.calls[0][0]
			expect(importedGlobalSettings.codebaseIndexConfig?.codebaseIndexOpenAiCompatibleBaseUrl).toBe(
				"https://new-url.example.com/v1",
			)
			expect(importedGlobalSettings.codebaseIndexConfig?.codebaseIndexOpenAiCompatibleModelDimension).toBe(1536)

			// Verify provider profiles do NOT have OpenAI Compatible settings
			const importedProviderProfiles = mockProviderSettingsManager.import.mock.calls[0][0]
			const openaiCompatibleProvider = importedProviderProfiles.apiConfigs["openai-compatible-provider"]
			const anthropicProvider = importedProviderProfiles.apiConfigs["anthropic-provider"]

			// Neither provider should have OpenAI Compatible settings
			expect(openaiCompatibleProvider.codebaseIndexOpenAiCompatibleBaseUrl).toBeUndefined()
			expect(openaiCompatibleProvider.codebaseIndexOpenAiCompatibleModelDimension).toBeUndefined()
			expect(anthropicProvider.codebaseIndexOpenAiCompatibleBaseUrl).toBeUndefined()
			expect(anthropicProvider.codebaseIndexOpenAiCompatibleModelDimension).toBeUndefined()
		})

		it("should keep OpenAI Compatible settings in global state only - FIXED BEHAVIOR", async () => {
			// This test verifies that OpenAI Compatible settings remain in global state
			// and are NOT copied to provider profiles

			const exportedSettings = {
				providerProfiles: {
					currentApiConfigName: "anthropic-provider",
					apiConfigs: {
						"anthropic-provider": {
							apiProvider: providerIdentifiers.anthropic,
							id: "anthropic-id",
						},
						"openai-compatible-provider": {
							apiProvider: providerIdentifiers.openai,
							id: "openai-compatible-id",
							// NO OpenAI Compatible settings in provider profiles
						},
					},
					modeApiConfigs: {},
				},
				globalSettings: {
					mode: "code",
					codebaseIndexConfig: {
						codebaseIndexEnabled: true,
						codebaseIndexEmbedderProvider: "openai-compatible" as const,
						codebaseIndexEmbedderModelId: "text-embedding-3-small",
						codebaseIndexEmbedderBaseUrl: "https://updated.example.com/v1",
						codebaseIndexEmbedderModelDimension: 1536,
						// OpenAI Compatible settings are stored here
						codebaseIndexOpenAiCompatibleBaseUrl: "https://updated.example.com/v1",
						codebaseIndexOpenAiCompatibleModelDimension: 1536,
					},
				},
			}

			const currentProviderProfiles = {
				currentApiConfigName: "default",
				apiConfigs: {
					default: {
						apiProvider: providerIdentifiers.openai,
						id: "default-id",
					},
				},
			}

			;(vscode.window.showOpenDialog as Mock).mockResolvedValue([{ fsPath: "/mock/path/settings.json" }])
			;(fs.readFile as Mock).mockResolvedValue(JSON.stringify(exportedSettings))

			mockProviderSettingsManager.export.mockResolvedValue(currentProviderProfiles)
			mockProviderSettingsManager.listConfig.mockResolvedValue([
				{ name: "anthropic-provider", id: "anthropic-id", apiProvider: providerIdentifiers.anthropic },
				{
					name: "openai-compatible-provider",
					id: "openai-compatible-id",
					apiProvider: providerIdentifiers.openai,
				},
				{ name: "default", id: "default-id", apiProvider: providerIdentifiers.openai },
			])

			const importResult = await importSettings({
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
				customModesManager: mockCustomModesManager,
			})

			expect(importResult.success).toBe(true)

			// Verify OpenAI Compatible settings are imported to global settings
			const importedGlobalSettings = mockContextProxy.setValues.mock.calls[0][0]
			expect(importedGlobalSettings.codebaseIndexConfig?.codebaseIndexOpenAiCompatibleBaseUrl).toBe(
				"https://updated.example.com/v1",
			)
			expect(importedGlobalSettings.codebaseIndexConfig?.codebaseIndexOpenAiCompatibleModelDimension).toBe(1536)

			// Verify NO provider profiles have OpenAI Compatible settings
			const importedProviderProfiles = mockProviderSettingsManager.import.mock.calls[0][0]
			const anthropicProvider = importedProviderProfiles.apiConfigs["anthropic-provider"]
			const openaiCompatibleProvider = importedProviderProfiles.apiConfigs["openai-compatible-provider"]

			// Neither provider should have OpenAI Compatible settings
			expect(anthropicProvider.codebaseIndexOpenAiCompatibleBaseUrl).toBeUndefined()
			expect(anthropicProvider.codebaseIndexOpenAiCompatibleModelDimension).toBeUndefined()
			expect(openaiCompatibleProvider.codebaseIndexOpenAiCompatibleBaseUrl).toBeUndefined()
			expect(openaiCompatibleProvider.codebaseIndexOpenAiCompatibleModelDimension).toBeUndefined()
		})

		it("should export OpenAI Compatible settings from global state when provider is openai-compatible", async () => {
			// This test reproduces the bug where codebaseIndexEmbedderModelDimension is missing from exported JSON
			// when the OpenAI Compatible settings are stored in global state via contextProxy

			;(vscode.window.showSaveDialog as Mock).mockResolvedValue({
				fsPath: "/mock/path/zoo-code-settings.json",
			})

			// Set up provider profiles - note that the OpenAI Compatible provider does NOT have
			// the codebaseIndexOpenAiCompatibleBaseUrl and codebaseIndexOpenAiCompatibleModelDimension
			// fields in the provider profile itself
			const mockProviderProfiles = {
				currentApiConfigName: "openrouter-provider", // Current provider is OpenRouter
				apiConfigs: {
					"openrouter-provider": {
						apiProvider: providerIdentifiers.openrouter,
						id: "openrouter-id",
						// OpenRouter doesn't have OpenAI Compatible fields
					},
				},
				modeApiConfigs: {},
			}

			// The global settings now include OpenAI Compatible settings directly in codebaseIndexConfig
			const mockGlobalSettings = {
				mode: "code",
				codebaseIndexConfig: {
					codebaseIndexEnabled: true,
					codebaseIndexEmbedderProvider: "openai-compatible" as const,
					codebaseIndexEmbedderModelId: "text-embedding-3-small",
					codebaseIndexEmbedderBaseUrl: "https://custom-api.example.com/v1",
					codebaseIndexEmbedderModelDimension: 1536,
					// OpenAI Compatible settings are now included directly
					codebaseIndexOpenAiCompatibleBaseUrl: "https://custom-api.example.com/v1",
					codebaseIndexOpenAiCompatibleModelDimension: 1536,
				},
			}

			mockProviderSettingsManager.export.mockResolvedValue(mockProviderProfiles)
			mockContextProxy.export.mockResolvedValue(mockGlobalSettings)
			;(fs.mkdir as Mock).mockResolvedValue(undefined)

			await exportSettings({
				providerSettingsManager: mockProviderSettingsManager,
				contextProxy: mockContextProxy,
			})

			// Verify that the exported JSON contains the OpenAI Compatible settings
			const exportedData = (safeWriteJson as Mock).mock.calls[0][1]

			// With the fix, these values are now properly exported
			expect(exportedData.globalSettings.codebaseIndexConfig.codebaseIndexOpenAiCompatibleModelDimension).toBe(
				1536,
			)
			expect(exportedData.globalSettings.codebaseIndexConfig.codebaseIndexOpenAiCompatibleBaseUrl).toBe(
				"https://custom-api.example.com/v1",
			)
		})

		it.each([
			{
				testCase: "supportsReasoningBudget is false",
				providerName: "deepseek-provider",
				modelId: "deepseek-v4-flash",
				providerId: "deepseek-id",
			},
			{
				testCase: "requiredReasoningBudget is false",
				providerName: "deepseek-provider-2",
				modelId: "deepseek-v4-pro",
				providerId: "deepseek-id-2",
			},
		])(
			"should exclude modelMaxTokens and modelMaxThinkingTokens when $testCase",
			async ({ providerName, modelId, providerId }) => {
				// This test verifies that token fields are excluded when model doesn't support reasoning budget
				// Using deepseek provider which uses apiModelId and has supportsReasoningBudget: false

				;(vscode.window.showSaveDialog as Mock).mockResolvedValue({
					fsPath: "/mock/path/zoo-code-settings.json",
				})

				// Use a real ProviderSettingsManager instance to test the actual filtering logic
				const realProviderSettingsManager = new ProviderSettingsManager(mockExtensionContext)

				// Wait for initialization to complete
				await realProviderSettingsManager.initialize()

				// Save a deepseek provider config with token fields
				await realProviderSettingsManager.saveConfig(providerName, {
					apiProvider: providerIdentifiers.deepseek,
					apiModelId: modelId,
					id: providerId,
					deepSeekApiKey: "test-key",
					modelMaxTokens: 4096, // This should be removed during export
					modelMaxThinkingTokens: 2048, // This should be removed during export
				})

				// Set this as the current provider
				await realProviderSettingsManager.activateProfile({ name: providerName })

				const mockGlobalSettings = {
					mode: "code",
					autoApprovalEnabled: true,
				}

				mockContextProxy.export.mockResolvedValue(mockGlobalSettings)
				;(fs.mkdir as Mock).mockResolvedValue(undefined)

				await exportSettings({
					providerSettingsManager: realProviderSettingsManager,
					contextProxy: mockContextProxy,
				})

				// Get the exported data
				const exportedData = (safeWriteJson as Mock).mock.calls[0][1]

				// Verify that token fields were excluded because reasoning budget is not supported/required
				const provider = exportedData.providerProfiles.apiConfigs[providerName]
				expect(provider).toBeDefined()
				expect(provider.apiModelId).toBe(modelId)
				expect("modelMaxTokens" in provider).toBe(false) // Should be excluded
				expect("modelMaxThinkingTokens" in provider).toBe(false) // Should be excluded
			},
		)
	})
})
