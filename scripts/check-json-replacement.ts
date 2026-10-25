import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { execFile } from "node:child_process"
import { build } from "esbuild"

// Real filesystem fallback: no production injection seam. Each cut kills a fresh
// process, so exception cleanup cannot masquerade as process-crash recovery.
const ROOT = process.cwd()
const MAX_STEPS = 128
const MAX_CASES = 2_000
const modes = ["write", "fallback", "rollback", "restore", "read", "newer", "cold"] as const
type Mode = (typeof modes)[number]
type Fault = { step: number; kind: "before" | "after" | "EPERM" | "EBUSY" | "EACCES" | "EIO" }
type Event = { n: number; phase: string; call: string; paths: string[]; copies: string[]; code?: string }
type Result = { op: string; ok: boolean; code?: string; value?: string; repairRuns: number; healthy?: boolean }

const CHILD = String.raw`
const fs = require("fs"), fsp = require("fs/promises"), path = require("path")
const native = { ...fsp }, emit = (data) => fs.writeSync(1, JSON.stringify(data) + "\n")
let root = process.env.CHECK_ROOT, fault = JSON.parse(process.env.CHECK_FAULT || "null"), count = 0, forced = false, rolledBack = false, observing = true, pending = 0, pendingClose, pendingCommit, pendingSnapshotMove
const canonical = () => path.join(root, "tasks", "child", "history_item.json")
const normalize = (p) => typeof p === "string" ? path.relative(root, p).replace(/\\/g, "/").replace(/\.(new|bak)_[^.]+\.tmp/g, ".$1.tmp") : ""
function copies() {
 const dir = path.dirname(canonical())
 // Native namespace changes can race this synchronous list/read observer.
 // Retry the whole snapshot; never drop a missing entry from a stale list.
 for (let attempt = 0; attempt < 3; attempt++) {
  try {
 const names = fs.readdirSync(dir).filter((name) => name === "history_item.json" || (name.startsWith(".history_item.json.bak_") && name.endsWith(".tmp")))
 if (pendingSnapshotMove) { const move = pendingSnapshotMove; pendingSnapshotMove = undefined; move() }
 return names.map((name) => fs.readFileSync(path.join(dir, name), "utf8"))
  } catch (error) { if (error.code !== "ENOENT") throw error }
 }
 throw new Error("Committed-copy snapshot retry budget exhausted")
}
console.error = console.warn = console.log = () => {}
Math.random = () => 0.5
function cut(n, phase) {
 if (fault && fault.step === n && fault.kind === phase) {
  if (process.env.CHECK_SCHEDULE === "late-rename") {
   if (!pendingCommit) throw new Error("Regression schedule did not reach the in-flight rename")
   pendingCommit()
  }
  emit({ crash: true }); process.kill(process.pid, "SIGKILL")
 }
}
function before(call, args) {
 if (!observing) return { n: 0 }
 const n = ++count
 if (n > Number(process.env.CHECK_MAX_STEPS)) throw new Error("Filesystem-step budget exhausted")
 emit({ n, phase: "before", call, copies: copies(), paths: args.filter((p) => typeof p === "string").slice(0, 2).map(normalize) })
 cut(n, "before")
 let code = fault && fault.step === n && !["before", "after"].includes(fault.kind) ? fault.kind : undefined
 if (!code && ["fallback", "rollback"].includes(process.env.CHECK_MODE) && call === "rename" && args[1] === canonical() && String(args[0]).includes(".new_")) {
  if (!forced) { forced = true; code = "EPERM" }
  else if (process.env.CHECK_MODE === "rollback" && !rolledBack) { rolledBack = true; code = "EIO" }
 }
 return { n, error: code && Object.assign(new Error("injected " + code), { code }) }
}
function after(n, call, error) {
 if (!n) return
 emit({ n, phase: "after", call, copies: copies(), paths: [], code: error && error.code })
 cut(n, "after")
}
for (const name of ["mkdir", "access", "readdir", "stat", "readFile", "rename", "unlink"]) {
 fsp[name] = async (...args) => {
  const { n, error } = before(name, args)
  try {
   if (error) throw error
   if (name === "rename" && process.env.CHECK_SCHEDULE === "move-during-snapshot" && args[0] === canonical()) {
    pendingSnapshotMove = () => fs.renameSync(...args)
    if (pendingClose) pendingClose()
    return await new Promise(() => {})
   }
   if (name === "rename" && process.env.CHECK_SCHEDULE === "late-rename") {
    // Hold the real rename until the close snapshot has been emitted. Its
    // filesystem effect then lands before SIGKILL, without a JS completion event.
    pendingCommit = () => fs.renameSync(...args)
    if (pendingClose) pendingClose()
    return await new Promise(() => {})
   }
   const value = await native[name](...args); after(n, name); return value
  }
  catch (error) { after(n, name, error); throw error }
 }
}
function callbacks(names, prefix) {
 const result = { ...fs }
 for (const name of names) result[name] = (...args) => {
  const callback = args.pop(), { n, error } = before(prefix + name, args)
  if (error) { after(n, prefix + name, error); return callback(error) }
  pending++
  return fs[name](...args, (error, ...values) => {
   const finish = () => { pending--; after(n, prefix + name, error); callback(error, ...values) }
   if (prefix === "stream." && name === "close" && process.env.CHECK_SCHEDULE) {
    pendingClose = finish
    if (pendingCommit || pendingSnapshotMove) finish()
   } else finish()
  })
 }
 return result
}
const streamFs = callbacks(["open", "write", "writev", "close"], "stream.")
const createStream = fs.createWriteStream
fs.createWriteStream = (file, options) => createStream(file, { ...options, fs: streamFs })
const lock = require("proper-lockfile"), acquire = lock.lock
lock.lock = (file, options) => acquire(file, { ...options, fs: callbacks(["mkdir", "rmdir", "stat", "utimes"], "lock.") })
const production = require(process.env.CHECK_BUNDLE)
async function operation(op) {
 let store, repairRuns = 0, value
 try {
  if (["write", "fallback", "rollback", "restore"].includes(op)) {
   await production.safeWriteJson(canonical(), JSON.parse(process.env.CHECK_INCOMING))
   value = await native.readFile(canonical(), "utf8")
  }
  else if (["read", "newer", "newer-recovery"].includes(op)) {
   if (op === "newer-recovery") await production.recoverJsonFile(canonical())
   value = await production.readFileWithMissingRetry(canonical())
  }
  else {
   store = new production.TaskHistoryStore(root)
   const repair = store.reconcileDelegationState.bind(store)
   store.reconcileDelegationState = (...args) => { repairRuns++; return repair(...args) }
   if (op === "delete") {
    await store.delete("child")
    try { value = await production.readFileWithMissingRetry(canonical()) } catch (error) { if (error.code !== "ENOENT") throw error }
   } else {
    await store.initialize()
    value = JSON.stringify(store.get("child"))
   }
  }
  return { op, ok: true, value, repairRuns, healthy: store && store.isHealthy }
 } catch (error) { return { op, ok: false, code: error.code, repairRuns } }
 finally { if (store) store.dispose() }
}
async function ageLocks(dir) {
 for (const entry of await native.readdir(dir, { withFileTypes: true })) {
  const full = path.join(dir, entry.name)
  if (!entry.isDirectory()) continue
  if (entry.name.endsWith(".lock")) {
   const old = new Date(Date.now() - 33000); await native.utimes(full, old, old)
  } else await ageLocks(full)
 }
}
async function run() {
 if (process.env.CHECK_MODE !== "followups") return emit({ result: await operation(process.env.CHECK_MODE) })
 const source = root
 for (const op of ["read", "write", "delete", "cold"]) {
  root = path.join(path.dirname(source), "followup-" + op)
  observing = false
  await native.cp(source, root, { recursive: true }); await ageLocks(root)
  observing = true
  count = 0; fault = null
  emit({ result: await operation(op) })
 }
}
run().then(async () => { while (pending) await new Promise((resolve) => setTimeout(resolve, 1)); process.exit(0) }).catch((error) => { emit({ harnessError: String(error.stack) }); process.exit(2) })
`

