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

	it("reports a failed shared-settings restore on the first write path", async () => {
		const provider = Object.assign({} as ClineProvider, {
			context: {},
			on: vi.fn(),
			getValue: vi.fn(() => undefined),
			setValues: vi
				.fn()
				.mockRejectedValueOnce(new Error("shared write failed"))
				.mockRejectedValueOnce(new Error("shared restore failed")),
			contextProxy: { setValues: vi.fn().mockResolvedValue(undefined) },
			providerSettingsManager: {
				getProfile: vi.fn().mockRejectedValue(new Error("profile not found")),
				hasConfig: vi.fn().mockResolvedValue(false),
				saveConfig: vi.fn().mockResolvedValue("default-id"),
			},
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		})
		const api = new API(
			Object.assign({} as OutputChannel, { appendLine: vi.fn() }),
			provider,
			makeClineProviderFactory(),
		)

		const failure = await api
			.setConfiguration({ currentApiConfigName: "default", apiProvider: providerIdentifiers.openai })
			.then(
				() => undefined,
				(error: unknown) => error as Error & { restoreFailures?: string[] },
			)

		expect(failure?.restoreFailures).toHaveLength(1)
		expect(failure?.message).toContain("restore the shared settings")
		expect((failure?.cause as Error).message).toBe("shared write failed")
	})

	it("reports a failed shared-settings restore on the profile-save path", async () => {
		const provider = Object.assign({} as ClineProvider, {
			context: {},
			on: vi.fn(),
			getValue: vi.fn(() => undefined),
			setValues: vi
				.fn()
				.mockResolvedValueOnce(undefined)
				.mockRejectedValueOnce(new Error("shared restore failed")),
			contextProxy: { setValues: vi.fn().mockResolvedValue(undefined) },
			providerSettingsManager: {
				getProfile: vi.fn().mockRejectedValue(new Error("profile not found")),
				hasConfig: vi.fn().mockResolvedValue(false),
				saveConfig: vi.fn().mockRejectedValue(new Error("profile write failed")),
			},
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		})
		const api = new API(
			Object.assign({} as OutputChannel, { appendLine: vi.fn() }),
			provider,
			makeClineProviderFactory(),
		)

		const failure = await api
			.setConfiguration({ currentApiConfigName: "default", apiProvider: providerIdentifiers.openai })
			.then(
				() => undefined,
				(error: unknown) => error as Error & { restoreFailures?: string[] },
			)

		expect(failure?.restoreFailures).toHaveLength(1)
		expect(failure?.message).toContain("restore the shared settings")
		expect((failure?.cause as Error).message).toBe("profile write failed")
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
			// #2110 moved the forward mode-profile write onto the provider setter (it also
			// updates this window's local mapping); the compensation restores both layers.
			setModeConfig: vi.fn().mockRejectedValue(new Error("mode write failed")),
			getLocalModeConfigId: vi.fn((mode: string) => (mode === "code" ? "old-code-local" : undefined)),
			restoreLocalModeConfig: vi.fn(),
			providerSettingsManager: {
				getProfile: vi.fn().mockRejectedValue(new Error("profile not found")),
				hasConfig: vi.fn().mockResolvedValue(false),
				getModeConfigId: vi.fn().mockResolvedValue("old-mode-id"),
				saveConfig: vi.fn().mockResolvedValue("default-id"),
				// The restore path is the manager's; it lands, so only the forward write failed.
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
		// The window-local layer belongs to the same mapping: it is snapshotted before the
		// forward write and has to go back with it, or this window keeps pointing the mode
		// at the profile the failed call picked while the shared map says otherwise.
		expect(provider.getLocalModeConfigId).toHaveBeenCalledWith("code")
		expect(provider.getLocalModeConfigId.mock.invocationCallOrder[0]).toBeLessThan(
			provider.setModeConfig.mock.invocationCallOrder[0],
		)
		expect(provider.restoreLocalModeConfig).toHaveBeenCalledWith("code", "old-code-local")
		expect(provider.providerSettingsManager.deleteConfig).toHaveBeenCalledWith("default")
		expect(provider.setValues).toHaveBeenCalledTimes(2)
		expect(provider.setValues.mock.calls[1][0]).toEqual({
			currentApiConfigName: "old-name",
			apiProvider: undefined,
			modeApiConfigs: undefined,
		})
	})

	it("restores this window's local mode mapping for every mode in the call", async () => {
		const provider = Object.assign({} as ClineProvider, {
			context: {},
			on: vi.fn(),
			getValue: vi.fn((key: string) => (key === "currentApiConfigName" ? "old-name" : undefined)),
			setValues: vi.fn().mockResolvedValue(undefined),
			contextProxy: { setValues: vi.fn().mockResolvedValue(undefined) },
			// The forward write lands in the window's own map as well as the shared one, so
			// compensation has to undo both layers.
			setModeConfig: vi.fn().mockRejectedValueOnce(new Error("mode write failed")),
			// "code" had a window-local choice; "architect" had none and must fall back to
			// this window's opening snapshot afterwards.
			getLocalModeConfigId: vi.fn((mode: string) => (mode === "code" ? "old-code-local" : undefined)),
			restoreLocalModeConfig: vi.fn(),
			providerSettingsManager: {
				getProfile: vi.fn().mockRejectedValue(new Error("profile not found")),
				hasConfig: vi.fn().mockResolvedValue(false),
				getModeConfigId: vi.fn().mockResolvedValue("old-shared-id"),
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
			api.setConfiguration({
				currentApiConfigName: "default",
				modeApiConfigs: { code: "new-code", architect: "new-architect" },
			}),
		).rejects.toThrow("mode write failed")

		// Both layers are rewound, for every mode the call touched: the previously absent
		// key goes back to undefined (deleting the entry restores the opening-snapshot
		// fallback) instead of keeping the id this failed call wrote.
		expect(provider.restoreLocalModeConfig).toHaveBeenCalledWith("code", "old-code-local")
		expect(provider.restoreLocalModeConfig).toHaveBeenCalledWith("architect", undefined)
		expect(provider.providerSettingsManager.setModeConfig).toHaveBeenCalledWith("code", "old-shared-id")
		expect(provider.providerSettingsManager.setModeConfig).toHaveBeenCalledWith("architect", "old-shared-id")
	})

	it("reports every failed compensation on the error instead of only logging it", async () => {
		const provider = Object.assign({} as ClineProvider, {
			context: {},
			on: vi.fn(),
			getValue: vi.fn((key: string) => (key === "currentApiConfigName" ? "old-name" : undefined)),
			setValues: vi
				.fn()
				.mockResolvedValueOnce(undefined) // the forward write lands
				.mockRejectedValueOnce(new Error("shared restore failed")), // the compensation does not
			contextProxy: {
				setValues: vi.fn().mockResolvedValue(undefined),
			},
			// #2110: the forward write goes through the provider setter, the restore through
			// the manager - both fail here, so both failures must be reported.
			setModeConfig: vi.fn().mockRejectedValueOnce(new Error("mode write failed")),
			getLocalModeConfigId: vi.fn(),
			restoreLocalModeConfig: vi.fn(),

			providerSettingsManager: {
				getProfile: vi.fn().mockRejectedValue(new Error("profile not found")),
				hasConfig: vi.fn().mockResolvedValue(false),
				getModeConfigId: vi.fn().mockResolvedValue("old-mode-id"),
				saveConfig: vi.fn().mockResolvedValue("default-id"),
				// The forward mode write fails, and the mode restore fails too.
				setModeConfig: vi.fn().mockRejectedValue(new Error("mode restore failed")),
				deleteConfig: vi.fn().mockResolvedValue(undefined),
			},
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		})
		const api = new API(
			Object.assign({} as OutputChannel, { appendLine: vi.fn() }),
			provider,
			makeClineProviderFactory(),
		)

		const failure = await api
			.setConfiguration({
				currentApiConfigName: "default",
				apiProvider: providerIdentifiers.openai,
				modeApiConfigs: { code: "new-id" },
			})
			.then(
				() => undefined,
				(error: unknown) => error as Error & { restoreFailures?: string[] },
			)

		// Both failed restores are reported on the thrown error, not just logged, so a
		// caller can tell the compensation is incomplete.
		expect(failure).toBeInstanceOf(Error)
		expect(failure?.message).toContain("compensation step(s) also failed")
		expect(failure?.message).toContain("restore the mode mapping for code")
		expect(failure?.message).toContain("restore the shared settings")
		expect(failure?.restoreFailures).toHaveLength(2)
		// The original write failure is preserved as the cause.
		expect((failure?.cause as Error).message).toBe("mode write failed")
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
			// #2110 moved the forward mode-profile write onto the provider setter; the
			// compensation still restores through the manager below.
			setModeConfig: vi.fn().mockRejectedValue(new Error("mode write failed")),
			getLocalModeConfigId: vi.fn(),
			restoreLocalModeConfig: vi.fn(),

			providerSettingsManager: {
				getProfile: vi.fn().mockRejectedValue(new Error("transient read failure")),
				hasConfig: vi.fn().mockResolvedValue(true),
				getModeConfigId: vi.fn().mockResolvedValue("old-mode-id"),
				saveConfig: vi.fn().mockResolvedValue("default-id"),
				setModeConfig: vi.fn().mockResolvedValue(undefined),
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
		const setModeConfig = vi.fn().mockImplementation(async (mode: string, configId: string) => {
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
		})
		const provider = Object.assign({} as ClineProvider, {
			context: {},
			on: vi.fn(),
			getValue: vi.fn(),
			setValues: vi.fn().mockResolvedValue(undefined),
			contextProxy: { setValues: vi.fn().mockResolvedValue(undefined) },
			// #2110 routes the forward mode writes through the provider setter and leaves the
			// compensation restore on the manager; one recorder backs both surfaces so the
			// ordering asserted below is the real cross-path ordering.
			setModeConfig,
			getLocalModeConfigId: vi.fn(),
			restoreLocalModeConfig: vi.fn(),

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
				setModeConfig,
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
