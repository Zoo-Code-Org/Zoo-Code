import { captureWebviewThemeFixture } from "../useThemeFixtureProbe"

describe("captureWebviewThemeFixture", () => {
	it("captures only resolved VS Code custom properties", () => {
		document.body.className = "vscode-dark extra-class"
		document.body.dataset.vscodeThemeId = "Default Dark Modern"
		document.body.style.colorScheme = "dark"
		document.body.style.setProperty("--vscode-z-last", "rgb(2, 2, 2)")
		document.body.style.setProperty("--vscode-a-first", "#010101")
		document.body.style.setProperty("--other-variable", "ignored")

		expect(captureWebviewThemeFixture()).toEqual({
			themeId: "Default Dark Modern",
			bodyClass: "vscode-dark extra-class",
			variables: {
				"--vscode-z-last": "rgb(2, 2, 2)",
				"--vscode-a-first": "#010101",
			},
		})
	})
})
