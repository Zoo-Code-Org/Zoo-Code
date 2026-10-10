import {
	DEFAULT_ALWAYS_DENY_UNAPPROVED_COMMANDS,
	DEFAULT_DESTRUCTIVE_COMMAND_GUARD_ENABLED,
	GLOBAL_SETTINGS_KEYS,
	globalSettingsSchema,
	viewStateSchema,
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
	it("preserves each webview instance selection through the persisted schema", () => {
		const parsed = globalSettingsSchema.parse({
			viewStates: {
				"session-1": { mode: "code", currentApiConfigName: "default", updatedAt: 1700000000000 },
				"session-2": { mode: "architect" },
			},
		})
		// Every field has to survive the round trip: a selection the schema drops is
		// written back as absent, so the next window opens in the default mode.
		expect(parsed.viewStates).toEqual({
			"session-1": { mode: "code", currentApiConfigName: "default", updatedAt: 1700000000000 },
			"session-2": { mode: "architect" },
		})
	})

	it("parses a single view state on its own", () => {
		expect(viewStateSchema.parse({ mode: "ask", currentApiConfigName: "x", updatedAt: 5 })).toEqual({
			mode: "ask",
			currentApiConfigName: "x",
			updatedAt: 5,
		})
	})

	it("rejects a numeric mode and names the offending path", () => {
		// The control first: the same record without the bad field must parse, so a
		// failure here can only mean the schema rejected that value - not that the record
		// shape is unsupported or the assertion never ran.
		expect(globalSettingsSchema.safeParse({ viewStates: { a: { mode: "code" } } }).success).toBe(true)

		const result = globalSettingsSchema.safeParse({ viewStates: { a: { mode: 42 } } })

		expect(result.success).toBe(false)
		expect(result.error?.issues[0]?.path).toEqual(["viewStates", "a", "mode"])
	})

	it("rejects a non-string currentApiConfigName and names the offending path", () => {
		expect(globalSettingsSchema.safeParse({ viewStates: { a: { currentApiConfigName: "x" } } }).success).toBe(true)

		const result = globalSettingsSchema.safeParse({ viewStates: { a: { currentApiConfigName: 7 } } })

		expect(result.success).toBe(false)
		expect(result.error?.issues[0]?.path).toEqual(["viewStates", "a", "currentApiConfigName"])
	})

	it("rejects a non-numeric updatedAt and names the offending path", () => {
		expect(globalSettingsSchema.safeParse({ viewStates: { a: { updatedAt: 1 } } }).success).toBe(true)

		const result = globalSettingsSchema.safeParse({ viewStates: { a: { updatedAt: "1" } } })

		expect(result.success).toBe(false)
		expect(result.error?.issues[0]?.path).toEqual(["viewStates", "a", "updatedAt"])
	})

	it("rejects a view state that is not an object", () => {
		// A bare string under a session id is what a half-migrated store looks like;
		// accepting it defers the crash to whoever reads the selection back.
		expect(globalSettingsSchema.safeParse({ viewStates: { a: { mode: "code" } } }).success).toBe(true)

		const result = globalSettingsSchema.safeParse({ viewStates: { a: "code" } })

		expect(result.success).toBe(false)
		expect(result.error?.issues[0]?.path).toEqual(["viewStates", "a"])
	})
})
