#!/usr/bin/env node
// LLM-free OpenAI-compatible server for reproducing Zoo Code sessions in real VS Code (gray screen / OOM work).
// Every request gets a scripted reply: optional streamed reasoning, a markdown explanation (headings, lists, tables,
// fenced code, optional mermaid) and ONE native tool call. After --max-requests turns it ends with attempt_completion.
//
// Usage (run on the machine hosting the extension host; sv01 for Remote-SSH):
//   node scripts/gray-screen/mock-openai-server.mjs [--scenario rapid] [--port 8989] [--max-requests 500] [options]
//
// Scenarios (--scenario):
//   rapid   Turns as fast as possible: ~300B text, no reasoning, no delays, tiny update_todo_list call.
//           Each new message makes the host push the full state to the webview. Use with a pre-generated big task
//           (generate-large-task.mjs ... --batchable true) and Resume. This is the gray-screen reproduction.
//   md      ~15KB markdown (+ reasoning) per turn with a tiny update_todo_list call (isolates markdown/streaming cost).
//   flood   Like md but ~60KB in 4-16 char chunks every ~1ms (maximum partial-message updates).
//   coding  Realistic coding loop in a sandbox dir: update_todo_list, write_to_file, read_file, apply_diff,
//           search_files, test-runner execute_command, list_files (real files/commands run; see --dir).
//   chatty  Only execute_command with ANSI-colored streaming output (no text).
//   churn   Phase 1 (--accumulate-turns) piles up large write_to_file/read_file/apply_diff messages, phase 2 is md.
//           --fast true: 100 turns of ~55KB write_to_file, 4ms chunks.
//
// Options (defaults vary per scenario):
//   --text-bytes N        markdown size per turn (3000; md/churn 15000; flood 60000; rapid 300)
//   --reasoning-bytes N   streamed reasoning_content per turn (600; flood 3000; rapid 0)
//   --chunk-ms N          delay between streamed chunks (15; flood 1; rapid 0; --fast 4)
//   --chunk-min/--chunk-max N  characters per streamed chunk (8/47; flood 4/16)
//   --tool-chunk N        characters per tool-call argument chunk (120)
//   --code-lines N        lines per generated source file (150; churn 500; --fast 1500)
//   --cmd-lines N         lines printed by the simulated test/build runner (400)
//   --cmd-sleep S         seconds between runner lines (0.005)
//   --mermaid-every N     mermaid diagram every N turns (10; rapid 0; 0 disables)
//   --dir PATH            sandbox folder relative to the workspace (.mock-session); delete it afterwards
//
// Zoo Code settings: provider "OpenAI Compatible", base URL http://127.0.0.1:<port>/v1, any API key, model id "mock",
// context window 1000000 (avoid condensing); auto-approve read/write/execute with allowed command "*".
import http from "node:http"

