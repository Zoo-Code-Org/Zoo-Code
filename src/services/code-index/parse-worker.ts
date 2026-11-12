import { codeIndexLog } from "./code-index-log"
import { parentPort, workerData } from "node:worker_threads"
import { readFile } from "node:fs/promises"
import * as path from "node:path"
import { Parser } from "web-tree-sitter"
import { CodeParser } from "./processors/parser"
import { isParserAbort } from "./parser-errors"
import type { ParseRequest, ParseReply } from "./parse-worker-protocol"

let fault = process.env.ROO_PARSE_WORKER_FAULT
const { wasmDirectory } = workerData as { wasmDirectory: string }
const parser = new CodeParser(undefined, wasmDirectory)
parentPort!.on("message", async (request: ParseRequest) => {
	let reply: ParseReply
	try {
		const nextFault = fault
		fault = undefined
		if (nextFault === "abort") throw new Error("Aborted() (injected parse worker fault)")
		if (nextFault === "wasm-hang") {
			const bytes = new Uint8Array(await readFile(path.join(__dirname, "fault-loop.wasm")))
			const { instance } = await WebAssembly.instantiate(bytes)
			codeIndexLog.info("parse worker entering wasm fault loop")
			;(instance.exports.loop as () => void)()
		}
		await Parser.init({ locateFile: (filename: string) => path.join(wasmDirectory, filename) })
		const blocks = await parser.parseFile(request.filePath, {
			content: request.content,
			fileHash: request.fileHash,
		})
		reply = { id: request.id, blocks, fallback: parser.fallbackNeeded }
	} catch (error) {
		reply = {
			id: request.id,
			error: { message: error instanceof Error ? error.message : String(error), fatal: isParserAbort(error) },
		}
	}
	parentPort!.postMessage(reply)
})
