#!/usr/bin/env node
// Measures what a saved Zoo Code task is made of, to see what the webview has to hold: sizes only, never prints message content.
//
//   node scripts/gray-screen/analyze-session.mjs [--storage <globalStorage>] [--top 15] [--task <id>] [--include-generated true]
//
// Per task: file size, message counts, bytes per message kind and per tool, bytes per JSON field of tool payloads
// (originalContent / content / diff ...), share of strings V8 stores as 2 bytes/char (any char above U+00FF), and the
// longest run of consecutive file-edit asks that ChatView's batchNearby would merge into one message.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { integerFlag } from "./lib.mjs"

const args = Object.fromEntries(
	process.argv.slice(2).reduce((acc, cur, i, all) => {
		if (cur.startsWith("--")) acc.push([cur.slice(2), all[i + 1]])
		return acc
	}, []),
)
const storage =
	args["storage"] ?? path.join(os.homedir(), ".vscode-server", "data", "User", "globalStorage", "codemate.zoo-code")
let top
try {
	top = integerFlag("top", args["top"] ?? 15, 1)
} catch (e) {
	console.error(e.message)
	process.exit(1)
}
const includeGenerated = args["include-generated"] === "true"
const tasksDir = path.join(storage, "tasks")

const EDIT_TOOLS = new Set(["editedExistingFile", "appliedDiff", "newFileCreated", "insertContent", "searchAndReplace"])
const BOUNDARY_SAY = new Set(["user_feedback", "user_feedback_diff", "completion_result", "checkpoint_saved", "error", "condense_context", "codebase_search_result"])
const NON_LATIN1 = /[^\u0000-ÿ]/
const mb = (n) => (n / 1048576).toFixed(1)

const isIgnorable = (m) => m.type === "say" && (m.say === "api_req_started" || (m.say === "text" && !m.text?.trim()) || m.say === "reasoning")
const isBoundary = (m) => m.type === "say" && (BOUNDARY_SAY.has(m.say) || (m.say === "text" && !!m.text?.trim()))

function analyze(taskId) {
	const file = path.join(tasksDir, taskId, "ui_messages.json")
	const raw = fs.readFileSync(file, "utf8")
	const messages = JSON.parse(raw)
	const r = { taskId, fileBytes: Buffer.byteLength(raw), count: messages.length, kinds: {}, tools: {}, fields: {}, imageBytes: 0, twoByteBytes: 0, latin1Bytes: 0, maxRun: 0, maxRunBytes: 0, runs2plus: 0 }

	const add = (obj, key, bytes) => {
		const e = (obj[key] ??= { n: 0, bytes: 0 })
		e.n++
		e.bytes += bytes
	}
	const classify = (str) => {
		if (NON_LATIN1.test(str)) r.twoByteBytes += str.length * 2
		else r.latin1Bytes += str.length
	}

	for (const m of messages) {
		const text = typeof m.text === "string" ? m.text : ""
		add(r.kinds, `${m.type}:${m.say ?? m.ask ?? "?"}`, text.length)
		if (text) classify(text)
		if (Array.isArray(m.images)) for (const img of m.images) r.imageBytes += typeof img === "string" ? img.length : 0
		if (m.type === "ask" && m.ask === "tool" && text) {
			try {
				const t = JSON.parse(text)
				add(r.tools, String(t.tool), text.length)
				for (const [k, v] of Object.entries(t)) add(r.fields, k, typeof v === "string" ? v.length : JSON.stringify(v)?.length ?? 0)
			} catch {}
		}
	}

	// longest run of consecutive edit asks that batchNearby merges (same rules as batchNearby.ts)
	const isEditAsk = (m) => {
		if (m.type !== "ask" || m.ask !== "tool" || !m.text) return false
		try {
			const t = JSON.parse(m.text)
			return EDIT_TOOLS.has(t.tool) && !t.batchDiffs
		} catch {
			return false
		}
	}
	const items = messages.slice(1)
	for (let i = 0; i < items.length; ) {
		if (isBoundary(items[i])) { i++; continue }
		if (!isEditAsk(items[i])) { i++; continue }
		let j = i + 1, len = 1, bytes = items[i].text.length
		while (j < items.length) {
			if (isBoundary(items[j])) break
			if (isEditAsk(items[j])) { len++; bytes += items[j].text.length; j++ }
			else if (isIgnorable(items[j])) j++
			else break
		}
		if (len > 1) r.runs2plus++
		if (len > r.maxRun) { r.maxRun = len; r.maxRunBytes = bytes }
		i = j
	}
	return r
}

