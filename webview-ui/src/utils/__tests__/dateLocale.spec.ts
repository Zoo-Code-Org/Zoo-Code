import { describe, expect, it } from "vitest"

import { dateLocale } from "../dateLocale"

describe("dateLocale", () => {
	it.each([
		["en", "en"],
		["pt-BR", "pt-BR"],
		["zh-cn", "zh-CN"],
		["EN-us", "en-US"],
	])("keeps the language tag %j as %j", (language, expected) => {
		expect(dateLocale(language)).toBe(expected)
	})

	it.each([[undefined], [""], ["not a tag"], ["en_US"], ["-"], ["x".repeat(100)]])(
		"leaves out %j, which is not a language tag, instead of throwing",
		(language) => {
			expect(dateLocale(language)).toBeUndefined()
		},
	)
})
