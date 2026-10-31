import i18next, { FALLBACK_LANGUAGE, loadLanguage } from "../setup"

// A dynamic import that rejects is what a 404 or a chunk missing from the
// deployed manifest looks like at runtime. One namespace is enough: `loadLanguage`
// registers a language only after every namespace resolves.
vi.mock("../locales/ja/common.json", () => {
	throw new Error("Failed to fetch dynamically imported module")
})

describe("i18n setup locale load failure", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("resolves without throwing and keeps the English fallback", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)

		await expect(loadLanguage("ja")).resolves.toBeUndefined()

		expect(warn).toHaveBeenCalledWith("Could not load ja translations:", expect.any(Error))
		// All-or-nothing per language: the namespaces that did resolve are not
		// registered either, so no half-translated locale can be activated.
		expect(i18next.hasResourceBundle("ja", "common")).toBe(false)
		expect(i18next.hasResourceBundle("ja", "settings")).toBe(false)
		expect(i18next.t("common:errorBoundary.title", { lng: "ja" })).toBe("Something went wrong")
	})

	it("does not memoize a failed load, so the next call re-attempts it", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)

		await loadLanguage("ja")
		await loadLanguage("ja")

		// `loadedLanguages` is only updated on success and `pendingLanguages` is
		// cleared in `finally`, so a transient failure must not be memoized.
		// This covers `loadLanguage`'s own bookkeeping only: engines that cache a
		// failed module fetch in the module map (every Chromium below 156, so the
		// VS Code webview) can still reject the second import from that cache
		// without re-requesting the chunk.
		expect(warn).toHaveBeenCalledTimes(2)
		expect(i18next.language).toBe(FALLBACK_LANGUAGE)
	})
})
