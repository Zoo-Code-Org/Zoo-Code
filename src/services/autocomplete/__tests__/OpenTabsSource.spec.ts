import type { ResolvedAutocompleteConfig } from "@roo-code/types"

import { OpenTabsSource } from "../context/sources/OpenTabsSource"
import type { SnippetSourceInput } from "../context/ContextGatherer"

const visibleTextEditors: { document: FakeDocument }[] = []

vi.mock("vscode", async () => {
	const actual = await vi.importActual<typeof import("vscode")>("vscode")
	return {
		...actual,
		window: {
			get visibleTextEditors() {
				return visibleTextEditors
			},
		},
		workspace: {
			asRelativePath: (uri: { fsPath: string }) => uri.fsPath,
		},
	}
})

interface FakeDocument {
	uri: { toString: () => string; fsPath: string; scheme: string }
	languageId: string
	getText: () => string
}

function doc(path: string, languageId: string, text: string, scheme = "file"): FakeDocument {
	return {
		uri: { toString: () => `${scheme}://${path}`, fsPath: path, scheme },
		languageId,
		getText: () => text,
	}
}

function setOpenTabs(...docs: FakeDocument[]) {
	visibleTextEditors.length = 0
	visibleTextEditors.push(...docs.map((document) => ({ document })))
}

const input = (document: FakeDocument): SnippetSourceInput =>
	({ document, position: { line: 0, character: 0 }, prefix: "", suffix: "" }) as unknown as SnippetSourceInput

const source = new OpenTabsSource()
const signal = () => new AbortController().signal

beforeEach(() => {
	visibleTextEditors.length = 0
})

describe("OpenTabsSource.isEnabled", () => {
	it("follows the useOpenTabs config flag", () => {
		expect(source.isEnabled({ useOpenTabs: true } as ResolvedAutocompleteConfig)).toBe(true)
		expect(source.isEnabled({ useOpenTabs: false } as ResolvedAutocompleteConfig)).toBe(false)
	})
})

describe("OpenTabsSource.gather", () => {
	const current = doc("/ws/current.ts", "typescript", "const here = 1")

	it("collects top-level declarations from other tabs", async () => {
		setOpenTabs(current, doc("/ws/other.ts", "typescript", "export function add(a, b) {\n\treturn a + b\n}"))

		const snippets = await source.gather(input(current), signal())

		expect(snippets).toHaveLength(1)
		expect(snippets[0].content).toContain("export function add(a, b) {")
		expect(snippets[0].filePath).toBe("/ws/other.ts")
		expect(snippets[0].source).toBe("open-tabs")
	})

	it("excludes the file being edited", async () => {
		setOpenTabs(doc("/ws/current.ts", "typescript", "export function here() {}"))

		expect(await source.gather(input(current), signal())).toEqual([])
	})

	it("excludes files in another language", async () => {
		setOpenTabs(current, doc("/ws/data.json", "json", "export function nope() {}"))

		expect(await source.gather(input(current), signal())).toEqual([])
	})

	it("excludes non-file schemes such as diff and git views", async () => {
		setOpenTabs(current, doc("/ws/other.ts", "typescript", "export function nope() {}", "git"))

		expect(await source.gather(input(current), signal())).toEqual([])
	})

	it("skips a tab with no top-level declarations", async () => {
		setOpenTabs(current, doc("/ws/other.ts", "typescript", "\tconst nested = 1\n// a comment"))

		expect(await source.gather(input(current), signal())).toEqual([])
	})

	it("ignores indented declarations", async () => {
		// Nested definitions are implementation detail, not the file's surface.
		setOpenTabs(current, doc("/ws/other.ts", "typescript", "  function inner() {}\nclass Outer {}"))

		const snippets = await source.gather(input(current), signal())

		expect(snippets[0].content).toContain("class Outer {}")
		expect(snippets[0].content).not.toContain("function inner")
	})

	it("caps the number of tabs consulted", async () => {
		const others = Array.from({ length: 9 }, (_, i) =>
			doc(`/ws/f${i}.ts`, "typescript", `export function f${i}() {}`),
		)
		setOpenTabs(current, ...others)

		expect(await source.gather(input(current), signal())).toHaveLength(5)
	})

	it("caps declarations taken from a single tab", async () => {
		const many = Array.from({ length: 50 }, (_, i) => `export function f${i}() {}`).join("\n")
		setOpenTabs(current, doc("/ws/big.ts", "typescript", many))

		const snippets = await source.gather(input(current), signal())
		// One header line plus the per-tab declaration cap.
		const lines = snippets[0].content.split("\n")

		expect(lines).toHaveLength(31)
	})

	it("stops early when the signal is already aborted", async () => {
		setOpenTabs(current, doc("/ws/other.ts", "typescript", "export function add() {}"))

		const controller = new AbortController()
		controller.abort()

		expect(await source.gather(input(current), controller.signal)).toEqual([])
	})

	it("returns nothing when no other tabs are open", async () => {
		setOpenTabs(current)

		expect(await source.gather(input(current), signal())).toEqual([])
	})
})