function value(cost: number) {
	return {
		id: "child",
		number: 1,
		ts: 1,
		task: "child",
		tokensIn: 0,
		tokensOut: 0,
		totalCost: cost,
		status: "interrupted",
		parentTaskId: "parent",
		childIds: [],
	}
}
const encoded = [JSON.stringify(value(0)), JSON.stringify(value(1)), JSON.stringify(value(2))] as const
const relativeCanonical = path.join("tasks", "child", "history_item.json")
function seed(root: string, mode: Mode | "delete") {
	fs.mkdirSync(path.join(root, "tasks", "child"), { recursive: true })
	fs.mkdirSync(path.join(root, "tasks", "parent"), { recursive: true })
	fs.writeFileSync(
		path.join(root, "tasks", "parent", "history_item.json"),
		JSON.stringify({
			...value(0),
			id: "parent",
			status: "delegated",
			awaitingChildId: "child",
			delegatedToId: "child",
			parentTaskId: undefined,
			childIds: ["child"],
		}),
	)
	if (!["restore", "read", "cold"].includes(mode))
		fs.writeFileSync(path.join(root, relativeCanonical), encoded[mode === "newer" ? 1 : 0])
	if (["restore", "read", "cold", "newer", "delete"].includes(mode)) {
		fs.writeFileSync(path.join(root, "tasks", "child", ".history_item.json.bak_seed.tmp"), encoded[0])
		fs.writeFileSync(path.join(root, "tasks", "child", ".history_item.json.new_seed.tmp"), '{"partial":')
	}
}
function committed(root: string): string[] {
	const dir = path.join(root, "tasks", "child")
	return fs
		.readdirSync(dir)
		.filter(
			(name) =>
				name === "history_item.json" || (name.startsWith(".history_item.json.bak_") && name.endsWith(".tmp")),
		)
		.map((name) => fs.readFileSync(path.join(dir, name), "utf8"))
}
async function runtime(
	bundle: string,
	root: string,
	mode: string,
	fault?: Fault,
	schedule?: "late-rename" | "move-during-snapshot",
) {
	const child = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
		execFile(
			process.execPath,
			["-e", CHILD],
			{
				env: {
					...process.env,
					NODE_PATH: [path.join(ROOT, "src/node_modules"), path.join(ROOT, "node_modules")].join(
						path.delimiter,
					),
					CHECK_BUNDLE: bundle,
					CHECK_MAX_STEPS: String(MAX_STEPS),
					CHECK_ROOT: root,
					CHECK_MODE: mode,
					CHECK_INCOMING: encoded[2],
					CHECK_FAULT: JSON.stringify(fault ?? null),
					CHECK_SCHEDULE: schedule,
				},
				encoding: "utf8",
				timeout: 20_000,
				maxBuffer: 4_000_000,
			},
			(error, stdout, stderr) => {
				if (error && (typeof error.code === "string" || error.killed)) reject(error)
				else
					resolve({
						status: error ? (typeof error.code === "number" ? error.code : null) : 0,
						stdout,
						stderr,
					})
			},
		)
	})
	const output = child.stdout
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { n?: number; result?: Result; harnessError?: string; crash?: boolean })
	assert(!output.some((event) => event.harnessError), child.stdout + child.stderr)
	assert(child.status === 0 || output.some((event) => event.crash), child.stderr)
	if (fault && ["before", "after"].includes(fault.kind))
		assert(
			output.some((event) => event.crash),
			"Crash cutpoint was not reached",
		)
	return {
		events: output.filter((event) => event.n !== undefined) as Event[],
		results: output.flatMap((event) => (event.result ? [event.result] : [])),
	}
}
async function bundleAt(destination: string, mutation?: string) {
	let applied = false
	await build({
		stdin: {
			contents:
				'export { safeWriteJson, recoverJsonFile } from "./src/utils/safeWriteJson"; export { readFileWithMissingRetry } from "./src/core/task-persistence/readFileWithMissingRetry"; export { TaskHistoryStore } from "./src/core/task-persistence/TaskHistoryStore"',
			resolveDir: ROOT,
		},
		bundle: true,
		platform: "node",
		format: "cjs",
		target: "node22",
		outfile: destination,
		external: ["proper-lockfile"],
		logLevel: "silent",
		plugins: [
			{
				name: "environment-and-mutations",
				setup(build) {
					build.onLoad({ filter: /[\\/]src[\\/]utils[\\/]storage\.ts$/ }, () => ({
						contents: "export async function getStorageBasePath(root: string) { return root }",
						loader: "ts",
					}))
					if (mutation)
						build.onLoad({ filter: /[\\/](safeWriteJson|TaskHistoryStore)\.ts$/ }, (args) => {
							let source = fs.readFileSync(args.path, "utf8")
							if (mutation === "restore-backup-loss" && args.path.endsWith("safeWriteJson.ts")) {
								const original =
									"await fs.rename(newestBackupPath, absoluteFilePath)\n\t\t\trestoredFrom = newestBackupPath"
								assert(source.includes(original), "Restore mutation anchor changed")
								source = source.replace(original, "try { " + original + " } catch {}")
								applied = true
							}
							if (mutation === "reader-overwrites-newer" && args.path.endsWith("safeWriteJson.ts")) {
								const original = "await fs.access(absoluteFilePath)"
								assert(source.includes(original), "Reader mutation anchor changed")
								source = source.replace(
									original,
									'throw Object.assign(new Error("mutation: ignore canonical"), { code: "ENOENT" })',
								)
								applied = true
							}
							if (mutation === "delete-keeps-backup" && args.path.endsWith("TaskHistoryStore.ts")) {
								assert(
									source.includes("await removeJsonBackups(absoluteFilePath)"),
									"Deletion mutation anchor changed",
								)
								applied = true
								source = source.replaceAll(
									"await removeJsonBackups(absoluteFilePath)",
									"/* mutation: omit backup removal */",
								)
							}
							if (mutation === "swallowed-replay-error" && args.path.endsWith("TaskHistoryStore.ts")) {
								const original = "await this.replayDelegationRepairIntent()"
								assert(source.includes(original), "Replay mutation anchor changed")
								source = source.replace(original, "try { " + original + " } catch {}")
								applied = true
							}
							return { contents: source, loader: "ts" }
						})
				},
			},
		],
	})
	assert(!mutation || applied, "Mutation was not applied")
}

