import type { RooCodeSettings } from "@roo-code/types"

import { isInvalidDisplayValue, withoutInvalidDisplaySettings } from "../displaySettings"

describe("isInvalidDisplayValue", () => {
	it.each([
		["timeFormat", "auto"],
		["timeFormat", "12h"],
		["timeFormat", "24h"],
		["timeFormat", undefined],
		["dateFormat", "mdy"],
		["dateFormat", "ymd"],
		["showRelativeTimes", false],
		["language", "de"],
		["language", undefined],
		["language", null],
		["soundEnabled", "not a boolean"],
		["constructor", "x"],
		["toString", "y"],
	])("accepts %s = %j", (key, value) => {
		expect(isInvalidDisplayValue(key, value)).toBe(false)
	})

	it.each([
		["timeFormat", "13h"],
		["timeFormat", 24],
		["dateFormat", "dd/mm"],
		["showRelativeTimes", "yes"],
		["language", "xx-not-a-language"],
		["language", 42],
	])("rejects %s = %j", (key, value) => {
		expect(isInvalidDisplayValue(key, value)).toBe(true)
	})
})

describe("withoutInvalidDisplaySettings", () => {
	it("keeps every valid value as it is, and does not call back", () => {
		const onIgnored = vi.fn()
		const values: RooCodeSettings = { timeFormat: "12h", dateFormat: "dmy", showRelativeTimes: true, mode: "code" }

		expect(withoutInvalidDisplaySettings(values, onIgnored)).toEqual(values)
		expect(onIgnored).not.toHaveBeenCalled()
	})

	it("drops each invalid display value and says which, keeping the others", () => {
		const onIgnored = vi.fn()
		// Hand-written values that the typed signature does not allow.
		const values = { timeFormat: "13h", dateFormat: "ymd", showRelativeTimes: "yes", mode: "code" }

		expect(withoutInvalidDisplaySettings(values as unknown as RooCodeSettings, onIgnored)).toEqual({
			dateFormat: "ymd",
			mode: "code",
		})
		expect(onIgnored.mock.calls).toEqual([["timeFormat"], ["showRelativeTimes"]])
	})

	it("leaves the language to the caller: a language is not one of the three display settings", () => {
		const values = { language: "xx" } as unknown as RooCodeSettings

		expect(withoutInvalidDisplaySettings(values, vi.fn())).toEqual({ language: "xx" })
	})
})
