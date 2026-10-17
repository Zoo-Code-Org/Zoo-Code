import { describe, expect, it, vi } from "vitest"
import { makeClineProviderFactory } from "../../test-utils/provider"

import { providerIdentifiers } from "@roo-code/types"

import { API } from "../api"
import type { ClineProvider } from "../../core/webview/ClineProvider"
import type { OutputChannel } from "vscode"

vi.mock("@roo-code/ipc", () => ({
	IpcServer: class {},
}))

vi.mock("../../integrations/terminal/Terminal", () => ({
	Terminal: {
		getTerminalProfile: vi.fn(),
		setTerminalProfile: vi.fn(),
	},
}))

vi.mock("../../integrations/terminal/TerminalRegistry", () => ({
	TerminalRegistry: {
		closeIdleTerminals: vi.fn(),
	},
}))

describe("API.setConfiguration", () => {
	it("routes configuration through ClineProvider.setValues so view-local state stays in sync", async () => {
		const provider = Object.assign({} as ClineProvider, {
			context: {},
			on: vi.fn(),
			setValues: vi.fn().mockResolvedValue(undefined),
			getValue: vi.fn(),
			contextProxy: {
				setValues: vi.fn().mockResolvedValue(undefined),
			},
			providerSettingsManager: {
				saveConfig: vi.fn().mockResolvedValue("default-id"),
				getProfile: vi.fn().mockRejectedValue(new Error("profile not found")),
				hasConfig: vi.fn().mockResolvedValue(false),
			},
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		})
		const api = new API(
			Object.assign({} as OutputChannel, { appendLine: vi.fn() }),
			provider,
			makeClineProviderFactory(),
		)
		const configuration = {
			apiProvider: providerIdentifiers.bedrock,
			currentApiConfigName: "default",
			awsRegion: "us-east-1",
			apiModelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
		}

		await api.setConfiguration(configuration)

		// Exact side-effect counts: a regression that repeats any of these operations
		// (duplicate settings write, duplicate profile save, duplicate webview post) fails.
		expect(provider.setValues).toHaveBeenCalledTimes(1)
		expect(provider.setValues).toHaveBeenCalledWith(configuration)
		expect(provider.contextProxy.setValues).not.toHaveBeenCalled()
		expect(provider.providerSettingsManager.saveConfig).toHaveBeenCalledTimes(1)
		expect(provider.providerSettingsManager.saveConfig).toHaveBeenCalledWith("default", configuration)
		expect(provider.postStateToWebview).toHaveBeenCalledTimes(1)
	})

	it("merges the existing profile so a partial save keeps omitted settings", async () => {
		const provider = Object.assign({} as ClineProvider, {
			context: {},
			on: vi.fn(),
			getValue: vi.fn(),
			setValues: vi.fn().mockResolvedValue(undefined),
			contextProxy: {
				setValues: vi.fn().mockResolvedValue(undefined),
			},
			providerSettingsManager: {
				getProfile: vi.fn().mockResolvedValue({
					name: "default",
					id: "default-id",
					apiProvider: providerIdentifiers.openai,
					apiModelId: "gpt-4o",
				}),
				saveConfig: vi.fn().mockResolvedValue("default-id"),
			},
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		})
		const api = new API(
			Object.assign({} as OutputChannel, { appendLine: vi.fn() }),
			provider,
			makeClineProviderFactory(),
		)

		await api.setConfiguration({
			currentApiConfigName: "default",
			apiProvider: providerIdentifiers.anthropic,
		})

		// saveConfig replaces the stored record: the partial values must land on
		// top of the existing profile so settings the caller omitted survive.
		expect(provider.providerSettingsManager.saveConfig).toHaveBeenCalledWith("default", {
			id: "default-id",
			apiProvider: providerIdentifiers.anthropic,
			apiModelId: "gpt-4o",
			currentApiConfigName: "default",
		})
	})

	it("compensates the landed writes when a later write fails", async () => {
		const provider = Object.assign({} as ClineProvider, {
			context: {},
			on: vi.fn(),
			getValue: vi.fn((key: string) => (key === "currentApiConfigName" ? "old-name" : undefined)),
			setValues: vi.fn().mockResolvedValue(undefined),
			contextProxy: {
				setValues: vi.fn().mockResolvedValue(undefined),
			},
			providerSettingsManager: {
				getProfile: vi.fn().mockRejectedValue(new Error("profile not found")),
				hasConfig: vi.fn().mockResolvedValue(false),
				getModeConfigId: vi.fn().mockResolvedValue("old-mode-id"),
				saveConfig: vi.fn().mockResolvedValue("default-id"),
				setModeConfig: vi.fn().mockRejectedValue(new Error("mode write failed")),
				deleteConfig: vi.fn().mockResolvedValue(undefined),
			},
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		})
		const api = new API(
			Object.assign({} as OutputChannel, { appendLine: vi.fn() }),
			provider,
			makeClineProviderFactory(),
		)

		await expect(
			api.setConfiguration({
				currentApiConfigName: "default",
				apiProvider: providerIdentifiers.openai,
				modeApiConfigs: { code: "new-id" },
			}),
		).rejects.toThrow("mode write failed")

		// Every landed write is undone: the mode mapping returns to its prior id, the
		// profile this call created is removed (it did not exist before), and the
		// shared values are restored through the same provider setter.
		expect(provider.providerSettingsManager.setModeConfig).toHaveBeenCalledWith("code", "old-mode-id")
		expect(provider.providerSettingsManager.deleteConfig).toHaveBeenCalledWith("default")
		expect(provider.setValues).toHaveBeenCalledTimes(2)
		expect(provider.setValues.mock.calls[1][0]).toEqual({
			currentApiConfigName: "old-name",
			apiProvider: undefined,
			modeApiConfigs: undefined,
		})
	})

	it("leaves the stored profile alone when a transient read failure makes the lookup inconclusive", async () => {
		const provider = Object.assign({} as ClineProvider, {
			context: {},
			on: vi.fn(),
			getValue: vi.fn((key: string) => (key === "currentApiConfigName" ? "old-name" : undefined)),
			setValues: vi.fn().mockResolvedValue(undefined),
			contextProxy: {
				setValues: vi.fn().mockResolvedValue(undefined),
			},
			providerSettingsManager: {
				getProfile: vi.fn().mockRejectedValue(new Error("transient read failure")),
				hasConfig: vi.fn().mockResolvedValue(true),
				getModeConfigId: vi.fn().mockResolvedValue("old-mode-id"),
				saveConfig: vi.fn().mockResolvedValue("default-id"),
				setModeConfig: vi.fn().mockRejectedValue(new Error("mode write failed")),
				deleteConfig: vi.fn().mockResolvedValue(undefined),
			},
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		})
		const appendLine = vi.fn()
		// enableLogging so the compensation notice reaches the output channel.
		const api = new API(
			Object.assign({} as OutputChannel, { appendLine }),
			provider,
			makeClineProviderFactory(),
			undefined,
			true,
		)

		await expect(
			api.setConfiguration({
				currentApiConfigName: "default",
				apiProvider: providerIdentifiers.openai,
				modeApiConfigs: { code: "new-id" },
			}),
		).rejects.toThrow("mode write failed")

		// The profile exists (hasConfig confirms it) but its read failed: deleting
		// would destroy an existing profile and there is no snapshot to restore, so
		// compensation leaves the stored record alone and says why.
		expect(provider.providerSettingsManager.deleteConfig).not.toHaveBeenCalled()
		expect(provider.providerSettingsManager.saveConfig).toHaveBeenCalledOnce()
		expect(appendLine).toHaveBeenCalledWith(
			expect.stringContaining('profile lookup for "default" was inconclusive'),
		)
	})
	it("restores the shared values when the first shared write fails partway", async () => {
		// The durable state visible to the caller once every write has settled.
		const stored: Record<string, unknown> = {}
		let sharedWriteCount = 0
		const provider = Object.assign({} as ClineProvider, {
			context: {},
			on: vi.fn(),
			getValue: vi.fn((key: string) => (key === "currentApiConfigName" ? "old-name" : undefined)),
			// ContextProxy.setValues persists keys one at a time: a rejection here can
			// mean a durable subset of the payload already landed. The first call
			// durably persists currentApiConfigName before failing; the restoration
			// call succeeds and its payload lands in `stored`.
			setValues: vi.fn(async (values: Record<string, unknown>) => {
				sharedWriteCount++
				if (sharedWriteCount === 1) {
					stored.currentApiConfigName = values.currentApiConfigName
					throw new Error("shared write failed")
				}
				Object.assign(stored, values)
			}),
			contextProxy: {
				setValues: vi.fn().mockResolvedValue(undefined),
			},
			providerSettingsManager: {
				getProfile: vi.fn().mockRejectedValue(new Error("profile not found")),
				hasConfig: vi.fn().mockResolvedValue(false),
				getModeConfigId: vi.fn().mockResolvedValue(undefined),
				saveConfig: vi.fn().mockResolvedValue("default-id"),
				setModeConfig: vi.fn().mockResolvedValue(undefined),
				deleteConfig: vi.fn().mockResolvedValue(undefined),
			},
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		})
		const api = new API(
			Object.assign({} as OutputChannel, { appendLine: vi.fn() }),
			provider,
			makeClineProviderFactory(),
		)

		await expect(
			api.setConfiguration({ currentApiConfigName: "default", apiProvider: providerIdentifiers.openai }),
		).rejects.toThrow("shared write failed")

		// Compensation runs from the first write: the fields whose durable write may
		// have landed are restored, and the later profile save never runs.
		expect(provider.setValues).toHaveBeenCalledTimes(2)
		expect(provider.setValues.mock.calls[1][0]).toEqual({
			currentApiConfigName: "old-name",
			apiProvider: undefined,
		})
		expect(provider.providerSettingsManager.saveConfig).not.toHaveBeenCalled()
		// The restoration call succeeded: the field the failed write had persisted is
		// back to the prior selection, and no other field of the failed payload
		// remains stored.
		expect(stored).toEqual({ currentApiConfigName: "old-name", apiProvider: undefined })
		expect(provider.postStateToWebview).not.toHaveBeenCalled()
	})
	it("serializes overlapping calls so snapshots cannot compensate each other", async () => {
		const calls: string[] = []
		let releaseSave: (() => void) | undefined
		const provider = Object.assign({} as ClineProvider, {
			context: {},
			on: vi.fn(),
			getValue: vi.fn(),
			setValues: vi.fn().mockResolvedValue(undefined),
			contextProxy: { setValues: vi.fn().mockResolvedValue(undefined) },
			providerSettingsManager: {
				getProfile: vi.fn().mockImplementation(async () => {
					calls.push("snapshot")
					throw new Error("profile not found")
				}),
				hasConfig: vi.fn().mockResolvedValue(false),
				deleteConfig: vi.fn().mockResolvedValue(undefined),
				saveConfig: vi.fn().mockImplementation(async () => {
					calls.push("save")
					await new Promise<void>((resolve) => {
						releaseSave = resolve
					})
					return "default-id"
				}),
			},
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		})
		const api = new API(
			Object.assign({} as OutputChannel, { appendLine: vi.fn() }),
			provider,
			makeClineProviderFactory(),
		)

		const first = api.setConfiguration({
			currentApiConfigName: "default",
			apiProvider: providerIdentifiers.anthropic,
		})
		await vi.waitFor(() => expect(calls).toEqual(["snapshot", "save"]))
		const second = api.setConfiguration({
			currentApiConfigName: "default",
			apiProvider: providerIdentifiers.openai,
		})
		// The second call must wait for the first to settle before taking its snapshot:
		// unserialized calls snapshot and compensate against each other's writes.
		await new Promise((resolve) => setImmediate(resolve))
		expect(calls).toEqual(["snapshot", "save"])
		releaseSave!()
		// The second call now parks in its own save; release it too.
		await vi.waitFor(() => expect(calls).toEqual(["snapshot", "save", "snapshot", "save"]))
		releaseSave!()
		await Promise.all([first, second])
		expect(calls).toEqual(["snapshot", "save", "snapshot", "save"])
	})

	it("awaits every mode write before compensating the landed mappings", async () => {
		const calls: string[] = []
		let landArchitect: (() => void) | undefined
		const provider = Object.assign({} as ClineProvider, {
			context: {},
			on: vi.fn(),
			getValue: vi.fn(),
			setValues: vi.fn().mockResolvedValue(undefined),
			contextProxy: { setValues: vi.fn().mockResolvedValue(undefined) },
			providerSettingsManager: {
				getProfile: vi.fn().mockRejectedValue(new Error("profile not found")),
				hasConfig: vi.fn().mockResolvedValue(false),
				deleteConfig: vi.fn().mockResolvedValue(undefined),
				saveConfig: vi.fn().mockResolvedValue("default-id"),
				getModeConfigId: vi
					.fn()
					.mockImplementation(async (mode: string) =>
						mode === "code" ? "old-code" : mode === "architect" ? "old-architect" : undefined,
					),
				setModeConfig: vi.fn().mockImplementation(async (mode: string, configId: string) => {
					if (configId === "new-code") {
						calls.push("write:code")
						throw new Error("mode write failed")
					}
					if (configId === "new-architect") {
						calls.push("write:architect")
						await new Promise<void>((resolve) => {
							landArchitect = resolve
						})
						calls.push("landed:architect")
						return
					}
					calls.push(`restore:${mode}`)
				}),
			},
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		})
		const api = new API(
			Object.assign({} as OutputChannel, { appendLine: vi.fn() }),
			provider,
			makeClineProviderFactory(),
		)

		const pending = api.setConfiguration({
			currentApiConfigName: "default",
			modeApiConfigs: { code: "new-code", architect: "new-architect" },
		})
		await vi.waitFor(() => expect(calls).toContain("write:architect"))
		landArchitect!()
		await expect(pending).rejects.toThrow("mode write failed")
		await new Promise((resolve) => setImmediate(resolve))
		// The in-flight architect write settled before the compensation restored the
		// mappings, so no mode write can land after its own restore.
		expect(calls.indexOf("landed:architect")).toBeLessThan(calls.indexOf("restore:code"))
	})
})
