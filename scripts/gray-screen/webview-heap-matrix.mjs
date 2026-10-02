#!/usr/bin/env node
// Finds which update pattern grows the webview JS heap fastest, in real headless Chromium with the real
// webview-ui (production build in /tmp/zoo-webview-stress-build; run scripts/gray-screen/webview-render-stress.mjs once to build it).
// Each experiment reloads the page (fresh heap), hydrates a history of large tool messages, then drives updates
// for --seconds while sampling JSHeapUsedSize every 100ms. The hydration peak is reported separately (hydrPk);
// peakMB covers only the driven updates after a forced GC (baseMB).
//
//   node scripts/gray-screen/webview-heap-matrix.mjs [--seconds 20] [--heap-mb 4096] [--only name1,name2]
import fs from "node:fs"
import http from "node:http"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const require = createRequire(path.join(root, "webview-ui", "package.json"))
const { chromium } = require("@playwright/test")

const args = Object.fromEntries(
	process.argv.slice(2).reduce((acc, cur, i, all) => {
		if (cur.startsWith("--")) acc.push([cur.slice(2), all[i + 1]])
		return acc
	}, []),
)
const seconds = Number(args["seconds"] ?? 20)
const heapMb = Number(args["heap-mb"] ?? 4096)
const only = args["only"]?.split(",")
const buildDir = args["build-dir"] ?? "/tmp/zoo-webview-stress-build"
if (!fs.existsSync(path.join(buildDir, "index.html"))) {
	console.error(`No build at ${buildDir}. Run: node scripts/gray-screen/webview-render-stress.mjs --scenario session --start 100 --pushes 1`)
	process.exit(1)
}

