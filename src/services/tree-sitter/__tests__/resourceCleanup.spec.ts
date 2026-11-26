import * as path from "path"
import { mkdtemp, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { loadRequiredLanguageParsers } from "../languageParser"
import { parseSourceCodeDefinitionsForFile } from ".."

vi.mock("../languageParser", () => ({ loadRequiredLanguageParsers: vi.fn() }))

const WASM_DIR = path.join(__dirname, "../../../node_modules/tree-sitter-wasms/out")

it("releases per-file parser, query, and syntax tree resources", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "zoo-python-source-"))
	const filePath = path.join(directory, "example.py")
	const actual = await vi.importActual<typeof import("../languageParser")>("../languageParser")
	const parserDeleted = vi.fn()
	const queryDeleted = vi.fn()
	const treeDeleted = vi.fn()
	vi.mocked(loadRequiredLanguageParsers).mockImplementation(async (files) => {
		const parsers = await actual.loadRequiredLanguageParsers(files, WASM_DIR)
		const { parser, query } = parsers.py
		const deleteParser = parser.delete.bind(parser)
		parser.delete = () => {
			parserDeleted()
			deleteParser()
		}
		const deleteQuery = query.delete.bind(query)
		query.delete = () => {
			queryDeleted()
			deleteQuery()
		}
		const parse = parser.parse.bind(parser)
		parser.parse = (...args: Parameters<typeof parser.parse>) => {
			const tree = parse(...args)
			if (tree) {
				const deleteTree = tree.delete.bind(tree)
				tree.delete = () => {
					treeDeleted()
					deleteTree()
				}
			}
			return tree
		}
		return parsers
	})
	try {
		await writeFile(filePath, "def example():\n    return 1\n")
		await parseSourceCodeDefinitionsForFile(filePath)
		expect(parserDeleted).toHaveBeenCalledOnce()
		expect(queryDeleted).toHaveBeenCalledOnce()
		expect(treeDeleted).toHaveBeenCalledOnce()
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
})
