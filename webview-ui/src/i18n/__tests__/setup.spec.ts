import i18next, { FALLBACK_LANGUAGE, loadLanguage } from "../setup"

describe("i18n setup locale loading", () => {
	it("ships the fallback locale eagerly", () => {
		expect(i18next.hasResourceBundle(FALLBACK_LANGUAGE, "common")).toBe(true)
		expect(i18next.hasResourceBundle(FALLBACK_LANGUAGE, "settings")).toBe(true)
	})

	it("does not ship non-fallback locales in the entry graph", () => {
		// `hasResourceBundle` is false until `loadLanguage` fetches a chunk, which
		// is what keeps the 17 other locales out of the first paint.
		for (const language of ["ko", "ja", "de", "zh-CN"]) {
			expect(i18next.hasResourceBundle(language, "common")).toBe(false)
		}
	})

	it("registers every namespace of a lazily loaded locale", async () => {
		await loadLanguage("ko")

		expect(i18next.hasResourceBundle("ko", "common")).toBe(true)
		expect(i18next.hasResourceBundle("ko", "settings")).toBe(true)
		expect(i18next.t("common:errorBoundary.title", { lng: "ko" })).toBe("문제가 발생했습니다")
	})

	it("shares one fetch across concurrent requests for the same locale", async () => {
		const addResourceBundle = vi.spyOn(i18next, "addResourceBundle")

		// `loadLanguage` memoizes the in-flight promise, so concurrent callers get
		// the very same promise back: one fetch, one registration pass.
		const inFlight = [loadLanguage("ja"), loadLanguage("ja"), loadLanguage("ja")]
		expect(inFlight[1]).toBe(inFlight[0])
		expect(inFlight[2]).toBe(inFlight[0])

		const results = await Promise.all(inFlight)

		expect(results).toHaveLength(3)
		// 9 namespaces registered once each, not 27.
		expect(addResourceBundle).toHaveBeenCalledTimes(9)
		expect(i18next.t("common:errorBoundary.title", { lng: "ja" })).toBe("問題が発生しました")
	})

	it("resolves without throwing for a locale that has no bundles", async () => {
		await expect(loadLanguage("xx-unsupported")).resolves.toBeUndefined()
		expect(i18next.t("common:errorBoundary.title", { lng: "xx-unsupported" })).toBe("Something went wrong")
	})
})