// mode: stream = messageUpdated chunks only | turns = new messages + full state push per turn | both = turns + chunks
// Find the smallest crashing data size, or lower the cap with --heap-mb to see the live-set boundary.
const EXPERIMENTS = [
	{ name: "baseline-small-stream", mode: "stream", toolMb: 0.5, hz: 60 },
	{ name: "T100-stream-30hz", mode: "stream", toolMb: 100, hz: 30 },
	{ name: "T100-turns-2hz", mode: "turns", toolMb: 100, hz: 2 },
	// batchable: tool-only turns -> ChatView merges consecutive edit asks into one giant message (~2x memory)
	{ name: "T50-batch-turns-2hz", mode: "turns", toolMb: 50, hz: 2, batchable: true },
	{ name: "T100-batch-turns-2hz", mode: "turns", toolMb: 100, hz: 2, batchable: true },
	{ name: "T200-batch-turns-2hz", mode: "turns", toolMb: 200, hz: 2, batchable: true },
	{ name: "T300-batch-turns-2hz", mode: "turns", toolMb: 300, hz: 2, batchable: true }, // crashes at the default 4096MB cap
	{ name: "T700-turns-2hz", mode: "turns", toolMb: 700, hz: 2 }, // crashes without batching
	// realistic appliedDiff messages (diff + patch + whole pre-edit file of origBytes): originalContent inline (before) vs omitted (now)
	{ name: "E2000-orig50k-inline-turns-2hz", mode: "turns", tools: 2000, origBytes: 50000, hz: 2 },
	{ name: "E2000-orig50k-omitted-turns-2hz", mode: "turns", tools: 2000, origBytes: 50000, omitOriginal: true, hz: 2 },
	{ name: "E2000-orig50k-inline-batch-turns-2hz", mode: "turns", tools: 2000, origBytes: 50000, batchable: true, hz: 2 },
	{ name: "E2000-orig50k-omitted-batch-turns-2hz", mode: "turns", tools: 2000, origBytes: 50000, omitOriginal: true, batchable: true, hz: 2 },
	{ name: "E2000-orig50k-inline-stream-30hz", mode: "stream", tools: 2000, origBytes: 50000, hz: 30 },
	{ name: "E2000-orig50k-omitted-stream-30hz", mode: "stream", tools: 2000, origBytes: 50000, omitOriginal: true, hz: 30 },
	{ name: "E6000-orig50k-inline-turns-2hz", mode: "turns", tools: 6000, origBytes: 50000, hz: 2 },
	{ name: "E6000-orig50k-omitted-turns-2hz", mode: "turns", tools: 6000, origBytes: 50000, omitOriginal: true, hz: 2 },
	// async: pushes come from a Worker at a fixed rate regardless of how fast the webview processes them (like the real extension host)
	{ name: "T50-batch-async-2hz", mode: "async", toolMb: 50, hz: 2, batchable: true },
	{ name: "T100-batch-async-2hz", mode: "async", toolMb: 100, hz: 2, batchable: true },
	{ name: "T100-batch-async-5hz", mode: "async", toolMb: 100, hz: 5, batchable: true },
	{ name: "T100-async-2hz", mode: "async", toolMb: 100, hz: 2 },
	{ name: "T200-batch-async-2hz", mode: "async", toolMb: 200, hz: 2, batchable: true },
	{ name: "T300-batch-async-2hz", mode: "async", toolMb: 300, hz: 2, batchable: true },
	{ name: "T200-batch-async-5hz", mode: "async", toolMb: 200, hz: 5, batchable: true },
	// twoByte: tool text contains Korean chars -> UTF-16 strings (2 bytes/char) for the same character count
	{ name: "T50-batch-twobyte-2hz", mode: "turns", toolMb: 50, hz: 2, batchable: true, twoByte: true },
	{ name: "T100-batch-twobyte-2hz", mode: "turns", toolMb: 100, hz: 2, batchable: true, twoByte: true },
	{ name: "T150-batch-twobyte-2hz", mode: "turns", toolMb: 150, hz: 2, batchable: true, twoByte: true },
	{ name: "T100-turns-2hz+ballast2500", mode: "turns", toolMb: 100, hz: 2, ballastMb: 2500 }, // artificial retained heap
]

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".map": "application/json", ".woff2": "font/woff2", ".ttf": "font/ttf" }
const serveRoot = fs.realpathSync(buildDir)
// Resolves a request path to a regular file inside serveRoot (after symlink resolution), or undefined.
const resolveServedFile = (rawPath) => {
	try {
		const decoded = decodeURIComponent(rawPath)
		const real = fs.realpathSync(path.resolve(serveRoot, "." + (decoded === "/" ? "/index.html" : decoded)))
		const rel = path.relative(serveRoot, real)
		if (rel === "" || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return undefined
		return fs.statSync(real).isFile() ? real : undefined
	} catch {
		return undefined
	}
}
const httpServer = http.createServer((req, res) => {
	const file = resolveServedFile(new URL(req.url, "http://x").pathname)
	if (!file) return void res.writeHead(404).end()
	res.writeHead(200, {
		"content-type": types[path.extname(file)] ?? "application/octet-stream",
		"cross-origin-opener-policy": "same-origin",
		"cross-origin-embedder-policy": "require-corp",
	})
	fs.createReadStream(file).pipe(res)
})
await new Promise((r) => httpServer.listen(0, "127.0.0.1", r))
const url = `http://127.0.0.1:${httpServer.address().port}/`

const initScript = () => {
	window.acquireVsCodeApi = () => ({ postMessage: () => {}, getState: () => undefined, setState: () => {} })
	window.IMAGES_BASE_URI = "/"
	window.MATERIAL_ICONS_BASE_URI = "/"
}

const pageDriver = async ({ mode, toolMb, hz, chunkHz, seconds, ballastMb, batchable, twoByte, tools, origBytes, omitOriginal }) => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
	// twoByte: one non-Latin1 char makes V8 store the whole string as UTF-16 (2 bytes/char), like Korean comments/logs.
	const filler = twoByte
		? (n, seed) => {
				const base = `line ${seed}: \uD55C\uAE00 The quick brown fox jumps over the lazy dog. `
				return base.repeat(Math.ceil(n / base.length)).slice(0, n)
			}
		: (n, seed) => `line ${seed}: The quick brown fox jumps over the lazy dog. `.repeat(Math.ceil(n / 50)).slice(0, n)
	const kinds = ["newFileCreated", "appliedDiff"]
	const bigBytes = 50000
	const toolCount = tools ?? Math.max(1, Math.round((toolMb * 1048576) / bigBytes))
	let ts = Date.now() - 1e6
	let seq = 0
	const messages = [{ ts: ts++, type: "say", say: "text", text: "[STRESS] heap matrix" }]
	const addTurn = (i, big) => {
		messages.push({ ts: ts++, type: "say", say: "api_req_started", text: JSON.stringify({ apiProtocol: "openai", tokensIn: 1000, tokensOut: 200, cost: 0.001 }) })
		// batchable: tool-only turns (no visible text between edits) -> ChatView merges them into one giant batch message
		if (!(batchable && big)) messages.push({ ts: ts++, type: "say", say: "text", text: filler(300, i) })
		// origBytes: realistic appliedDiff (diff + unified patch + the whole pre-edit file). omitOriginal: what the extension sends now
		// (originalContent left out, only its length kept).
		const tool = big && origBytes
			? {
					tool: "appliedDiff",
					path: `src/gen/f${i}.ts`,
					diff: filler(1500, i),
					content: filler(2500, i),
					diffStats: { added: 20, removed: 5 },
					...(omitOriginal ? { originalContentLength: origBytes } : { originalContent: filler(origBytes, i) }),
				}
			: big
			? { tool: kinds[i % 2], path: `src/gen/f${i}.ts`, [i % 2 === 0 ? "content" : "diff"]: filler(bigBytes, i) }
			: { tool: "updateTodoList", todos: [{ id: String(i), content: `item ${i}`, status: "pending" }] }
		messages.push({ ts: ts++, type: "ask", ask: "tool", isAnswered: true, text: JSON.stringify(tool) })
		if (!(batchable && big)) messages.push({ ts: ts++, type: "say", say: "user_feedback", text: `ok ${i}` })
	}
	for (let i = 0; i < toolCount; i++) addTurn(i, true)
	const state = () => ({ type: "state", state: { version: "0.0.0", clineMessages: messages, clineMessagesSeq: ++seq, apiConfiguration: { apiProvider: "fake-ai" }, mode: "code", customModes: [], taskHistory: [], terminalShellIntegrationDisabled: true } })
	window.postMessage(state(), "*")
	await sleep(3000)
	if (!document.body.innerText.includes("[STRESS]")) return { error: "not rendered" }
	// Retained heap that is not chat data (stands in for everything else a long session keeps alive).
	window.__ballast = []
	for (let i = 0; i < (ballastMb ?? 0); i++) {
		const chunk = i + "y".repeat(1048576)
		chunk.charCodeAt(5000)
		window.__ballast.push(chunk)
	}
	await window.phaseStart()

	const live = { ts: ts++, type: "say", say: "text", text: "", partial: true }
	messages.push(live)
	window.postMessage(state(), "*")
	let posts = 0
	let turns = 0
	let chunkText = ""
	const end = performance.now() + seconds * 1000
	const chunk = () => {
		chunkText += "streamed markdown chunk with `code` and **bold** text. "
		live.text = chunkText
		window.postMessage({ type: "messageUpdated", clineMessage: { ...live } }, "*")
		posts++
	}
	const turn = () => {
		addTurn(toolCount + turns++, false)
		window.postMessage(state(), "*")
		posts++
	}
	if (mode === "stream") {
		while (performance.now() < end) {
			chunk()
			await sleep(1000 / hz)
		}
	} else if (mode === "turns") {
		while (performance.now() < end) {
			turn()
			await sleep(1000 / hz)
		}
	} else {
		let next = performance.now()
		const chunkEvery = 1000 / chunkHz
		let nextChunk = performance.now()
		while (performance.now() < end) {
			const now = performance.now()
			if (now >= next) {
				turn()
				next = now + 1000 / hz
			}
			if (now >= nextChunk) {
				chunk()
				nextChunk = now + chunkEvery
			}
			await sleep(Math.min(chunkEvery, 1000 / hz) / 2)
		}
	}
	return { posts, messages: messages.length }
}


