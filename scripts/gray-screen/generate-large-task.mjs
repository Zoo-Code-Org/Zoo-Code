#!/usr/bin/env node
// Generates a synthetic task with thousands of messages to reproduce webview
// memory pressure (gray screen / OOM). Usage:
//   node scripts/gray-screen/generate-large-task.mjs [--messages 5000] [--text-bytes 800] [--tool-bytes <text-bytes>]
//     [--tool-kind mixed|newFileCreated|appliedDiff|readFile|listFilesRecursive] [--batchable true] [--two-byte true]
//     [--image-every 0] [--image-kb 200] [--storage <globalStoragePath>] [--workspace <path>]
// Then reload VS Code and open the task named "[LOAD TEST] ..." from history.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"

const args = Object.fromEntries(
	process.argv.slice(2).reduce((acc, cur, i, all) => {
		if (cur.startsWith("--")) acc.push([cur.slice(2), all[i + 1]])
		return acc
	}, []),
)

const messageCount = Number(args["messages"] ?? 5000)
const textBytes = Number(args["text-bytes"] ?? 800)
const toolBytes = Number(args["tool-bytes"] ?? textBytes)
const toolKind = args["tool-kind"] ?? "mixed"
const batchable = args["batchable"] === "true"
const twoByte = args["two-byte"] === "true" // Korean chars in tool text -> UTF-16 strings (2 bytes/char) in V8
const imageEvery = Number(args["image-every"] ?? 0)
const imageKb = Number(args["image-kb"] ?? 200)
const workspace = args["workspace"] ?? process.cwd()
const storageCandidates = [
	path.join(os.homedir(), ".vscode-server", "data", "User", "globalStorage", "codemate.zoo-code"),
	path.join(os.homedir(), ".config", "Code", "User", "globalStorage", "codemate.zoo-code"),
]
const storage = args["storage"] ?? storageCandidates.find((p) => fs.existsSync(p)) ?? storageCandidates[1]

const taskId = crypto.randomUUID()
const taskDir = path.join(storage, "tasks", taskId)
fs.mkdirSync(taskDir, { recursive: true })

const filler = (n, seed) => {
	const base = `line ${seed}: ${twoByte ? "\uD55C\uAE00 " : ""}The quick brown fox jumps over the lazy dog. `
	return base.repeat(Math.ceil(n / base.length)).slice(0, n)
}
const fakeImage = (kb) => `data:image/png;base64,${crypto.randomBytes(kb * 768).toString("base64")}`

// Large tool payloads (new files, diffs) are what the webview re-parses on every streamed chunk.
const KINDS = ["newFileCreated", "appliedDiff", "readFile", "listFilesRecursive"]
const toolPayload = (round) => {
	const kind = toolKind === "mixed" ? KINDS[round % KINDS.length] : toolKind
	const file = `src/gen/file-${round}.ts`
	switch (kind) {
		case "newFileCreated":
			return { tool: "newFileCreated", path: file, content: filler(toolBytes, round) }
		case "appliedDiff":
			return { tool: "appliedDiff", path: file, diff: filler(toolBytes, round), diffStats: { added: 12, removed: 4 } }
		case "listFilesRecursive":
			return { tool: "listFilesRecursive", path: "src", content: filler(Math.min(toolBytes, 2000), round) }
		default:
			return { tool: "readFile", path: file, content: filler(Math.min(toolBytes, 400), round) }
	}
}

const taskText = `[LOAD TEST] ${messageCount} messages`
const start = Date.now() - messageCount * 1000
const messages = [{ ts: start, type: "say", say: "text", text: taskText }]
const apiHistory = [{ role: "user", content: [{ type: "text", text: `<task>\n${taskText}\n</task>` }], ts: start }]

let ts = start + 1
let round = 0
while (messages.length < messageCount) {
	round++
	const images = imageEvery > 0 && round % imageEvery === 0 ? [fakeImage(imageKb)] : undefined
	messages.push({
		ts: ts++,
		type: "say",
		say: "api_req_started",
		text: JSON.stringify({ apiProtocol: "openai", tokensIn: 1000, tokensOut: 200, cost: 0.001 }),
	})
	// batchable: tool-only turns (no visible text/feedback between edits), which ChatView merges into one giant batch message
	if (!batchable) messages.push({ ts: ts++, type: "say", say: "text", text: filler(textBytes, round), images })
	messages.push({
		ts: ts++,
		type: "ask",
		ask: "tool",
		text: JSON.stringify(toolPayload(round)),
		isAnswered: true,
	})
	if (!batchable) messages.push({ ts: ts++, type: "say", say: "user_feedback", text: `ok ${round}` })
	apiHistory.push(
		{ role: "assistant", content: [{ type: "text", text: filler(textBytes, round) }], ts },
		{ role: "user", content: [{ type: "text", text: `ok ${round}` }], ts },
	)
}
messages.length = messageCount

const historyItem = {
	id: taskId,
	number: 9999,
	ts: Date.now(),
	task: taskText,
	tokensIn: round * 1000,
	tokensOut: round * 200,
	totalCost: 0,
	workspace,
	status: "completed",
}

// Write every file under a temporary name and rename only after all writes succeeded, so an interrupted run
// (or a full disk) never leaves a truncated or partial task; history_item.json goes last.
const taskFiles = [
	["ui_messages.json", messages],
	["api_conversation_history.json", apiHistory],
	["history_item.json", historyItem],
]
try {
	for (const [name, value] of taskFiles) fs.writeFileSync(path.join(taskDir, `${name}.tmp`), JSON.stringify(value))
	for (const [name] of taskFiles) fs.renameSync(path.join(taskDir, `${name}.tmp`), path.join(taskDir, name))
} catch (error) {
	fs.rmSync(taskDir, { recursive: true, force: true })
	throw error
}

const mb = (f) => (fs.statSync(path.join(taskDir, f)).size / 1048576).toFixed(1)
console.log(`Task ${taskId}: ${messages.length} messages, ui_messages.json ${mb("ui_messages.json")} MB`)
console.log(`Written to ${taskDir}\nReload VS Code, then open "${taskText}" from history.`)
