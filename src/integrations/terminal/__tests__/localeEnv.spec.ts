import { getUtf8LocaleEnv } from "../localeEnv"

describe("getUtf8LocaleEnv", () => {
	it("falls back to en_US.UTF-8 when the host provides no locale at all", () => {
		expect(getUtf8LocaleEnv({})).toEqual({ LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" })
	})

	it("falls back when the host only provides empty locale variables", () => {
		expect(getUtf8LocaleEnv({ LANG: "", LC_ALL: "", LC_CTYPE: "" })).toEqual({
			LANG: "en_US.UTF-8",
			LC_ALL: "en_US.UTF-8",
		})
	})

	it("falls back for ASCII locales such as C and POSIX", () => {
		expect(getUtf8LocaleEnv({ LANG: "C" })).toEqual({ LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" })
		expect(getUtf8LocaleEnv({ LC_ALL: "POSIX" })).toEqual({ LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" })
	})

	it("leaves an inherited UTF-8 LANG untouched (#1084)", () => {
		expect(getUtf8LocaleEnv({ LANG: "en_AU.UTF-8" })).toEqual({})
		expect(getUtf8LocaleEnv({ LANG: "en_GB.UTF-8", PATH: "/usr/bin" })).toEqual({})
	})

	it("leaves an inherited UTF-8 LC_ALL untouched", () => {
		expect(getUtf8LocaleEnv({ LC_ALL: "de_DE.UTF-8" })).toEqual({})
	})

	it("accepts the utf8 spelling and LC_CTYPE as a UTF-8 signal", () => {
		expect(getUtf8LocaleEnv({ LANG: "en_AU.utf8" })).toEqual({})
		expect(getUtf8LocaleEnv({ LC_CTYPE: "zh_CN.UTF-8" })).toEqual({})
	})

	it("honors the POSIX precedence order, where LC_ALL wins over LANG", () => {
		expect(getUtf8LocaleEnv({ LANG: "en_AU.UTF-8", LC_ALL: "POSIX" })).toEqual({
			LANG: "en_US.UTF-8",
			LC_ALL: "en_US.UTF-8",
		})
	})

	it("honors the POSIX precedence order, where LC_CTYPE wins over LANG", () => {
		// Guards the resolution order: reading LANG before LC_CTYPE would wrongly
		// treat the ASCII LC_CTYPE as an inherited UTF-8 locale.
		expect(getUtf8LocaleEnv({ LANG: "en_AU.UTF-8", LC_CTYPE: "POSIX" })).toEqual({
			LANG: "en_US.UTF-8",
			LC_ALL: "en_US.UTF-8",
		})
	})

	it("honors the POSIX precedence order, where LC_ALL wins over LC_CTYPE", () => {
		// LC_ALL overrides the category variables, so a UTF-8 LC_CTYPE must not
		// rescue an ASCII LC_ALL.
		expect(getUtf8LocaleEnv({ LC_ALL: "POSIX", LC_CTYPE: "de_DE.UTF-8" })).toEqual({
			LANG: "en_US.UTF-8",
			LC_ALL: "en_US.UTF-8",
		})
	})

	it("returns a fresh object so callers cannot share and mutate the override", () => {
		const first = getUtf8LocaleEnv({})
		first.LANG = "mutated"

		expect(getUtf8LocaleEnv({})).toEqual({ LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" })
	})
})
