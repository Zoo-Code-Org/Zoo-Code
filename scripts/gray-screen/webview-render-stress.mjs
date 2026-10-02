#!/usr/bin/env node
// Real-render stress harness: boots the actual webview-ui (webview-ui) in headless Chromium,
// fakes acquireVsCodeApi, and feeds it extension-host-style messages while measuring real
// rendering latency (rAF), DOM size and V8 heap (before/after forced GC) via CDP.
//
// Usage (from repo root):
//   node scripts/gray-screen/webview-render-stress.mjs --scenario session|command|md [options]
//     --start 5000        initial message count            (session)
//     --pushes 300        number of full-state pushes      (session)
//     --grow 4            messages added per push          (session)
//     --chunks 20         streaming chunks per push        (session)
//     --rate 200          output messages/second           (command)
//     --seconds 60        duration                         (command)
//     --turns 40          streamed markdown turns          (md)
//     --text-bytes 15000  markdown size per turn           (md; also session)
//     --chunk-ms 15       ms between streamed chunks       (md)
//     --mermaid-every 10  mermaid diagram every N turns    (md; 0 disables)
//     --alloc-profile true  print top allocators (CDP sampling heap profiler, md)
//     --build-mode development  unminified build (readable function names) in a separate dir
//     --heap-mb 1024      V8 old-space cap (default 1024; 4096 for md)
//     --skip-build true   reuse the previous build in /tmp/zoo-webview-stress-build
//     --messages-file <ui_messages.json>  seed history from a generated task (generate-large-task.mjs)
//     --url http://...    use an already running server instead of building/serving
//     --headed            show the browser
import { spawn } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { resolveBuildDir, resolveServedFile } from "./lib.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const webviewDir = path.join(root, "webview-ui")
const require = createRequire(path.join(webviewDir, "package.json"))
const { chromium } = require("@playwright/test")

const args = Object.fromEntries(
	process.argv.slice(2).reduce((acc, cur, i, all) => {
		if (cur.startsWith("--")) acc.push([cur.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? "true" : all[i + 1]])
		return acc
	}, []),
)
const cfg = {
	scenario: args["scenario"] ?? "session",
	start: Number(args["start"] ?? 5000),
	pushes: Number(args["pushes"] ?? 300),
	grow: Number(args["grow"] ?? 4),
	chunks: Number(args["chunks"] ?? 20),
	rate: Number(args["rate"] ?? 200),
	seconds: Number(args["seconds"] ?? 60),
	heapMb: Number(args["heap-mb"] ?? (args["scenario"] === "md" ? 4096 : 1024)),
	textBytes: Number(args["text-bytes"] ?? (args["scenario"] === "md" ? 15000 : 800)),
	turns: Number(args["turns"] ?? 40),
	chunkMs: Number(args["chunk-ms"] ?? 15),
	mermaidEvery: Number(args["mermaid-every"] ?? 10),
	url: args["url"],
	headed: args["headed"] === "true",
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const buildMode = args["build-mode"] ?? "production"
const buildDir = resolveBuildDir(buildMode)

function run(cmd, cmdArgs, opts) {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, cmdArgs, { stdio: ["ignore", "ignore", "inherit"], ...opts })
		child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))))
	})
}

// Production build into a temp dir (never touches src/webview-ui/build), then serve it statically.
async function startServer() {
	if (args["skip-build"] !== "true" || !fs.existsSync(path.join(buildDir, "index.html"))) {
		console.log("building webview-ui (production) into", buildDir, "...")
		await run("pnpm", ["exec", "vite", "build", "--outDir", buildDir, "--emptyOutDir", "--mode", buildMode], {
			cwd: webviewDir,
		})
	}
	const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".map": "application/json", ".woff2": "font/woff2", ".ttf": "font/ttf" }
	const httpServer = http.createServer((req, res) => {
		const file = resolveServedFile(buildDir, new URL(req.url, "http://x").pathname)
		if (!file) {
			res.writeHead(404).end()
			return
		}
		res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" })
		fs.createReadStream(file).pipe(res)
	})
	await new Promise((r) => httpServer.listen(0, "127.0.0.1", r))
	return { url: `http://127.0.0.1:${httpServer.address().port}/`, child: { kill: () => httpServer.close() } }
}

