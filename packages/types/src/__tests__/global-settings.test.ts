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
	it("parses a valid per-view record", () => {
		const parsed = globalSettingsSchema.parse({
			viewStates: {
				"stable-view-1": { mode: "code", currentApiConfigName: "profile-a", updatedAt: 1730000000000 },
				"stable-view-2": {},
			},
		})
		expect(parsed.viewStates?.["stable-view-1"]).toEqual({
			mode: "code",
			currentApiConfigName: "profile-a",
			updatedAt: 1730000000000,
		})
		expect(parsed.viewStates?.["stable-view-2"]).toEqual({})
		expect(GLOBAL_SETTINGS_KEYS).toContain("viewStates")
	})

	it("rejects invalid field values inside a view entry", () => {
		expect(() => globalSettingsSchema.parse({ viewStates: { v: { mode: 42 } } })).toThrow()
		expect(() => globalSettingsSchema.parse({ viewStates: { v: { currentApiConfigName: 42 } } })).toThrow()
		expect(() => globalSettingsSchema.parse({ viewStates: { v: { updatedAt: "soon" } } })).toThrow()
	})

	it("rejects non-object viewStates values", () => {
		expect(() => globalSettingsSchema.parse({ viewStates: "not-a-record" })).toThrow()
		expect(() => globalSettingsSchema.parse({ viewStates: { v: "not-an-entry" } })).toThrow()
	})
})

describe("collapseCommandOutputByDefault global setting", () => {
	it.each([true, false, undefined])("round-trips %s through the export/import schema", (value) => {
		const settings = globalSettingsSchema.parse({ collapseCommandOutputByDefault: value })
		expect(globalSettingsSchema.parse(JSON.parse(JSON.stringify(settings))).collapseCommandOutputByDefault).toBe(
			value,
		)
		expect(GLOBAL_SETTINGS_KEYS).toContain("collapseCommandOutputByDefault")
	})
	it("rejects non-boolean values", () => {
		expect(globalSettingsSchema.safeParse({ collapseCommandOutputByDefault: "true" }).success).toBe(false)
	})
})