// Decoupled sender: a Worker posts full-state pushes at a fixed rate whether or not the webview has finished the previous one
// (the real extension host is a separate process). Reports how many pushes were sent vs processed (backlog).
const pageDriverAsync = async ({ toolMb, hz, seconds, batchable, twoByte }) => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
	const workerMain = () => {
		let messages = []
		let ts = Date.now() - 1e6
		let seq = 0
		let turns = 0
		let toolCount = 0
		let p
		let counters
		const filler = (n, seed) => {
			if (p.twoByte) {
				const base = `line ${seed}: \uD55C\uAE00 The quick brown fox jumps over the lazy dog. `
				return base.repeat(Math.ceil(n / base.length)).slice(0, n)
			}
			return `line ${seed}: The quick brown fox jumps over the lazy dog. `.repeat(Math.ceil(n / 50)).slice(0, n)
		}
		const bigBytes = 50000
		const addTurn = (i, big) => {
			messages.push({ ts: ts++, type: "say", say: "api_req_started", text: JSON.stringify({ apiProtocol: "openai", tokensIn: 1000, tokensOut: 200, cost: 0.001 }) })
			if (!(p.batchable && big)) messages.push({ ts: ts++, type: "say", say: "text", text: filler(300, i) })
			const tool = big
				? { tool: i % 2 === 0 ? "newFileCreated" : "appliedDiff", path: `src/gen/f${i}.ts`, [i % 2 === 0 ? "content" : "diff"]: filler(bigBytes, i) }
				: { tool: "updateTodoList", todos: [{ id: String(i), content: `item ${i}`, status: "pending" }] }
			messages.push({ ts: ts++, type: "ask", ask: "tool", isAnswered: true, text: JSON.stringify(tool) })
			if (!(p.batchable && big)) messages.push({ ts: ts++, type: "say", say: "user_feedback", text: `ok ${i}` })
		}
		const stateMsg = () => ({ type: "state", state: { version: "0.0.0", clineMessages: messages, clineMessagesSeq: ++seq, apiConfiguration: { apiProvider: "fake-ai" }, mode: "code", customModes: [], taskHistory: [], terminalShellIntegrationDisabled: true } })
		let timer
		self.onmessage = (e) => {
			const m = e.data
			if (m.type === "init") {
				p = m.params
				counters = m.sab ? new Int32Array(m.sab) : null
				messages = [{ ts: ts++, type: "say", say: "text", text: "[STRESS] heap matrix" }]
				toolCount = Math.max(1, Math.round((p.toolMb * 1048576) / bigBytes))
				for (let i = 0; i < toolCount; i++) addTurn(i, true)
				self.postMessage({ kind: "state", data: stateMsg() })
				self.postMessage({ kind: "ready" })
			} else if (m.type === "start") {
				timer = setInterval(() => {
					addTurn(toolCount + turns++, false)
					self.postMessage({ kind: "state", data: stateMsg() })
					if (counters) Atomics.add(counters, 0, 1)
				}, 1000 / p.hz)
			} else if (m.type === "stop") {
				clearInterval(timer)
			}
		}
	}
	const sab = typeof SharedArrayBuffer !== "undefined" ? new SharedArrayBuffer(8) : null
	const counters = sab ? new Int32Array(sab) : null
	const worker = new Worker(URL.createObjectURL(new Blob(["(" + workerMain.toString() + ")()"], { type: "text/javascript" })))
	let received = 0
	let readyResolve
	const ready = new Promise((r) => (readyResolve = r))
	worker.onmessage = (e) => {
		if (e.data.kind === "state") {
			window.dispatchEvent(new MessageEvent("message", { data: e.data.data }))
			received++
		} else if (e.data.kind === "ready") {
			readyResolve()
		}
	}
	worker.postMessage({ type: "init", params: { toolMb, hz, batchable, twoByte }, sab })
	await ready
	await sleep(3000)
	if (!document.body.innerText.includes("[STRESS]")) return { error: "not rendered" }
	await window.phaseStart()
	received = 0
	worker.postMessage({ type: "start" })
	await sleep(seconds * 1000)
	const sent = counters ? Atomics.load(counters, 0) : -1
	worker.postMessage({ type: "stop" })
	return { posts: received, sent, backlog: sent - received }
}

