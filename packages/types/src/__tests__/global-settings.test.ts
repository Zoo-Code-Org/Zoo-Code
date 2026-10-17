import {
	DEFAULT_ALWAYS_DENY_UNAPPROVED_COMMANDS,
	DEFAULT_DESTRUCTIVE_COMMAND_GUARD_ENABLED,
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
describe("viewStates global setting", () => {
	it("accepts a persisted per-view record", () => {
		const parsed = globalSettingsSchema.parse({
			viewStates: {
				"view-1": { mode: "architect", currentApiConfigName: "profile-a", updatedAt: 1_700_000_000_000 },
			},
		})

		expect(GLOBAL_SETTINGS_KEYS).toContain("viewStates")
		expect(parsed.viewStates?.["view-1"]).toEqual({
			mode: "architect",
			currentApiConfigName: "profile-a",
			updatedAt: 1_700_000_000_000,
		})
	})

	it("accepts an empty entry because every field is optional", () => {
		const parsed = globalSettingsSchema.parse({ viewStates: { "view-1": {} } })

		expect(parsed.viewStates?.["view-1"]).toEqual({})
	})

	it("rejects malformed fields, non-object entries and non-record values", () => {
		expect(() => globalSettingsSchema.parse({ viewStates: { "view-1": { mode: 7 } } })).toThrow()
		expect(() => globalSettingsSchema.parse({ viewStates: { "view-1": { updatedAt: "now" } } })).toThrow()
		expect(() => globalSettingsSchema.parse({ viewStates: { "view-1": "architect" } })).toThrow()
		expect(() => globalSettingsSchema.parse({ viewStates: "view-1" })).toThrow()
	})
})
