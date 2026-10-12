import {
	DEFAULT_ALWAYS_DENY_UNAPPROVED_COMMANDS,
	DEFAULT_DESTRUCTIVE_COMMAND_GUARD_ENABLED,
	GLOBAL_SETTINGS_KEYS,
	globalSettingsSchema,
} from "../global-settings.js"

describe("chat display global settings", () => {
	it.each(["marquee", "breathing"])("accepts chatInputEffect %s", (chatInputEffect) => {
		expect(globalSettingsSchema.parse({ chatInputEffect })).toEqual({ chatInputEffect })
	})

	it.each([true, false])("accepts tableStriped %s", (tableStriped) => {
		expect(globalSettingsSchema.parse({ tableStriped })).toEqual({ tableStriped })
	})

	it("allows both settings to be omitted", () => {
		expect(globalSettingsSchema.parse({})).toEqual({})
	})

	it.each(["none", true, 1, null])("rejects invalid chatInputEffect %s", (chatInputEffect) => {
		expect(() => globalSettingsSchema.parse({ chatInputEffect })).toThrow()
	})

	it.each(["true", "false", 0, 1, null])("rejects non-boolean tableStriped %s", (tableStriped) => {
		expect(() => globalSettingsSchema.parse({ tableStriped })).toThrow()
	})
})

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

describe("alwaysDenyUnapprovedCommands global setting", () => {
	it("is opt-in by default", () => {
		expect(DEFAULT_ALWAYS_DENY_UNAPPROVED_COMMANDS).toBe(false)
	})

	it("accepts and exposes the persisted setting", () => {
		expect(globalSettingsSchema.parse({ alwaysDenyUnapprovedCommands: true })).toEqual({
			alwaysDenyUnapprovedCommands: true,
		})
		expect(GLOBAL_SETTINGS_KEYS).toContain("alwaysDenyUnapprovedCommands")
	})

	it("rejects non-boolean setting values", () => {
		expect(() => globalSettingsSchema.parse({ alwaysDenyUnapprovedCommands: "true" })).toThrow()
	})
})