const browser = await chromium.launch({ headless: true, args: [`--js-flags=--max-old-space-size=${heapMb}`] })
const rows = []
for (const exp of EXPERIMENTS.filter((e) => !only || only.includes(e.name))) {
	const page = await browser.newPage()
	let crashed = false
	let crashAt = null
	page.on("crash", () => {
		crashed = true
		crashAt = Date.now()
	})
	await page.addInitScript(initScript)
	await page.goto(url)
	const cdp = await page.context().newCDPSession(page)
	await cdp.send("Performance.enable")
	await cdp.send("HeapProfiler.enable")
	const heap = async () => Math.round((await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === "JSHeapUsedSize").value / 1048576)

	let peak = 0
	let hydratePeak = 0
	let baseMb = 0
	let tTo1G = null
	let samplingFrom = null
	await page.exposeFunction("phaseStart", async () => {
		hydratePeak = peak
		await cdp.send("HeapProfiler.collectGarbage")
		baseMb = await heap()
		peak = 0
		samplingFrom = Date.now()
	})
	const sampler = setInterval(async () => {
		if (crashed) return
		try {
			const h = await heap()
			peak = Math.max(peak, h)
			if (samplingFrom !== null && tTo1G === null && h >= 1024) tTo1G = ((Date.now() - samplingFrom) / 1000).toFixed(1)
		} catch {}
	}, 100)

	let result = {}
	try {
		result = await page.evaluate(exp.mode === "async" ? pageDriverAsync : pageDriver, { mode: exp.mode, toolMb: exp.toolMb, hz: exp.hz, chunkHz: exp.chunkHz, seconds, ballastMb: exp.ballastMb, batchable: exp.batchable, twoByte: exp.twoByte, tools: exp.tools, origBytes: exp.origBytes, omitOriginal: exp.omitOriginal })
	} catch (e) {
		result = { error: crashed ? "CRASHED (renderer OOM)" : e.message.split("\n")[0] }
	}
	clearInterval(sampler)
	let floorMb = "-"
	if (!crashed && !result.error) {
		await cdp.send("HeapProfiler.collectGarbage")
		floorMb = await heap()
	}
	rows.push({ name: exp.name, mode: exp.mode, toolMb: exp.toolMb, twoByte: !!exp.twoByte, ballastMb: exp.ballastMb ?? 0, rate: exp.mode === "both" ? `${exp.hz}t+${exp.chunkHz}c` : exp.hz, hydratePeakMB: hydratePeak, baseMB: baseMb, peakMB: peak, afterGC: floorMb, crashAfterSec: crashed ? (samplingFrom === null ? "during-hydration" : ((crashAt - samplingFrom) / 1000).toFixed(1)) : "-", to1GBsec: tTo1G ?? "-", posts: result.posts ?? "-", sent: result.sent ?? "-", backlog: result.backlog ?? "-", result: result.error ?? "ok" })
	console.log(JSON.stringify(rows.at(-1)))
	await page.close().catch(() => {})
}
await browser.close()
httpServer.close()

console.log("\nname".padEnd(28) + "mode".padEnd(8) + "toolMB".padEnd(8) + "rate".padEnd(10) + "hydrPk".padEnd(8) + "baseMB".padEnd(8) + "peakMB".padEnd(9) + "afterGC".padEnd(9) + "to1GB(s)".padEnd(10) + "posts".padEnd(7) + "sent".padEnd(6) + "backlog".padEnd(9) + "crashAfter(s)".padEnd(15) + "result")
for (const r of rows) {
	console.log(r.name.padEnd(28) + r.mode.padEnd(8) + String(r.toolMb).padEnd(8) + String(r.rate).padEnd(10) + String(r.hydratePeakMB).padEnd(8) + String(r.baseMB).padEnd(8) + String(r.peakMB).padEnd(9) + String(r.afterGC).padEnd(9) + String(r.to1GBsec).padEnd(10) + String(r.posts).padEnd(7) + String(r.sent).padEnd(6) + String(r.backlog).padEnd(9) + String(r.crashAfterSec).padEnd(15) + r.result)
}