const args = Object.fromEntries(
	process.argv.slice(2).reduce((acc, cur, i, all) => {
		if (cur.startsWith("--")) acc.push([cur.slice(2), all[i + 1]])
		return acc
	}, []),
)
const fast = args["fast"] === "true"
const cfg = {
	fast,
	port: Number(args["port"] ?? 8989),
	maxRequests: Number(args["max-requests"] ?? 500),
	scenario: args["scenario"] ?? "coding",
	textBytes: Number(args["text-bytes"] ?? (args["scenario"] === "rapid" ? 300 : args["scenario"] === "flood" ? 60000 : args["scenario"] === "md" || args["scenario"] === "churn" ? 15000 : 3000)),
	reasoningBytes: Number(args["reasoning-bytes"] ?? (args["scenario"] === "rapid" ? 0 : args["scenario"] === "flood" ? 3000 : 600)),
	chunkMs: Number(args["chunk-ms"] ?? (args["scenario"] === "rapid" ? 0 : args["scenario"] === "flood" ? 1 : fast ? 4 : 15)),
	chunkMin: Number(args["chunk-min"] ?? (args["scenario"] === "flood" ? 4 : 8)),
	chunkMax: Number(args["chunk-max"] ?? (args["scenario"] === "flood" ? 16 : 47)),
	toolChunk: Number(args["tool-chunk"] ?? 120),
	codeLines: Number(args["code-lines"] ?? (fast ? 1500 : args["scenario"] === "churn" ? 500 : 150)),
	accumulateTurns: Number(args["accumulate-turns"] ?? (fast ? 100 : 300)),
	cmdLines: Number(args["cmd-lines"] ?? 400),
	cmdSleep: Number(args["cmd-sleep"] ?? 0.005),
	mermaidEvery: Number(args["mermaid-every"] ?? (args["scenario"] === "rapid" ? 0 : 10)),
	dir: (args["dir"] ?? ".mock-session").replace(/\/+$/, ""),
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let requestCount = 0

// ---------------------------------------------------------------------------------------------
// Deterministic pseudo-random helpers (same turn number -> same content)
// ---------------------------------------------------------------------------------------------
const rng = (seed) => {
	let s = (seed * 2654435761) >>> 0
	return () => {
		s = (s + 0x6d2b79f5) >>> 0
		let t = s
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)]

const NOUNS = ["cache", "scheduler", "parser", "router", "session", "queue", "tokenizer", "pipeline", "registry", "validator", "watcher", "emitter"]
const VERBS = ["normalize", "resolve", "dispatch", "compress", "merge", "retry", "flush", "hydrate", "serialize", "throttle"]
const feature = (k) => `${NOUNS[k % NOUNS.length]}_${Math.floor(k / NOUNS.length)}`
const camel = (s) => s.replace(/_(\w)/g, (_, c) => c.toUpperCase())
const pascal = (s) => camel(s).replace(/^\w/, (c) => c.toUpperCase())

// ---------------------------------------------------------------------------------------------
// Generated source files (the server knows exact contents so apply_diff blocks match)
// ---------------------------------------------------------------------------------------------
const files = new Map() // path -> { k, rev, retry }

function fileContent(k, rev, retry) {
	const name = feature(k)
	const r = rng(k + 7)
	const lines = [
		`// Auto-generated module: ${name}`,
		``,
		`export const REVISION = ${rev}`,
		`export const RETRY_LIMIT = ${retry}`,
		``,
		`export interface ${pascal(name)}Options {`,
		`\tname: string`,
		`\tmaxItems?: number`,
		`\ttimeoutMs?: number`,
		`}`,
		``,
	]
	let fn = 0
	while (lines.length < cfg.codeLines) {
		const v = pick(r, VERBS)
		lines.push(
			`/** ${v} the ${name} payload, attempt ${fn} */`,
			`export async function ${v}${pascal(name)}${fn}(input: string[], opts: ${pascal(name)}Options): Promise<string[]> {`,
			`\tconst out: string[] = []`,
			`\tfor (const [index, item] of input.entries()) {`,
			`\t\tif (opts.maxItems !== undefined && index >= opts.maxItems) break`,
			`\t\tconst trimmed = item.trim().toLowerCase()`,
			`\t\tif (trimmed.length === 0) continue`,
			`\t\tout.push(\`\${opts.name}:\${trimmed}:\${index * ${fn + 2}}\`)`,
			`\t}`,
			`\treturn out`,
			`}`,
			``,
		)
		fn++
	}
	return lines.join("\n") + "\n"
}

const srcPath = (k) => `${cfg.dir}/src/${feature(k)}.ts`

// ---------------------------------------------------------------------------------------------
// Markdown explanation generator
// ---------------------------------------------------------------------------------------------
const PARAS = [
	"I looked at how the current code paths interact and there are a few things worth calling out before making changes.",
	"The existing implementation works for the happy path, but the error handling around retries is inconsistent, so I want to tighten that up first.",
	"Before touching anything else, I'll keep the change small and verify it with the test runner so we can see regressions early.",
	"This keeps the public surface unchanged while making the internals easier to reason about and to test in isolation.",
	"One thing to watch: the `timeoutMs` option is optional, so every consumer has to handle `undefined` explicitly.",
	"The trade-off here is a little more code in exchange for much clearer failure modes when the upstream service is slow.",
]
const BULLETS = [
	"Keep `REVISION` monotonically increasing so consumers can detect stale caches",
	"Guard against empty input before iterating (`trimmed.length === 0`)",
	"Prefer `for...of` with `entries()` over index loops for readability",
	"Add a regression test for the `maxItems` boundary",
	"Document the retry policy in the module header",
	"Avoid mutating the input array; return a fresh `out` instead",
]

function codeBlock(r, k) {
	const name = feature(k)
	const kind = pick(r, ["ts", "py", "bash", "json", "diff", "sql", "yaml"])
	switch (kind) {
		case "py":
			return `\`\`\`python\ndef ${name}_summary(items: list[str], limit: int = 10) -> dict[str, int]:\n    counts: dict[str, int] = {}\n    for item in items[:limit]:\n        key = item.strip().lower()\n        counts[key] = counts.get(key, 0) + 1\n    return counts\n\`\`\``
		case "bash":
			return `\`\`\`bash\n# run the focused suite\npnpm --dir src exec vitest run core/${name} --reporter=verbose\npnpm lint && pnpm check-types\n\`\`\``
		case "json":
			return `\`\`\`json\n{\n  "name": "${name}",\n  "retry": { "limit": ${3 + (k % 4)}, "backoffMs": [100, 250, 500] },\n  "features": ["cache", "metrics", "tracing"]\n}\n\`\`\``
		case "diff":
			return `\`\`\`diff\n--- a/${srcPath(k)}\n+++ b/${srcPath(k)}\n@@ -3,2 +3,2 @@\n-export const REVISION = 0\n-export const RETRY_LIMIT = 3\n+export const REVISION = 1\n+export const RETRY_LIMIT = 5\n\`\`\``
		case "sql":
			return `\`\`\`sql\nSELECT id, status, COUNT(*) AS attempts\nFROM ${name}_jobs\nWHERE created_at > NOW() - INTERVAL '1 day'\nGROUP BY id, status\nORDER BY attempts DESC\nLIMIT 50;\n\`\`\``
		case "yaml":
			return `\`\`\`yaml\nservice: ${name}\nreplicas: ${2 + (k % 3)}\nenv:\n  - name: LOG_LEVEL\n    value: info\n  - name: RETRY_LIMIT\n    value: "${3 + (k % 4)}"\n\`\`\``
		default:
			return `\`\`\`ts\nexport function ${camel(name)}Key(id: string, revision = REVISION): string {\n\treturn \`${name}:\${id}:v\${revision}\`\n}\n\nconst result = await ${pick(r, VERBS)}${pascal(name)}0(["a", " B ", ""], { name: "${name}", maxItems: 2 })\nconsole.log(result) // ["${name}:a:0", "${name}:b:2"]\n\`\`\``
	}
}

function mermaidBlock(k) {
	const a = feature(k)
	const b = feature(k + 1)
	return `\`\`\`mermaid\nflowchart TD\n    A[Request] --> B{${a} cache hit?}\n    B -- yes --> C[Return cached]\n    B -- no --> D[${b} resolver]\n    D --> E[(Store)]\n    E --> C\n\`\`\``
}

function table(r, k) {
	const rows = [["Module", "Lines", "Status"]]
	for (let i = 0; i < 3 + Math.floor(r() * 3); i++) rows.push([`\`${feature(k - i < 0 ? 0 : k - i)}.ts\``, String(cfg.codeLines + i), pick(r, ["ok", "updated", "new"])])
	return [`| ${rows[0].join(" | ")} |`, `| --- | ---: | --- |`, ...rows.slice(1).map((row) => `| ${row.join(" | ")} |`)].join("\n")
}

function markdownFor(n, k, action) {
	const r = rng(n * 31 + 5)
	const parts = [`## Step ${n}: ${action.title}`, "", pick(r, PARAS), ""]
	let size = parts.join("\n").length
	const sections = [
		() => ["**Key points**", "", ...Array.from({ length: 3 + Math.floor(r() * 3) }, () => `- ${pick(r, BULLETS)}`), ""].join("\n"),
		() => [pick(r, PARAS), "", codeBlock(r, k), ""].join("\n"),
		() => [table(r, k), ""].join("\n"),
		() => [`Here is the relevant snippet from \`${srcPath(k)}\`:`, "", codeBlock(r, k), "", pick(r, PARAS), ""].join("\n"),
		() => [`> **Note:** ${pick(r, PARAS)}`, ""].join("\n"),
		() => [`1. Inspect \`${srcPath(k)}\``, `2. ${pick(r, BULLETS)}`, `3. Re-run the suite and compare output`, ""].join("\n"),
	]
	if (cfg.mermaidEvery > 0 && n % cfg.mermaidEvery === 0) {
		parts.push("The data flow looks like this:", "", mermaidBlock(k), "")
		size += 200
	}
	const targetBytes = action.textBytes ?? cfg.textBytes
	while (size < targetBytes) {
		const s = pick(r, sections)()
		parts.push(s)
		size += s.length
	}
	parts.push(action.closing)
	return parts.join("\n")
}

function reasoningFor(n, skip) {
	if (skip || cfg.reasoningBytes <= 0) return ""
	const r = rng(n * 13 + 1)
	let out = ""
	while (out.length < cfg.reasoningBytes) out += `${pick(r, PARAS)} ${pick(r, BULLETS)}. `
	return out.slice(0, cfg.reasoningBytes)
}

// ---------------------------------------------------------------------------------------------
// Simulated commands (ANSI colors, streaming output, stack traces)
// ---------------------------------------------------------------------------------------------
const sleepPart = () => (cfg.cmdSleep > 0 ? `sleep ${cfg.cmdSleep}; ` : "")

const testRunCommand = (k) =>
	`echo "RUN  v2.1.0 ${cfg.dir}"; for i in $(seq 1 ${cfg.cmdLines}); do printf "\\033[32m ✓\\033[0m src/${feature(k)} case %d \\033[90m(%d ms)\\033[0m\\n" $i $((i % 37 + 3)); ${sleepPart()}done; printf "\\n\\033[32m Test Files  1 passed (1)\\033[0m\\n\\033[32m      Tests  ${cfg.cmdLines} passed (${cfg.cmdLines})\\033[0m\\n"`

const buildErrorCommand = (k) =>
	`for i in $(seq 1 ${Math.max(20, Math.floor(cfg.cmdLines / 4))}); do printf "\\033[31merror\\033[0m TS2322: Type 'string' is not assignable to type 'number'.\\n  \\033[36m${cfg.dir}/src/${feature(k)}.ts\\033[0m:%d:%d\\n    %d |   const value: number = input[%d]\\n\\n" $i $((i % 80 + 1)) $i $i; ${sleepPart()}done; echo "Found ${Math.max(20, Math.floor(cfg.cmdLines / 4))} errors."`

const listCommand = () => `find ${cfg.dir} -type f -name "*.ts" | sort | head -100 && wc -l ${cfg.dir}/src/*.ts | tail -5`

// ---------------------------------------------------------------------------------------------
// Turn planner: repeating coding cycle over successive "features"
// ---------------------------------------------------------------------------------------------
const CYCLE = ["todo", "write", "read", "apply_diff", "search", "test", "apply_diff", "test", "list", "build_check"]

function planFor(n) {
	if (n > cfg.maxRequests) {
		return {
			title: "Wrap up",
			closing: "All planned changes are in place.",
			tool: { name: "attempt_completion", args: { result: `## Summary\n\nFinished ${cfg.maxRequests} scripted turns in \`${cfg.dir}/\`.\n\n- Created and revised generated modules\n- Ran the simulated test suite repeatedly\n\nRun \`rm -rf ${cfg.dir}\` to clean up.` } },
		}
	}
	if (cfg.scenario === "churn") {
		if (n <= cfg.accumulateTurns) {
			// Phase 1: pile up large tool messages (new files, diffs, reads) with minimal text, quickly.
			const k = cfg.fast ? n - 1 : Math.floor((n - 1) / 3)
			const path = srcPath(k)
			const step = cfg.fast ? 0 : (n - 1) % 3
			const fast = { fast: true, textBytes: 200 }
			if (step === 0) {
				files.set(path, { k, rev: 0, retry: 3 })
				return { ...fast, title: `Create \`${feature(k)}.ts\``, closing: `Creating \`${path}\`.`, tool: { name: "write_to_file", args: { path, content: fileContent(k, 0, 3) } } }
			}
			if (step === 1) return { ...fast, title: "Review the new file", closing: `Reading \`${path}\`.`, tool: { name: "read_file", args: { path } } }
			const f = files.get(path) ?? { k, rev: 0, retry: 3 }
			const next = { k, rev: f.rev + 1, retry: f.retry + 1 }
			const diff = `<<<<<<< SEARCH\n:start_line:3\n-------\nexport const REVISION = ${f.rev}\nexport const RETRY_LIMIT = ${f.retry}\n=======\nexport const REVISION = ${next.rev}\nexport const RETRY_LIMIT = ${next.retry}\n>>>>>>> REPLACE`
			files.set(path, next)
			return { ...fast, title: "Apply a targeted fix", closing: `Applying the change to \`${path}\`.`, tool: { name: "apply_diff", args: { path, diff } } }
		}
		// Phase 2: long streamed markdown with a tiny tool call; every chunk re-derives state from all the tool messages above.
		if (n === cfg.accumulateTurns + 1) {
			console.log("[mock] ===== phase 2: streaming long markdown; watch the webview heap peak now =====")
		}
		return { title: "Notes", closing: "Updating the checklist.", tool: { name: "update_todo_list", args: { todos: `[-] Review notes for turn ${n}\n[ ] Summarize findings` } } }
	}
	if (cfg.scenario === "md" || cfg.scenario === "flood" || cfg.scenario === "rapid") {
		const todos = `[-] Review notes for turn ${n}\n[ ] Summarize findings`
		return { title: "Notes", closing: "Updating the checklist.", tool: { name: "update_todo_list", args: { todos } } }
	}
	if (cfg.scenario === "chatty") {
		const k = n
		return { title: "Run the suite", closing: "Running it again.", tool: { name: "execute_command", args: { command: testRunCommand(k), cwd: null, timeout: null } } }
	}

	const cycleIndex = (n - 1) % CYCLE.length
	const k = Math.floor((n - 1) / CYCLE.length)
	const kind = CYCLE[cycleIndex]
	const path = srcPath(k)

	switch (kind) {
		case "todo": {
			const done = Math.min(k, 6)
			const todos = Array.from({ length: 8 }, (_, i) => `${i < done ? "[x]" : i === done ? "[-]" : "[ ]"} Implement and verify ${feature(i)}`).join("\n")
			return { title: "Update the plan", closing: "Updating the checklist now.", tool: { name: "update_todo_list", args: { todos } } }
		}
		case "write": {
			const retry = 3
			files.set(path, { k, rev: 0, retry })
			return { title: `Create \`${feature(k)}.ts\``, closing: `Creating \`${path}\`.`, tool: { name: "write_to_file", args: { path, content: fileContent(k, 0, retry) } } }
		}
		case "read":
			return { title: "Review the new file", closing: `Reading \`${path}\` back to double-check it.`, tool: { name: "read_file", args: { path } } }
		case "apply_diff": {
			const f = files.get(path) ?? { k, rev: 0, retry: 3 }
			const next = { k, rev: f.rev + 1, retry: f.retry + 1 }
			const diff = `<<<<<<< SEARCH\n:start_line:3\n-------\nexport const REVISION = ${f.rev}\nexport const RETRY_LIMIT = ${f.retry}\n=======\nexport const REVISION = ${next.rev}\nexport const RETRY_LIMIT = ${next.retry}\n>>>>>>> REPLACE`
			files.set(path, next)
			return { title: "Apply a targeted fix", closing: `Applying the change to \`${path}\`.`, tool: { name: "apply_diff", args: { path, diff } } }
		}
		case "search":
			return { title: "Find related usages", closing: "Searching the sandbox for other consumers.", tool: { name: "search_files", args: { path: `${cfg.dir}/src`, regex: "RETRY_LIMIT|REVISION", file_pattern: "*.ts" } } }
		case "test":
			return { title: "Run the tests", closing: "Running the suite.", tool: { name: "execute_command", args: { command: testRunCommand(k), cwd: null, timeout: null } } }
		case "list":
			return { title: "Check the workspace layout", closing: "Listing what we have so far.", tool: { name: "list_files", args: { path: cfg.dir, recursive: true } } }
		default:
			return { title: "Type-check and summarize", closing: "Collecting the diagnostics.", tool: { name: "execute_command", args: { command: k % 2 === 0 ? buildErrorCommand(k) : listCommand(), cwd: null, timeout: null } } }
	}
}

// ---------------------------------------------------------------------------------------------
// OpenAI-compatible streaming
// ---------------------------------------------------------------------------------------------
function sseChunk(res, id, delta, finishReason = null) {
	res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "mock", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`)
}

async function streamText(res, id, text, field, chunkMs = cfg.chunkMs) {
	const r = rng(text.length)
	for (let i = 0; i < text.length; ) {
		const size = cfg.chunkMin + Math.floor(r() * (cfg.chunkMax - cfg.chunkMin + 1))
		sseChunk(res, id, { [field]: text.slice(i, i + size) })
		i += size
		if (chunkMs > 0) await sleep(chunkMs * (0.5 + r()))
	}
}

async function handleCompletion(req, res, body) {
	const messages = Array.isArray(body.messages) ? body.messages : []
	const hasTools = Array.isArray(body.tools) && body.tools.length > 0
	const id = `chatcmpl-mock-${Date.now()}`

	// Requests without tools (condense, prompt enhance, title generation): plain answer, not part of the script.
	if (!hasTools) {
		console.log(`[mock] auxiliary request messages=${messages.length} stream=${body.stream === true}`)
		const text = "## Summary\n\nThe conversation so far covered creating, reviewing and revising generated modules.\n"
		if (body.stream !== true) {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify({ id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: "mock", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } }))
			return
		}
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
		sseChunk(res, id, { role: "assistant", content: text })
		sseChunk(res, id, {}, "stop")
		res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: "mock", choices: [], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } })}\n\n`)
		res.write("data: [DONE]\n\n")
		res.end()
		return
	}

	const n = ++requestCount
	const plan = planFor(n)
	console.log(`[mock] turn #${n} tool=${plan.tool.name} messages=${messages.length} bodyBytes=${JSON.stringify(body).length}`)

	if (body.stream !== true) {
		res.writeHead(200, { "content-type": "application/json" })
		res.end(JSON.stringify({ id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: "mock", choices: [{ index: 0, message: { role: "assistant", content: markdownFor(n, Math.floor((n - 1) / CYCLE.length), plan), tool_calls: [{ id: `call_${n}`, type: "function", function: { name: plan.tool.name, arguments: JSON.stringify(plan.tool.args) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } }))
		return
	}

	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
	sseChunk(res, id, { role: "assistant", content: "" })
	const reasoning = reasoningFor(n, plan.fast)
	if (reasoning) await streamText(res, id, reasoning, "reasoning_content")
	if (cfg.scenario !== "chatty") await streamText(res, id, markdownFor(n, Math.floor((n - 1) / CYCLE.length), plan), "content", plan.fast ? 1 : cfg.chunkMs)

	const argsJson = JSON.stringify(plan.tool.args)
	sseChunk(res, id, { tool_calls: [{ index: 0, id: `call_${n}`, type: "function", function: { name: plan.tool.name, arguments: "" } }] })
	for (let i = 0; i < argsJson.length; i += cfg.toolChunk) {
		sseChunk(res, id, { tool_calls: [{ index: 0, function: { arguments: argsJson.slice(i, i + cfg.toolChunk) } }] })
		if (cfg.chunkMs > 0) await sleep(Math.max(1, cfg.chunkMs / 3))
	}
	sseChunk(res, id, {}, "tool_calls")
	const promptTokens = 1000 + messages.length * 400
	res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "mock", choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 400, total_tokens: promptTokens + 400 } })}\n\n`)
	res.write("data: [DONE]\n\n")
	res.end()
}

const server = http.createServer((req, res) => {
	const url = new URL(req.url, "http://x")
	if (req.method === "GET" && url.pathname.endsWith("/models")) {
		res.writeHead(200, { "content-type": "application/json" })
		res.end(JSON.stringify({ object: "list", data: [{ id: "mock", object: "model", created: 0, owned_by: "mock" }] }))
		return
	}
	if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
		const chunks = []
		req.on("data", (c) => chunks.push(c))
		req.on("end", () => {
			let body = {}
			try {
				body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
			} catch {}
			handleCompletion(req, res, body).catch((e) => {
				console.error("[mock] handler error:", e)
				res.end()
			})
		})
		return
	}
	res.writeHead(404).end()
})

server.listen(cfg.port, "0.0.0.0", () => {
	console.log(`[mock] OpenAI-compatible server listening on 0.0.0.0:${cfg.port} -> use http://127.0.0.1:${cfg.port}/v1 (scenario=${cfg.scenario}, maxRequests=${cfg.maxRequests}, sandbox=${cfg.dir}/)`)
})
