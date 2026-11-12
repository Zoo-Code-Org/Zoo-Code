import { build } from "esbuild"
import * as path from "path"
import { readFile } from "fs/promises"
import * as parserConstants from "../parser-constants"

it("preserves the four foundation parser constants exactly", async () => {
	const source = await readFile(path.resolve("services/code-index/constants/index.ts"), "utf8")
	const expected = {
		MAX_BLOCK_CHARS: 1000,
		MIN_BLOCK_CHARS: 50,
		MIN_CHUNK_REMAINDER_CHARS: 200,
		MAX_CHARS_TOLERANCE_FACTOR: 1.15,
	}
	expect(parserConstants).toEqual(expected)
	for (const [name, value] of Object.entries(expected)) {
		expect(source).toMatch(new RegExp(`export const ${name} = ${String(value).replace(".", "\\.")}(?:\\s|$)`))
	}
})

it("bundles the actual parser worker without host or types/provider barrel inputs", async () => {
	const result = await build({
		entryPoints: [path.resolve("workers/codeIndexParse.ts")],
		bundle: true,
		platform: "node",
		format: "cjs",
		write: false,
		metafile: true,
	})
	const inputs = Object.keys(result.metafile.inputs).map((input) => input.replaceAll("\\", "/"))
	expect(inputs).toContain("services/code-index/processors/parser-constants.ts")
	expect(
		inputs.filter((input) =>
			/(?:code-index\/constants\/|packages\/types\/|\/providers\/|telemetry|RooIgnoreController)/.test(input),
		),
	).toEqual([])
	const imports = Object.values(result.metafile.outputs).flatMap((output) => output.imports)
	expect(imports.filter((entry) => entry.path === "vscode" || entry.path === "@roo-code/types")).toEqual([])
})
