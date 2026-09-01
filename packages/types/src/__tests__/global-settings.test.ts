import {
	DEFAULT_DESTRUCTIVE_COMMAND_GUARD_ENABLED,
	DEFAULT_SHOW_MCP_DESCRIPTIONS,
	GLOBAL_SETTINGS_KEYS,
	globalSettingsSchema,
} from "../global-settings.js"

describe("destructive command guard global setting", () => {
	it("is opt-in by default", () => {
		expect(DEFAULT_DESTRUCTIVE_COMMAND_GUARD_ENABLED).toBe(false)
	})

	it("accepts and exposes the persisted setting", () => {
		expect(globalSettingsSchema.parse({ destructiveCommandGuardEnabled: true })).toEqual({
			destructiveCommandGuardEnabled: true,
		})
		expect(GLOBAL_SETTINGS_KEYS).toContain("destructiveCommandGuardEnabled")
	})

	it("rejects non-boolean setting values", () => {
		expect(() => globalSettingsSchema.parse({ destructiveCommandGuardEnabled: "true" })).toThrow()
	})
})

describe("MCP description visibility global setting", () => {
	it("preserves existing description visibility by default", () => {
		expect(DEFAULT_SHOW_MCP_DESCRIPTIONS).toBe(true)
	})

	it("accepts and exposes the persisted setting", () => {
		expect(globalSettingsSchema.parse({ showMcpDescriptions: false })).toEqual({
			showMcpDescriptions: false,
		})
		expect(GLOBAL_SETTINGS_KEYS).toContain("showMcpDescriptions")
	})

	it("rejects non-boolean setting values", () => {
		expect(() => globalSettingsSchema.parse({ showMcpDescriptions: "false" })).toThrow()
	})
})
