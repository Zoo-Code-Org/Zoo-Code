import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"
import { convertTheme } from "monaco-vscode-textmate-theme-converter/lib/cjs"

import { getTheme, mergeJson } from "../getTheme"
import { clearAllMocks } from "../../../test-utils/reset"

const themeExtensions = vi.hoisted(() => ({
	all: [] as {
		extensionPath?: string
		packageJSON: { contributes?: { themes: { label: string; path: string }[] } }
	}[],
}))

vi.mock("fs/promises", () => ({ readFile: vi.fn() }))
vi.mock("monaco-vscode-textmate-theme-converter/lib/cjs", () => ({ convertTheme: vi.fn() }))
vi.mock("vscode", () => ({
	workspace: { getConfiguration: vi.fn().mockReturnValue({ get: vi.fn() }) },
	extensions: {
		get all() {
			return themeExtensions.all
		},
		getExtension: () => ({ extensionUri: { fsPath: "/extension" } }),
	},
}))

beforeEach(() => {
	clearAllMocks()
	vi.mocked(vscode.workspace.getConfiguration().get).mockReturnValue("Default Dark Modern")
	themeExtensions.all = []
	vi.mocked(convertTheme).mockReturnValue({ base: "vs-dark", inherit: true, rules: [], colors: {} })
})

describe("getTheme", () => {
	it("parses comments and merges an included theme before conversion", async () => {
		vi.mocked(fs.readFile)
			.mockResolvedValueOnce('// comment\n{"include":"base.json","colors":{"foreground":"#fff"}}')
			.mockResolvedValueOnce('{"colors":{"background":"#000"},"tokenColors":[]}')

		await expect(getTheme()).resolves.toEqual({ base: "vs-dark", inherit: true, rules: [], colors: {} })
		expect(fs.readFile).toHaveBeenNthCalledWith(
			1,
			path.join("/extension", "integrations", "theme", "default-themes", "dark_modern.json"),
			"utf-8",
		)
		expect(fs.readFile).toHaveBeenNthCalledWith(
			2,
			path.join("/extension", "integrations", "theme", "default-themes", "base.json"),
			"utf-8",
		)
		expect(convertTheme).toHaveBeenCalledWith({
			include: "base.json",
			colors: { foreground: "#fff", background: "#000" },
			tokenColors: [],
		})
	})

	it.each([
		{ theme: "Default Light Modern", convertedBase: "vs-dark", expected: "vs" },
		{ theme: "Default Dark Modern", convertedBase: "vs-dark", expected: "vs-dark" },
		{ theme: "Default Dark Modern", convertedBase: "hc-black", expected: "hc-black" },
		{ theme: "Default Dark Modern", convertedBase: "vs", expected: "vs" },
	] as const)("uses $expected for $theme converted as $convertedBase", async ({ theme, convertedBase, expected }) => {
		vi.mocked(vscode.workspace.getConfiguration().get).mockReturnValue(theme)
		vi.mocked(fs.readFile).mockResolvedValueOnce("{}")
		vi.mocked(convertTheme).mockReturnValue({ base: convertedBase, inherit: true, rules: [], colors: {} })

		const result = await getTheme()

		expect(result?.base).toBe(expected)
	})

	it("loads the last extension contributing a theme matching the configured label", async () => {
		vi.mocked(vscode.workspace.getConfiguration().get).mockReturnValue("Custom Dark")
		themeExtensions.all = [
			{
				extensionPath: "/older",
				packageJSON: { contributes: { themes: [{ label: "Custom Dark", path: "old.json" }] } },
			},
			{
				extensionPath: "/custom",
				packageJSON: {
					contributes: {
						themes: [
							{ label: "Other", path: "other.json" },
							{ label: "Custom Dark", path: "theme.json" },
							{ label: "Custom Dark", path: "duplicate.json" },
						],
					},
				},
			},
			{ packageJSON: {} },
		]
		vi.mocked(fs.readFile).mockResolvedValueOnce('{"colors":{"foreground":"#abc"}}')

		await expect(getTheme()).resolves.toEqual({ base: "vs-dark", inherit: true, rules: [], colors: {} })
		expect(fs.readFile).toHaveBeenCalledExactlyOnceWith(path.join("/custom", "theme.json"), "utf-8")
		expect(convertTheme).toHaveBeenCalledWith({ colors: { foreground: "#abc" } })
	})

	it("returns undefined when theme JSON is invalid", async () => {
		vi.mocked(fs.readFile).mockResolvedValueOnce("invalid JSON")
		await expect(getTheme()).resolves.toBeUndefined()
		expect(convertTheme).not.toHaveBeenCalled()
	})
})

describe("mergeJson", () => {
	it("recursively merges objects and arrays without mutating the first theme", () => {
		const first = { colors: { foreground: "white" }, rules: ["first"], enabled: false }
		expect(
			mergeJson(first, { colors: { background: "black" }, rules: ["second"], enabled: true, size: 2 }),
		).toEqual({
			colors: { foreground: "white", background: "black" },
			rules: ["first", "second"],
			enabled: true,
			size: 2,
		})
		expect(first).toEqual({ colors: { foreground: "white" }, rules: ["first"], enabled: false })
	})

	it("replaces matching array entries using the supplied comparator", () => {
		expect(
			mergeJson({ rules: ["keep", "replace"] }, { rules: ["replace", "new"] }, "merge", {
				rules: (a, b) => a === b,
			}),
		).toEqual({ rules: ["keep", "replace", "new"] })
	})

	it("overwrites existing objects when requested", () => {
		expect(
			mergeJson({ colors: { foreground: "white" } }, { colors: { background: "black" } }, "overwrite"),
		).toEqual({ colors: { background: "black" } })
	})

	it("preserves first-only keys and lets second values win when the comparator throws", () => {
		const comparator = vi.fn(() => {
			throw new Error("comparison failed")
		})
		expect(
			mergeJson({ keep: true, rules: ["first"] }, { rules: ["second"] }, "merge", {
				rules: comparator,
			}),
		).toEqual({ keep: true, rules: ["second"] })
		expect(comparator).toHaveBeenCalled()
	})

	it("falls back to the second value when a nested merge fails", () => {
		expect(mergeJson({ colors: null }, { colors: { background: "black" } })).toEqual({
			colors: { background: "black" },
		})
	})
})
