import path from "path"
import { Language } from "web-tree-sitter"

export const TEST_WASM_DIR = path.join(__dirname, "../../../node_modules/tree-sitter-wasms/out")

export async function loadTestGrammar(filename: string, directory = TEST_WASM_DIR) {
	const wasmPath = path.join(directory, filename)
	try {
		return await Language.load(wasmPath)
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error)
		throw new Error(`Failed to load Tree-sitter grammar ${filename} from ${wasmPath}: ${detail}`, { cause: error })
	}
}