const taskMeta = (id) => {
	try { return JSON.parse(fs.readFileSync(path.join(tasksDir, id, "history_item.json"), "utf8")) } catch { return {} }
}
const ids = args["task"] ? [args["task"]] : fs.readdirSync(tasksDir).filter((id) => fs.existsSync(path.join(tasksDir, id, "ui_messages.json")))
const sizes = ids.map((id) => ({ id, size: fs.statSync(path.join(tasksDir, id, "ui_messages.json")).size, generated: (taskMeta(id).task ?? "").startsWith("[LOAD TEST]") }))
const real = sizes.filter((s) => includeGenerated || !s.generated)

const sorted = real.map((s) => s.size).sort((a, b) => a - b)
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
console.log(`storage: ${storage}`)
console.log(`tasks: ${ids.length} (excluded ${sizes.length - real.length} generated [LOAD TEST] tasks${includeGenerated ? " - included" : ""}); analyzed set: ${real.length}`)
console.log(`ui_messages.json size: p50=${mb(pct(0.5))}MB p90=${mb(pct(0.9))}MB p99=${mb(pct(0.99))}MB max=${mb(sorted.at(-1) ?? 0)}MB; over 10MB: ${sorted.filter((s) => s > 10 * 1048576).length}, over 5MB: ${sorted.filter((s) => s > 5 * 1048576).length}`)

let unreadable = 0
const results = []
for (const s of real.sort((a, b) => b.size - a.size)) {
	if (results.length >= top) break
	try {
		results.push(analyze(s.id))
	} catch {
		unreadable++
	}
}
if (unreadable) console.log(`skipped ${unreadable} task(s) whose ui_messages.json could not be parsed`)
console.log(`\nTop ${results.length} tasks by ui_messages.json size (sizes only, no content):`)
console.log("size(MB)  msgs  toolTxt(MB) editTools  topField(share)                 2byte%  imgMB  maxBatchRun(bytes MB)  task")
for (const r of results) {
	const toolBytes = Object.values(r.tools).reduce((a, b) => a + b.bytes, 0)
	const editCount = Object.entries(r.tools).filter(([k]) => EDIT_TOOLS.has(k)).reduce((a, [, v]) => a + v.n, 0)
	const fieldTotal = Object.values(r.fields).reduce((a, b) => a + b.bytes, 0) || 1
	const [topKey, topVal] = Object.entries(r.fields).sort((a, b) => b[1].bytes - a[1].bytes)[0] ?? ["-", { bytes: 0 }]
	const text = r.latin1Bytes + r.twoByteBytes || 1
	const meta = taskMeta(r.taskId)
	console.log(
		`${mb(r.fileBytes).padStart(7)}  ${String(r.count).padStart(5)}  ${mb(toolBytes).padStart(9)}  ${String(editCount).padStart(9)}  ${`${topKey} ${(100 * topVal.bytes / fieldTotal).toFixed(0)}%`.padEnd(30)}  ${(100 * r.twoByteBytes / text).toFixed(0).padStart(5)}%  ${mb(r.imageBytes).padStart(5)}  ${`${r.maxRun} (${mb(r.maxRunBytes)})`.padEnd(20)}  ${(meta.task ?? "").slice(0, 28).replace(/\s+/g, " ")} [${r.taskId.slice(0, 8)}]`,
	)
}

const biggest = results[0]
if (biggest) {
	console.log(`\nBreakdown of the largest analyzed task [${biggest.taskId.slice(0, 8)}], ${mb(biggest.fileBytes)}MB, ${biggest.count} messages:`)
	const show = (title, obj, n = 8) => {
		console.log(`  ${title}`)
		for (const [k, v] of Object.entries(obj).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, n)) console.log(`    ${k.padEnd(28)} n=${String(v.n).padStart(5)}  ${mb(v.bytes).padStart(7)}MB`)
	}
	show("by message kind (text bytes):", biggest.kinds)
	show("by tool (payload bytes):", biggest.tools)
	show("by tool payload field (string chars):", biggest.fields)
}