const initScript = () => {
	window.__posted = 0
	window.acquireVsCodeApi = () => ({
		postMessage: () => {
			window.__posted++
		},
		getState: () => undefined,
		setState: () => {},
	})
	window.IMAGES_BASE_URI = "/"
	window.MATERIAL_ICONS_BASE_URI = "/"
}

const baseState = (extra) => ({
	version: "0.0.0",
	clineMessages: [],
	taskHistory: [],
	apiConfiguration: { apiProvider: "fake-ai" },
	mode: "code",
	customModes: [],
	terminalShellIntegrationDisabled: true,
	...extra,
})

const pageHelpers = () => {
	window.__stress = {
		filler: (n, seed) => `line ${seed}: The quick brown fox jumps over the lazy dog. `.repeat(Math.ceil(n / 50)).slice(0, n),
		raf: () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
		emit: (data) => window.postMessage(data, "*"),
	}
}

async function main() {
	const server = cfg.url ? null : await startServer()
	const url = cfg.url ?? server.url
	const browser = await chromium.launch({
		headless: !cfg.headed,
		args: [`--js-flags=--max-old-space-size=${cfg.heapMb}`, "--enable-precise-memory-info"],
	})
	const page = await browser.newPage()
	let crashed = false
	page.on("crash", () => {
		crashed = true
		console.error("\n*** PAGE CRASHED (renderer died: this is the 'gray screen') ***")
	})
	page.on("pageerror", (e) => console.error("[pageerror]", e.message.split("\n")[0]))
	await page.addInitScript(initScript)
	await page.goto(url)
	await page.evaluate(pageHelpers)
	const cdp = await page.context().newCDPSession(page)
	await cdp.send("Performance.enable")
	await cdp.send("HeapProfiler.enable")

	const heap = async (gc) => {
		if (gc) await cdp.send("HeapProfiler.collectGarbage")
		const { metrics } = await cdp.send("Performance.getMetrics")
		return Math.round(metrics.find((m) => m.name === "JSHeapUsedSize").value / 1048576)
	}
	const dom = () => page.evaluate(() => document.getElementsByTagName("*").length)
	const frame = async () => {
		const t = Date.now()
		await page.evaluate(() => window.__stress.raf())
		return Date.now() - t
	}

	const emit = (data) => page.evaluate((d) => window.__stress.emit(d), data)
	const ts0 = Date.now() - 1e6
	let ts = ts0
	let seq = 0
	const messages = [{ ts: ts++, type: "say", say: "text", text: "[STRESS] simulated long session" }]
	const round = (i) => [
		{ ts: ts++, type: "say", say: "api_req_started", text: JSON.stringify({ apiProtocol: "openai", tokensIn: 1000, tokensOut: 200, cost: 0.001 }) },
		{ ts: ts++, type: "say", say: "text", text: `line ${i}: ${"The quick brown fox jumps over the lazy dog. ".repeat(Math.ceil(cfg.textBytes / 45))}`.slice(0, cfg.textBytes) },
		{ ts: ts++, type: "ask", ask: "tool", isAnswered: true, text: JSON.stringify({ tool: "appliedDiff", path: `src/f${i}.ts`, diff: "x".repeat(cfg.textBytes) }) },
		{ ts: ts++, type: "say", say: "user_feedback", text: `ok ${i}` },
	]
	if (args["messages-file"]) {
		// Seed with a task generated by scripts/gray-screen/generate-large-task.mjs (ui_messages.json).
		messages.length = 0
		messages.push(...JSON.parse(fs.readFileSync(args["messages-file"], "utf8")))
		messages[0].text = `[STRESS] ${messages[0].text}`
		ts = messages.at(-1).ts + 1
	} else {
		for (let i = 0; messages.length < cfg.start; i++) messages.push(...round(i))
	}

	// Hydrate (with the initial history) and verify real rendering happened.
	await emit({ type: "state", state: baseState({ clineMessages: messages, clineMessagesSeq: ++seq }) })
	await sleep(3000)
	const rendered = await page.evaluate(() => document.body.innerText.includes("[STRESS]"))
	if (!rendered) {
		console.error("Render check FAILED: '[STRESS]' text not in DOM. Aborting (results would be meaningless).")
		await browser.close()
		server?.child.kill()
		process.exit(2)
	}
	console.log(`render check passed: ${await dom()} DOM nodes, ${messages.length} msgs, heap ${await heap(true)}MB after GC`)
	console.log(`scenario=${cfg.scenario} heapCap=${cfg.heapMb}MB (headless Chromium, ${buildMode} build)\n`)

	const t0 = Date.now()
	const floor = []
	try {
		if (cfg.scenario === "session") {
			for (let p = 0; p < cfg.pushes && !crashed; p++) {
				for (let k = 0; k < cfg.grow; k += 4) messages.push(...round(messages.length))
				await emit({ type: "state", state: baseState({ clineMessages: messages, clineMessagesSeq: ++seq }) })
				const streamTs = ts++
				const live = { ts: streamTs, type: "say", say: "text", text: "", partial: true }
				messages.push(live)
				await emit({ type: "state", state: baseState({ clineMessages: messages, clineMessagesSeq: ++seq }) })
				for (let c = 0; c < cfg.chunks; c++) {
					live.text += `chunk ${c}: ${"streamed text ".repeat(15)}\n`
					await emit({ type: "messageUpdated", clineMessage: { ...live } })
					await sleep(50)
				}
				live.partial = false
				if (p % 10 === 0) {
					const lat = await frame()
					const gcHeap = await heap(true)
					floor.push(gcHeap)
					console.log(`push ${String(p).padStart(4)} msgs=${messages.length} dom=${await dom()} frameLatency=${lat}ms heapAfterGC=${gcHeap}MB t=${Math.round((Date.now() - t0) / 1000)}s`)
				}
			}
		} else if (cfg.scenario === "command") {
			const execTs = ts++
			messages.push({ ts: execTs, type: "ask", ask: "command", text: "npm run dev", isAnswered: true })
			await emit({ type: "state", state: baseState({ clineMessages: messages, clineMessagesSeq: ++seq }) })
			const executionId = String(execTs)
			const post = (s) => emit({ type: "commandExecutionStatus", text: JSON.stringify({ executionId, ...s }) })
			await post({ status: "started", pid: 1, command: "npm run dev" })
			const lineText = (n) => `[${n}] ${"build output line ".repeat(10)}`.slice(0, 100)
			await post({ status: "output", output: Array.from({ length: 500 }, (_, k) => lineText(k)).join("\n") })
			await sleep(1500)
			const shown = await page.evaluate(() => document.body.innerText.includes("build output line"))
			if (!shown) {
				console.error("Render check FAILED: command output is not in the DOM (row collapsed or not rendered). Aborting.")
				await browser.close()
				server?.child.kill()
				process.exit(2)
			}
			console.log("command output render check passed (TerminalOutput is mounted and visible)")
			let counter = 0
			const end = Date.now() + cfg.seconds * 1000
			let sent = 0
			let lastLog = Date.now()
			while (Date.now() < end && !crashed) {
				const batchStart = Date.now()
				const perBatch = Math.max(1, Math.round(cfg.rate / 20))
				for (let i = 0; i < perBatch; i++) {
					const start = counter++
					await post({ status: "output", output: Array.from({ length: 500 }, (_, k) => lineText(start + k)).join("\n") })
					sent++
				}
				const wait = 50 - (Date.now() - batchStart)
				if (wait > 0) await sleep(wait)
				if (Date.now() - lastLog > 5000) {
					lastLog = Date.now()
					const lat = await frame()
					const gcHeap = await heap(true)
					floor.push(gcHeap)
					console.log(`t=${Math.round((Date.now() - t0) / 1000)}s sent=${sent} dom=${await dom()} frameLatency=${lat}ms heapAfterGC=${gcHeap}MB`)
				}
			}
		} else if (cfg.scenario === "md") {
			// Streams realistic markdown (code blocks, tables, lists, mermaid) the way Zoo Code does:
			// every chunk re-sends the FULL accumulated text of the partial message.
			const rngFor = (seed) => {
				let a = (seed * 2654435761) >>> 0
				return () => {
					a = (a + 0x6d2b79f5) >>> 0
					let t = a
					t = Math.imul(t ^ (t >>> 15), t | 1)
					t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
					return ((t ^ (t >>> 14)) >>> 0) / 4294967296
				}
			}
			const PARAS = [
				"I looked at how the current code paths interact and there are a few things worth calling out before making changes.",
				"The existing implementation works for the happy path, but the error handling around retries is inconsistent.",
				"This keeps the public surface unchanged while making the internals easier to reason about and to test in isolation.",
				"One thing to watch: the `timeoutMs` option is optional, so every consumer has to handle `undefined` explicitly.",
			]
			const BULLETS = ["Keep `REVISION` monotonically increasing", "Guard against empty input before iterating", "Prefer `for...of` with `entries()`", "Add a regression test for the boundary"]
			const CODE = [
				(n) => "```ts\nexport async function resolve" + n + "(input: string[]): Promise<string[]> {\n\tconst out: string[] = []\n\tfor (const [i, item] of input.entries()) {\n\t\tout.push(`${item.trim()}:${i}`)\n\t}\n\treturn out\n}\n```",
				(n) => "```python\ndef summary_" + n + "(items):\n    counts = {}\n    for item in items:\n        counts[item] = counts.get(item, 0) + 1\n    return counts\n```",
				(n) => "```bash\npnpm --dir src exec vitest run core/feature_" + n + "\npnpm lint && pnpm check-types\n```",
				(n) => "```json\n{\n  \"name\": \"feature_" + n + "\",\n  \"retry\": { \"limit\": 3, \"backoffMs\": [100, 250, 500] }\n}\n```",
				(n) => "```diff\n--- a/src/f" + n + ".ts\n+++ b/src/f" + n + ".ts\n@@ -3,2 +3,2 @@\n-export const REVISION = 0\n+export const REVISION = 1\n```",
			]
			const mdFor = (n) => {
				const r = rngFor(n * 31 + 5)
				const pick = (a) => a[Math.floor(r() * a.length)]
				let out = `## Step ${n}: review\n\n${pick(PARAS)}\n\n`
				if (cfg.mermaidEvery > 0 && n % cfg.mermaidEvery === 0) {
					out += "```mermaid\nflowchart TD\n    A[Request] --> B{cache hit?}\n    B -- yes --> C[Return cached]\n    B -- no --> D[Resolver]\n    D --> C\n```\n\n"
				}
				while (out.length < cfg.textBytes) {
					const kind = Math.floor(r() * 4)
					if (kind === 0) out += `**Key points**\n\n${[0, 1, 2].map(() => `- ${pick(BULLETS)}`).join("\n")}\n\n`
					else if (kind === 1) out += `${pick(PARAS)}\n\n${pick(CODE)(n)}\n\n`
					else if (kind === 2) out += "| Module | Lines | Status |\n| --- | ---: | --- |\n| `a.ts` | 150 | ok |\n| `b.ts` | 151 | updated |\n\n"
					else out += `> **Note:** ${pick(PARAS)}\n\n`
				}
				return out
			}

			const allocProfile = args["alloc-profile"] === "true"
			if (allocProfile) {
				await cdp.send("HeapProfiler.startSampling", {
					samplingInterval: 16384,
					includeObjectsCollectedByMajorGC: true,
					includeObjectsCollectedByMinorGC: true,
				})
			}
			let peak = 0
			const sampler = setInterval(async () => {
				try {
					const { metrics } = await cdp.send("Performance.getMetrics")
					peak = Math.max(peak, Math.round(metrics.find((m) => m.name === "JSHeapUsedSize").value / 1048576))
				} catch {}
			}, 250)
			for (let turn = 1; turn <= cfg.turns && !crashed; turn++) {
				messages.push({ ts: ts++, type: "say", say: "api_req_started", text: JSON.stringify({ apiProtocol: "openai", tokensIn: 1000, tokensOut: 200, cost: 0.001 }) })
				const live = { ts: ts++, type: "say", say: "text", text: "", partial: true }
				messages.push(live)
				await emit({ type: "state", state: baseState({ clineMessages: messages, clineMessagesSeq: ++seq }) })
				const full = mdFor(turn)
				let updates = 0
				for (let i = 0; i < full.length; ) {
					i += 8 + Math.floor(Math.random() * 40)
					live.text = full.slice(0, i)
					await emit({ type: "messageUpdated", clineMessage: { ...live } })
					updates++
					if (cfg.chunkMs > 0) await sleep(cfg.chunkMs * (0.5 + Math.random()))
				}
				live.text = full
				live.partial = false
				await emit({ type: "messageUpdated", clineMessage: { ...live } })
				const lat = await frame()
				const turnPeak = peak
				peak = 0
				const gcHeap = await heap(true)
				floor.push(gcHeap)
				console.log(`turn ${String(turn).padStart(3)} msgs=${messages.length} updates=${updates} dom=${await dom()} frameLatency=${lat}ms peakHeap=${turnPeak}MB heapAfterGC=${gcHeap}MB t=${Math.round((Date.now() - t0) / 1000)}s`)
			}
			clearInterval(sampler)
			if (allocProfile) {
				const { profile } = await cdp.send("HeapProfiler.stopSampling")
				const totals = new Map()
				const walk = (node) => {
					const f = node.callFrame
					const key = `${f.functionName || "(anonymous)"} @ ${f.url.split("/").pop()}:${f.lineNumber + 1}`
					totals.set(key, (totals.get(key) ?? 0) + node.selfSize)
					node.children.forEach(walk)
				}
				walk(profile.head)
				const sum = [...totals.values()].reduce((a, b) => a + b, 0)
				console.log(`\nAllocation sampling (self size incl. collected objects), total ${Math.round(sum / 1048576)}MB:`)
				for (const [k, v] of [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
					console.log(`  ${String(Math.round(v / 1048576)).padStart(6)}MB  ${((v / sum) * 100).toFixed(1).padStart(5)}%  ${k}`)
				}
			}
		} else {
			throw new Error(`unknown scenario ${cfg.scenario}`)
		}
	} catch (e) {
		if (!crashed) console.error("scenario error:", e.message.split("\n")[0])
	}

	console.log("")
	if (crashed) {
		console.log("RESULT: renderer crashed (OOM reproduced).")
	} else if (floor.length >= 4) {
		const q = Math.max(1, Math.floor(floor.length / 4))
		const first = Math.round(floor.slice(0, q).reduce((a, b) => a + b, 0) / q)
		const last = Math.round(floor.slice(-q).reduce((a, b) => a + b, 0) / q)
		console.log(`RESULT: heap-after-GC first quarter avg ${first}MB -> last quarter avg ${last}MB (${last > first * 1.3 ? "GROWING: likely retained memory" : "flat: no leak on this path"})`)
	}
	await browser.close().catch(() => {})
	server?.child.kill()
	process.exit(crashed ? 1 : 0)
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
