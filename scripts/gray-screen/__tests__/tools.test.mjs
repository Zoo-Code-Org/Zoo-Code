// Subprocess tests for the executable gray-screen tools. Run: node --test scripts/gray-screen/__tests__/tools.test.mjs
// The browser harnesses (webview-heap-matrix, webview-render-stress) need a built webview and Chromium, so only
// their pure parts (static serving, build directory) are covered, in lib.test.mjs.
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"
import { fileURLToPath } from "node:url"

const dir = path.dirname(fileURLToPath(import.meta.url))
const script = (name) => path.join(dir, "..", name)
const node = (name, args) => spawnSync(process.execPath, [script(name), ...args], { encoding: "utf8" })

let tmp

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gray-screen-tools-"))
})

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true })
})

const generate = (...args) => node("generate-large-task.mjs", ["--storage", tmp, ...args])

function readTask() {
	const [id] = fs.readdirSync(path.join(tmp, "tasks"))
	const read = (name) => JSON.parse(fs.readFileSync(path.join(tmp, "tasks", id, name), "utf8"))
	return { id, messages: read("ui_messages.json"), api: read("api_conversation_history.json"), item: read("history_item.json") }
}

describe("generate-large-task", () => {
	it("writes a complete task with the requested number of messages", () => {
		const result = generate("--messages", "40", "--text-bytes", "100")

		assert.equal(result.status, 0, result.stderr)
		const { id, messages, item } = readTask()
		assert.ok(messages.length >= 40)
		assert.equal(item.id, id)
		assert.match(item.task, /\[LOAD TEST\]/)
		assert.deepEqual(fs.readdirSync(tmp).sort(), ["tasks"])
	})

	it("adds images when asked to", () => {
		assert.equal(generate("--messages", "30", "--text-bytes", "100", "--image-every", "5", "--image-kb", "1").status, 0)

		assert.ok(readTask().messages.some((m) => m.images?.length))
	})

	it("produces non-Latin-1 text with --two-byte true only", () => {
		assert.equal(generate("--messages", "30", "--text-bytes", "100", "--two-byte", "true").status, 0)
		assert.match(JSON.stringify(readTask().messages), /한글/)

		fs.rmSync(path.join(tmp, "tasks"), { recursive: true })
		assert.equal(generate("--messages", "30", "--text-bytes", "100").status, 0)
		assert.doesNotMatch(JSON.stringify(readTask().messages), /한글/)
	})

	it("creates nothing when a flag has no value or is not a positive integer", () => {
		for (const args of [["--messages", "--text-bytes", "5"], ["--messages", "abc"], ["--messages", "0"], ["--image-kb", "-1"]]) {
			const result = generate(...args)

			assert.notEqual(result.status, 0, args.join(" "))
			assert.deepEqual(fs.readdirSync(tmp), [], args.join(" "))
		}
	})
})

describe("analyze-session", () => {
	const analyze = (...args) => node("analyze-session.mjs", ["--storage", tmp, ...args])

	it("excludes generated [LOAD TEST] tasks unless asked, and reports sizes for the rest", () => {
		assert.equal(generate("--messages", "40", "--text-bytes", "100").status, 0)

		const excluded = analyze()
		assert.equal(excluded.status, 0, excluded.stderr)
		assert.match(excluded.stdout, /excluded 1 generated/)
		assert.match(excluded.stdout, /analyzed set: 0/)

		const included = analyze("--include-generated", "true")
		assert.equal(included.status, 0, included.stderr)
		assert.match(included.stdout, /analyzed set: 1/)
		assert.match(included.stdout, /size\(MB\)\s+msgs\s+toolTxt/)
	})

	it("does not print message content", () => {
		const taskDir = path.join(tmp, "tasks", "real-task")
		fs.mkdirSync(taskDir, { recursive: true })
		fs.writeFileSync(
			path.join(taskDir, "ui_messages.json"),
			JSON.stringify([{ ts: 1, type: "say", say: "text", text: "TOP-SECRET-CONTENT" }]),
		)

		const result = analyze()

		assert.equal(result.status, 0, result.stderr)
		assert.doesNotMatch(result.stdout, /TOP-SECRET-CONTENT/)
	})

	it("survives a malformed ui_messages.json", () => {
		const taskDir = path.join(tmp, "tasks", "broken")
		fs.mkdirSync(taskDir, { recursive: true })
		fs.writeFileSync(path.join(taskDir, "ui_messages.json"), "{not json")

		assert.equal(analyze().status, 0)
	})

	it("rejects a non-numeric --top", () => {
		for (const top of ["abc", "0", "1.5"]) {
			const result = analyze("--top", top)

			assert.notEqual(result.status, 0, `--top ${top}`)
			assert.match(result.stderr, /--top must be an integer >= 1/)
		}
	})

	it("does not let a malformed task use up a --top slot", () => {
		const write = (id, content) => {
			const taskDir = path.join(tmp, "tasks", id)
			fs.mkdirSync(taskDir, { recursive: true })
			fs.writeFileSync(path.join(taskDir, "ui_messages.json"), content)
		}
		write("broken", "{not json" + " ".repeat(10_000))
		write("readable", JSON.stringify([{ ts: 1, type: "say", say: "text", text: "hi" }]))

		const result = analyze("--top", "1")

		assert.equal(result.status, 0, result.stderr)
		assert.match(result.stdout, /skipped 1 task/)
		assert.match(result.stdout, /Top 1 tasks/)
	})
})

