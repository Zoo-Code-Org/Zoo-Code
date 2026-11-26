import * as path from "node:path"
import { parentPort, workerData } from "node:worker_threads"
import { CodeParser, ParserLoadError } from "../services/code-index/processors/parser"
import { isParserAbort } from "../services/code-index/parser-errors"

interface ParseRequest {
	id: number
	filePath: string
	content: string
	fileHash: string
}

const { wasmDirectory } = workerData as { wasmDirectory: string }
const parser = new CodeParser(wasmDirectory)
let runtimeReady: Promise<void> | undefined

// The runtime WASM sits in the extension's dist/, not next to this bundle in dist/workers/.
function initializeRuntime(): Promise<void> {
	// MUST use require: an ESM import bundles web-tree-sitter's ESM build, whose import.meta.url is undefined in CJS.
	const { Parser } = require("web-tree-sitter") as typeof import("web-tree-sitter")
	runtimeReady ??= Parser.init({ locateFile: (filename: string) => path.join(wasmDirectory, filename) }).catch(
		(error: unknown) => {
			runtimeReady = undefined
			throw error
		},
	)
	return runtimeReady
}

async function parse({ filePath, content, fileHash }: ParseRequest) {
	try {
		await initializeRuntime()
	} catch (error) {
		throw isParserAbort(error) ? error : new ParserLoadError(path.extname(filePath).slice(1).toLowerCase(), error)
	}
	return parser.parseFile(filePath, { content, fileHash })
}

parentPort!.on("message", async (request: ParseRequest) => {
	try {
		parentPort!.postMessage({ id: request.id, blocks: await parse(request) })
	} catch (error) {
		const { name, message } = error instanceof Error ? error : { name: "Error", message: String(error) }
		parentPort!.postMessage({ id: request.id, error: { name, message } })
	}
})
