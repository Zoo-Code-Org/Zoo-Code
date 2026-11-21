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

describe("allowedMaxTokens global setting", () => {
	it("accepts and exposes the persisted setting", () => {
		expect(globalSettingsSchema.parse({ allowedMaxTokens: 50_000 })).toEqual({
			allowedMaxTokens: 50_000,
		})
		expect(GLOBAL_SETTINGS_KEYS).toContain("allowedMaxTokens")
	})

	it("accepts nullish values for unset budget", () => {
		expect(globalSettingsSchema.parse({ allowedMaxTokens: null })).toEqual({
			allowedMaxTokens: null,
		})
		expect(globalSettingsSchema.parse({ allowedMaxTokens: undefined })).toEqual({
			allowedMaxTokens: undefined,
		})
	})

	it("rejects non-number values", () => {
		expect(globalSettingsSchema.safeParse({ allowedMaxTokens: "50000" }).success).toBe(false)
	})
})
