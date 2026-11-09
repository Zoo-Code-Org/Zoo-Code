import { afterAll, beforeAll } from "vitest"

/**
 * jsdom has no VS Code theme. While the tests of a file run, the editor font size of VS Code is `px` (VS Code always
 * has one), so the size that the terminal stepper shows while it is unset is the same in every run. Restores what was
 * there afterwards.
 */
export function withVscodeEditorFontSize(px: number) {
	let before = ""
	beforeAll(() => {
		before = document.documentElement.style.getPropertyValue("--vscode-editor-font-size")
		document.documentElement.style.setProperty("--vscode-editor-font-size", `${px}px`)
	})
	afterAll(() => {
		if (before) document.documentElement.style.setProperty("--vscode-editor-font-size", before)
		else document.documentElement.style.removeProperty("--vscode-editor-font-size")
	})
}
