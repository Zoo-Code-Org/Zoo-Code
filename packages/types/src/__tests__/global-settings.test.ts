import {
	DEFAULT_ALWAYS_DENY_UNAPPROVED_COMMANDS,
	DEFAULT_DESTRUCTIVE_COMMAND_GUARD_ENABLED,
	GLOBAL_SETTINGS_KEYS,
	globalSettingsSchema,
} from "../global-settings.js"
import { resolveMcpDynamicLoadSettings } from "../mcp.js"

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

describe.each(["mcp.dynamicLoad.threshold", "mcp.dynamicLoad.initialK"] as const)("%s", (key) => {
	it.each([undefined, 1, 30, 50, 100])("round-trips %s through the settings schema", (value) => {
		const settings = globalSettingsSchema.parse({ [key]: value })
		expect(globalSettingsSchema.parse(JSON.parse(JSON.stringify(settings)))[key]).toBe(value)
		expect(GLOBAL_SETTINGS_KEYS).toContain(key)
	})
	it.each([-1, 1.5, NaN, Infinity, "30", null])("rejects %s", (value) => {
		expect(globalSettingsSchema.safeParse({ [key]: value }).success).toBe(false)
	})
	it("allows zero only for the threshold", () => {
		expect(globalSettingsSchema.safeParse({ [key]: 0 }).success).toBe(key === "mcp.dynamicLoad.threshold")
	})
})

describe("runtime MCP routing defaults", () => {
	it.each([undefined, null, -1, 1.5, NaN, Infinity, "30", {}])("replaces invalid input %j", (value) => {
		expect(resolveMcpDynamicLoadSettings(value, value)).toEqual({ threshold: 50, initialK: 30 })
	})
	it("preserves a zero threshold and a positive limit", () => {
		expect(resolveMcpDynamicLoadSettings(0, 1)).toEqual({ threshold: 0, initialK: 1 })
	})
})