function violation(invariant: number, context: string, events: Event[]): never {
	throw new Error(
		`JSON replacement invariant ${invariant}: ${context}\n` +
			events
				.map(
					(event) =>
						`${event.n}. ${event.phase} ${event.call} ${event.paths.join(" -> ")}${event.code ? " [" + event.code + "]" : ""}`,
				)
				.join("\n"),
	)
}
async function runCase(
	bundle: string,
	dir: string,
	mode: Mode,
	fault?: Fault,
	schedule?: "late-rename" | "move-during-snapshot",
) {
	const root = path.join(dir, "storage")
	seed(root, mode)
	const beforeCanonical = fs.existsSync(path.join(root, relativeCanonical))
		? fs.readFileSync(path.join(root, relativeCanonical), "utf8")
		: undefined
	const run = await runtime(bundle, root, mode, fault, schedule)
	const context = `${mode} ${JSON.stringify(fault ?? "no fault")}`
	let latest = mode === "newer" ? 1 : 0
	for (const [index, event] of run.events.entries()) {
		const version = Math.max(-1, ...event.copies.map((data) => encoded.findIndex((entry) => entry === data)))
		if (version < latest) violation(2, context + " lost the latest committed copy", run.events.slice(0, index + 1))
		latest = version
	}
	assert(run.events.length <= MAX_STEPS * 2, "Replay filesystem-step budget exhausted")
	if (fault)
		assert(
			run.events.some((event) => event.n === fault.step),
			"Fault cutpoint was not reached",
		)
	// Native renames can finish after the last JS snapshot but before SIGKILL.
	// Once the child exits, its actual disk state owns follow-up expectations.
	const diskVersion = Math.max(-1, ...committed(root).map((data) => encoded.findIndex((entry) => entry === data)))
	if (diskVersion < latest)
		violation(2, context + " lost the latest committed copy after the last snapshot", run.events)
	latest = diskVersion
	const result = run.results[0]
	if (
		result?.ok &&
		["write", "fallback", "rollback", "restore"].includes(mode) &&
		fs.readFileSync(path.join(root, relativeCanonical), "utf8") !== encoded[2]
	)
		violation(1, context, run.events)
	if (
		["read", "newer"].includes(mode) &&
		beforeCanonical !== undefined &&
		fs.readFileSync(path.join(root, relativeCanonical), "utf8") !== beforeCanonical
	)
		violation(6, context, run.events)
	if (result?.ok && ["read", "newer"].includes(mode) && !encoded.some((entry) => entry === result.value))
		violation(3, context, run.events)
	if (mode === "cold" && result && !result.ok && result.repairRuns !== 0) violation(5, context, run.events)
	// A read fault must not be reclassified as a missing or malformed intent.
	// Check the injected outcome, not only the implication "failure => no repair".
	if (mode === "cold" && fault && ["EPERM", "EACCES", "EIO"].includes(fault.kind)) {
		const injected = run.events.find((event) => event.n === fault.step && event.phase === "before")
		if (
			injected?.call === "readFile" &&
			injected.paths.some((entry) => entry.endsWith("_delegation_repair_intent.json"))
		) {
			if (!result || result.ok || result.code !== fault.kind || result.repairRuns !== 0)
				violation(5, context + " replay read failure published health or entered repair", run.events)
		}
	}
	const followups = (await runtime(bundle, root, "followups")).results
	assert.equal(followups.length, 4)
	for (const followup of followups) {
		if (!followup.ok)
			violation(3, context + " follow-up " + followup.op + " rejected: " + followup.code, run.events)
		if (followup.op === "delete" && followup.value !== undefined)
			violation(4, context + " deleted file returned after recovery", run.events)
		if (followup.op !== "delete" && followup.value !== encoded[followup.op === "write" ? 2 : latest])
			violation(
				3,
				context +
					` follow-up ${followup.op} returned an invalid value (expected version ${followup.op === "write" ? 2 : latest})`,
				run.events,
			)
		if (followup.op === "cold" && !followup.healthy)
			violation(5, context + " cold-start snapshot unavailable", run.events)
	}
	return run.events
}
async function main() {
	const work = fs.mkdtempSync(path.join(os.tmpdir(), "json-replacement-check-"))
	try {
		const mutation = process.argv.find((arg) => arg.startsWith("--mutation="))?.split("=")[1]
		const bundle = path.join(work, "production.cjs")
		await bundleAt(bundle, mutation)
		const regression = process.argv.find((arg) => arg.startsWith("--regression="))?.split("=")[1]
		if (regression === "rename-in-flight" || regression === "snapshot-race") {
			const mode = regression === "rename-in-flight" ? "write" : "fallback"
			const schedule = regression === "rename-in-flight" ? "late-rename" : "move-during-snapshot"
			const trace = await runCase(bundle, path.join(work, "baseline"), mode)
			const close = trace.find((event) => event.phase === "before" && event.call === "stream.close")
			assert(close, "Regression requires the real stream-close boundary")
			await runCase(bundle, path.join(work, schedule), mode, { step: close.n, kind: "after" }, schedule)
			console.log(`${regression} regression passed`)
			return
		}
		assert(!regression, "Unknown regression")
		if (mutation === "restore-backup-loss") {
			const baseline = path.join(work, "baseline")
			const events = await runCase(bundle, baseline, "restore")
			const restore = events.find(
				(event) => event.phase === "before" && event.call === "rename" && event.paths[0]?.includes(".bak"),
			)
			assert(restore)
			await runCase(bundle, path.join(work, "mutant"), "restore", { step: restore.n, kind: "EIO" })
			throw new Error("Restore mutant survived")
		}
		if (mutation === "delete-keeps-backup") {
			const root = path.join(work, "delete", "storage")
			seed(root, "delete")
			const run = await runtime(bundle, root, "delete")
			if (run.results[0]?.value !== undefined) violation(4, "deleted file returned after recovery", run.events)
			throw new Error("Deletion mutant survived")
		}
		if (mutation === "reader-overwrites-newer") {
			const root = path.join(work, "reader", "storage")
			seed(root, "newer")
			const run = await runtime(bundle, root, "newer-recovery")
			assert(run.results[0]?.ok, "Mutant reader did not reach its recovery check")
			if (fs.readFileSync(path.join(root, relativeCanonical), "utf8") !== encoded[1])
				violation(6, "reader replaced a newer canonical value", run.events)
			throw new Error("Reader mutant survived")
		}
		if (mutation === "swallowed-replay-error") {
			const events = await runCase(bundle, path.join(work, "replay-baseline"), "cold")
			const read = events.find(
				(event) =>
					event.phase === "before" &&
					event.call === "readFile" &&
					event.paths.some((entry) => entry.endsWith("_delegation_repair_intent.json")),
			)
			assert(read, "Replay read was not reached")
			await runCase(bundle, path.join(work, "replay-mutant"), "cold", { step: read.n, kind: "EIO" })
			throw new Error("Replay mutant survived")
		}
		assert(!mutation, "Unknown mutation")
		const workers = Number(process.env.JSON_REPLACEMENT_WORKERS ?? 4)
		assert(
			Number.isInteger(workers) && workers >= 1 && workers <= 8,
			"JSON_REPLACEMENT_WORKERS must be an integer from 1 to 8",
		)
		const jobs: Array<() => Promise<void>> = []
		let cases = 0,
			steps = 0
		for (const mode of modes) {
			const trace = await runCase(bundle, path.join(work, `${mode}-baseline`), mode)
			const calls = trace.filter((event) => event.phase === "before")
			assert(calls.length <= MAX_STEPS, "Filesystem-step budget exhausted")
			steps += calls.length
			console.log(`${mode}: ${calls.length} filesystem cutpoints`)
			for (const call of calls)
				for (const kind of ["before", "after", "EPERM", "EBUSY", "EACCES", "EIO"] as const) {
					assert(++cases <= MAX_CASES, "Case budget exhausted")
					const dir = path.join(work, `case-${cases}`)
					jobs.push(async () => {
						const replay = await runCase(bundle, dir, mode, { step: call.n, kind })
						assert.equal(
							replay.find((event) => event.n === call.n)?.call,
							call.call,
							"Cutpoint order changed",
						)
						fs.rmSync(dir, { recursive: true, force: true })
					})
				}
		}
		// Settle active workers before cleanup. Keep failures in case order,
		// even when workers complete in a different order.
		let next = 0
		const failures: Array<{ index: number; reason: unknown }> = []
		await Promise.all(
			Array.from({ length: workers }, async () => {
				while (!failures.length) {
					const index = next++,
						job = jobs[index]
					if (!job) return
					try {
						await job()
					} catch (reason: unknown) {
						failures.push({ index, reason })
					}
				}
			}),
		)
		failures.sort((a, b) => a.index - b.index)
		if (failures[0]) throw failures[0].reason
		console.log(
			`JSON replacement check passed: ${steps} cutpoints, ${cases} fault/crash cases, ${workers} workers, four isolated follow-ups per case. No interleaving or Windows proof.`,
		)
	} finally {
		fs.rmSync(work, { recursive: true, force: true })
	}
}
void main().catch((error: unknown) => {
	console.error(error)
	process.exitCode = 1
})
