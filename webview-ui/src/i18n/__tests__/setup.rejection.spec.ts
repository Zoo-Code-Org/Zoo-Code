import i18next, { loadLanguage } from "../setup"

// A dynamic import that rejects is what a 404 or a chunk missing from the
// deployed manifest looks like at runtime. One namespace is enough: `loadLanguage`
// registers a language only after every namespace resolves.
const loader = vi.hoisted(() => ({ calls: 0, fail: true }))

vi.mock("../locales/ja/common.json", () => {
	loader.calls++

	if (loader.fail) {
		throw new Error("Failed to fetch dynamically imported module")
	}

	return { default: { errorBoundary: { title: "問題が発生しました" } } }
})

describe("i18n setup locale load failure", () => {
	beforeEach(() => {
		loader.calls = 0
		loader.fail = true
	})

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
		// eslint-disable-next-line no-restricted-syntax -- checks loaded resources outside React; nothing is memoized
		expect(i18next.t("common:errorBoundary.title", { lng: "ja" })).toBe("Something went wrong")
	})

	it("does not memoize a failed load, so the next call re-attempts it", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)

		await loadLanguage("ja")
		expect(loader.calls).toBe(1)

		await loadLanguage("ja")
		expect(loader.calls).toBe(2)

		// `loadedLanguages` is only updated on success and `pendingLanguages` is
		// cleared in `finally`, so a transient failure must not be memoized.
		// This covers `loadLanguage`'s own bookkeeping only: engines that cache a
		// failed module fetch in the module map (every Chromium below 156, so the
		// VS Code webview) can still reject the second import from that cache
		// without re-requesting the chunk.
		expect(warn).toHaveBeenCalledTimes(2)
	})

	it("registers the bundles when a later attempt succeeds", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined)

		await loadLanguage("ja")
		expect(i18next.hasResourceBundle("ja", "common")).toBe(false)

		loader.fail = false
		await loadLanguage("ja")

		// eslint-disable-next-line no-restricted-syntax -- checks loaded resources outside React; nothing is memoized
		expect(i18next.t("common:errorBoundary.title", { lng: "ja" })).toBe("問題が発生しました")
	})
})
