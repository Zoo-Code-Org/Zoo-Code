// npx vitest run src/__tests__/App.i18n.spec.tsx

import i18next from "i18next"

import "../App"

// App.spec.tsx mocks i18next and react-i18next, so it cannot catch App losing the import that
// initializes them. Importing the real App here proves the production entry point does.
describe("App i18n initialization", () => {
	it("initializes i18next with the bundled locales when App is imported", () => {
		expect(i18next.isInitialized).toBe(true)
		expect(i18next.hasResourceBundle("en", "chat")).toBe(true)
		expect(i18next.getResource("en", "chat", "about")).toEqual(expect.any(String))
	})
})