describe("mock-openai-server", () => {
	it("rejects an unsafe --dir before listening", () => {
		for (const bad of ['x"; touch /tmp/pwned; #', ".", "../x", "-rf"]) {
			const result = node("mock-openai-server.mjs", ["--dir", bad, "--port", "0"])

			assert.equal(result.status, 1, bad)
			assert.match(result.stderr, /Invalid --dir/)
		}
	})

	describe("HTTP", () => {
		let child
		let base

		beforeEach(async () => {
			const port = await new Promise((resolve) => {
				const probe = net.createServer().listen(0, "127.0.0.1", () => {
					const { port } = probe.address()
					probe.close(() => resolve(port))
				})
			})
			base = `http://127.0.0.1:${port}`
			child = spawn(
				process.execPath,
				[script("mock-openai-server.mjs"), "--scenario", "rapid", "--port", String(port), "--max-requests", "1"],
				{ stdio: ["ignore", "pipe", "inherit"] },
			)
			await new Promise((resolve, reject) => {
				const timer = setTimeout(() => done(reject, new Error("mock server did not start in time")), 10_000)
				const done = (settle, value) => {
					clearTimeout(timer)
					child.off("error", onError)
					child.off("exit", onExit)
					child.stdout.off("data", onData)
					settle(value)
				}
				const onError = (e) => done(reject, e)
				const onExit = (code, signal) =>
					done(reject, new Error(`mock server exited before listening (code ${code}, signal ${signal})`))
				const onData = (chunk) => String(chunk).includes("listening") && done(resolve)
				child.once("error", onError)
				child.once("exit", onExit)
				child.stdout.on("data", onData)
			})
		})

		afterEach(() => child.kill())

		const complete = (body) =>
			fetch(`${base}/v1/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			})

		it("lists the mock model and 404s elsewhere", async () => {
			const models = await (await fetch(`${base}/v1/models`)).json()
			assert.deepEqual(
				models.data.map((m) => m.id),
				["mock"],
			)
			assert.equal((await fetch(`${base}/nope`)).status, 404)
		})

		it("answers a request without tools with plain JSON", async () => {
			const body = await (await complete({ messages: [{ role: "user", content: "hi" }] })).json()

			assert.equal(body.object, "chat.completion")
			assert.match(body.choices[0].message.content, /Summary/)
		})

		it("streams a scripted tool call, then attempt_completion once --max-requests is exceeded", async () => {
			const request = { stream: true, messages: [{ role: "user", content: "go" }], tools: [{ type: "function", function: { name: "x" } }] }

			const first = await (await complete(request)).text()
			assert.match(first, /"tool_calls"/)
			assert.ok(first.trimEnd().endsWith("data: [DONE]"))
			assert.doesNotMatch(first, /attempt_completion/)

			const second = await (await complete(request)).text()
			assert.match(second, /attempt_completion/)
			assert.ok(second.trimEnd().endsWith("data: [DONE]"))
		})
	})
})
