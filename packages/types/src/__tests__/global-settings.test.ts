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

describe("appearance global settings", () => {
	const bounds = {
		interfaceFontScale: { min: 50, max: 200 },
		terminalFontSize: { min: 8, max: 32 },
		editorFontSize: { min: 8, max: 32 },
		spacingScale: { min: 50, max: 200 },
	} as const
	const keys = Object.keys(bounds) as Array<keyof typeof bounds>

	it.each(keys)("%s is a persisted global setting", (key) => {
		expect(GLOBAL_SETTINGS_KEYS).toContain(key)
	})

	it.each(keys)("%s accepts the whole range, including both bounds", (key) => {
		const { min, max } = bounds[key]
		for (const value of [min, Math.round((min + max) / 2), max]) {
			expect(globalSettingsSchema.parse({ [key]: value })).toEqual({ [key]: value })
		}
	})

	it.each(keys)("%s accepts null (a saved reset) and an unset value", (key) => {
		expect(globalSettingsSchema.parse({ [key]: null })).toEqual({ [key]: null })
		expect(globalSettingsSchema.parse({})).not.toHaveProperty(key)
	})

	it.each(keys)("%s rejects out-of-range, fractional and non-numeric values", (key) => {
		const { min, max } = bounds[key]
		for (const value of [min - 1, max + 1, 0, -1, min + 0.5, Number.NaN, "100"]) {
			expect(globalSettingsSchema.safeParse({ [key]: value }).success).toBe(false)
		}
	})

	it("keeps all four values together", () => {
		const all = { interfaceFontScale: 120, terminalFontSize: 14, editorFontSize: 15, spacingScale: 80 }
		expect(globalSettingsSchema.parse(all)).toEqual(all)
	})
})
