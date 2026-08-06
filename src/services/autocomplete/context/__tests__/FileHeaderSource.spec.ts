import type * as vscode from "vscode"

import { resolveAutocompleteConfig } from "@roo-code/types"

import { FileHeaderSource } from "../sources/FileHeaderSource"
import type { SnippetSourceInput } from "../ContextGatherer"

const makeInput = (text: string, cursorLine = 99): SnippetSourceInput =>
	({
		document: {
			getText: () => text,
			uri: { fsPath: "/project/app.py" },
			languageId: "python",
		} as unknown as vscode.TextDocument,
		position: { line: cursorLine, character: 0 } as vscode.Position,
		prefix: "",
		suffix: "",
	}) as SnippetSourceInput

const gather = (text: string, cursorLine?: number) => new FileHeaderSource().gather(makeInput(text, cursorLine))

describe("FileHeaderSource", () => {
	it("collects Python imports", async () => {
		// The reported bug: without the header the model invented `List[C]` and a
		// non-existent `pcb.C` rather than using what is actually imported.
		const snippets = await gather("from typing import Sequence\nimport math\n\ndef calculate_mean():\n    pass")

		expect(snippets[0].content).toContain("from typing import Sequence")
		expect(snippets[0].content).toContain("import math")
	})

	it("collects JavaScript and TypeScript imports", async () => {
		const snippets = await gather('import { readFile } from "fs"\n\nexport function main() {}')

		expect(snippets[0].content).toContain('import { readFile } from "fs"')
	})

	it("excludes the line under the cursor", async () => {
		const snippets = await gather("import os\nimport sys\n", 1)

		expect(snippets[0].content).toContain("import os")
		expect(snippets[0].content).not.toContain("import sys")
	})

	it("returns nothing for a file with no imports", async () => {
		expect(await gather("def f():\n    return 1")).toEqual([])
	})

	it("stops after a long run of non-import code", async () => {
		const body = Array.from({ length: 60 }, (_, i) => `x${i} = ${i}`).join("\n")
		const snippets = await gather(`import os\n${body}\nimport late`)

		expect(snippets[0].content).toContain("import os")
		expect(snippets[0].content).not.toContain("import late")
	})

	it("honours the useImportDefinitions toggle", () => {
		const source = new FileHeaderSource()

		expect(source.isEnabled(resolveAutocompleteConfig({ useImportDefinitions: true }))).toBe(true)
		expect(source.isEnabled(resolveAutocompleteConfig({ useImportDefinitions: false }))).toBe(false)
	})
})
