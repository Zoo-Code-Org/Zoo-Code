import { readFile } from "node:fs/promises"
import * as path from "node:path"
import { Worker } from "node:worker_threads"
import { PARSE_TIMEOUT_MS } from "./constants"
import type { CodeBlock, ICodeParser } from "./interfaces"
import { isParserAbort, ParserFatalError, type ParserFatalCategory } from "./parser-errors"
import { ParserLoadError } from "./processors/parser"

export interface ParseRequest {
	id: number
	filePath: string
	content: string
	fileHash: string
}

type ParseReply =
	| { id: number; blocks: CodeBlock[] }
	| { id: number; error: { name: string; message: string } }

export interface ParseWorker {
	postMessage(request: ParseRequest): void
	on(event: "message", listener: (reply: ParseReply) => void): unknown
	on(event: "error", listener: (error: Error) => void): unknown
	on(event: "exit", listener: (code: number) => void): unknown
	terminate(): Promise<number>
}

interface PendingParse {
	request: ParseRequest
	resolve: (blocks: CodeBlock[]) => void
	reject: (error: unknown) => void
}

interface ParseSession {
	closed: boolean
	queue: PendingParse[]
	active?: PendingParse
	worker?: ParseWorker
	timer?: ReturnType<typeof setTimeout>
}

function abortError(): DOMException {
	return new DOMException("Parsing stopped", "AbortError")
}

/**
 * Parses files on a worker thread, one request at a time, so a hung or crashed grammar cannot block the host.
 *
 * 1. Session: `open(signal)` starts a session; aborting the signal closes it. A closed session rejects every
 *    request with `AbortError` and terminates its worker without awaiting the exit.
 * 2. Fatal: a timeout, a crash reply or `error` event, or an `exit` during a parse rejects that parse with
 *    `ParserFatalError`, rejects queued parses with `AbortError` and closes the session.
 * 3. Idle failure: an `exit` or `error` with no active parse only drops the worker; the next parse spawns another.
 */
export class ParseWorkerClient implements ICodeParser {
	private session: ParseSession = { closed: true, queue: [] }
	private nextId = 0

	constructor(
		private readonly workerFactory: () => ParseWorker = () =>
			new Worker(path.join(__dirname, "workers", "codeIndexParse.js"), {
				workerData: { wasmDirectory: __dirname },
			}),
		private readonly timeoutMs = PARSE_TIMEOUT_MS,
	) {}

	open(signal: AbortSignal): void {
		this.close(this.session)
		const session: ParseSession = { closed: false, queue: [] }
		this.session = session
		if (signal.aborted) this.close(session)
		else signal.addEventListener("abort", () => this.close(session), { once: true })
	}

	async parseFile(filePath: string, options?: { content?: string; fileHash?: string }): Promise<CodeBlock[]> {
		const content = options?.content ?? (await readFile(filePath, "utf8"))
		const session = this.session
		if (session.closed) throw abortError()
		return new Promise<CodeBlock[]>((resolve, reject) => {
			const request = { id: ++this.nextId, filePath, content, fileHash: options?.fileHash ?? "" }
			session.queue.push({ request, resolve, reject })
			this.dispatch(session)
		})
	}

	private dispatch(session: ParseSession): void {
		if (session.closed || session.active || session.queue.length === 0) return
		const pending = session.queue.shift()!
		session.active = pending
		try {
			const worker = session.worker ?? this.spawn(session)
			session.timer = setTimeout(
				() => this.fail(session, worker, "timeout", `No parse reply within ${this.timeoutMs} ms`),
				this.timeoutMs,
			)
			worker.postMessage(pending.request)
		} catch (error) {
			this.fail(session, session.worker, "crash", error instanceof Error ? error.message : String(error))
		}
	}

	private spawn(session: ParseSession): ParseWorker {
		const worker = this.workerFactory()
		session.worker = worker
		worker.on("message", (reply) => this.onReply(session, worker, reply))
		worker.on("error", (error) => this.fail(session, worker, "crash", error.message))
		worker.on("exit", (code) => this.fail(session, worker, "exit", `Parse worker exited with code ${code}`))
		return worker
	}

	private onReply(session: ParseSession, worker: ParseWorker, reply: ParseReply): void {
		const active = session.active
		if (session.closed || session.worker !== worker || !active || reply.id !== active.request.id) return
		if ("error" in reply) {
			const { name, message } = reply.error
			if (name === "RuntimeError" || isParserAbort(message)) {
				this.fail(session, worker, "crash", message)
				return
			}
			this.finish(session)
			if (name === "ParserLoadError") {
				const extension = path.extname(active.request.filePath).slice(1).toLowerCase()
				active.reject(new ParserLoadError(extension, new Error(message)))
			} else {
				active.reject(Object.assign(new Error(message), { name }))
			}
		} else {
			this.finish(session)
			active.resolve(reply.blocks)
		}
		this.dispatch(session)
	}

	private finish(session: ParseSession): void {
		clearTimeout(session.timer)
		session.active = undefined
	}

	private fail(
		session: ParseSession,
		worker: ParseWorker | undefined,
		category: ParserFatalCategory,
		message: string,
	): void {
		if (session.closed || session.worker !== worker) return
		const active = session.active
		if (!active) {
			session.worker = undefined
			return
		}
		this.finish(session)
		active.reject(new ParserFatalError(category, active.request.filePath, message))
		this.close(session)
	}

	private close(session: ParseSession): void {
		if (session.closed) return
		session.closed = true
		const pending = session.active ? [session.active, ...session.queue] : session.queue
		this.finish(session)
		session.queue = []
		for (const entry of pending) entry.reject(abortError())
		const worker = session.worker
		session.worker = undefined
		if (worker) void worker.terminate().catch(() => undefined)
	}
}
