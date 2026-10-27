import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { createRequire } from "node:module"
import { build } from "esbuild"

import type { HistoryItem } from "../packages/types/src/history"
import type { TaskHistoryStore as Store } from "../src/core/task-persistence/TaskHistoryStore"

// Bounded exploration of the production startup protocol, rather than a second
// implementation of its repair transitions. No concurrent hosts or crash cuts.
const MAX_CASES = 1_368
const MAX_WRITES = 8
const ids = ["grandparent", "parent", "child", "other"] as const
type TaskId = (typeof ids)[number]
type Fault = { write: number; edge: "before" | "after"; code: "ELOCKED" | "EBUSY"; repeats: number }
type Scenario = "repair" | "replay" | "migration"

function permutations<T>(values: readonly T[]): T[][] {
	if (!values.length) return [[]]
	return values.flatMap((value, index) =>
		permutations(values.filter((_, other) => index !== other)).map((rest) => [value, ...rest]),
	)
}

async function bundleAt(destination: string, mutation: string | undefined) {
	let applied = false
	await build({
		stdin: {
			contents: 'export { TaskHistoryStore } from "./src/core/task-persistence/TaskHistoryStore"',
			resolveDir: process.cwd(),
		},
		bundle: true,
		platform: "node",
		format: "cjs",
		target: "node22",
		outfile: destination,
		logLevel: "silent",
		plugins: [
			{
				name: "storage-adapter-and-retry-clock",
				setup(build) {
					build.onLoad({ filter: /[\\/]src[\\/]utils[\\/]storage\.ts$/ }, () => ({
						contents: "export async function getStorageBasePath(root: string) { return root }",
						loader: "ts",
					}))
					build.onLoad({ filter: /[\\/]TaskHistoryStore\.ts$/ }, async (args) => {
						let source = await fs.readFile(args.path, "utf8")
						const delays = "[1_000, 2_000, 4_000, 8_000, 8_000, 8_000]"
						assert(source.includes(delays), "Retry clock anchor changed")
						// Preserve retry count and control flow while advancing the clock immediately.
						source = source.replace(delays, "[0, 0, 0, 0, 0, 0]")
						if (mutation) {
							const snapshot =
								mutation === "resnapshot-active"
									? "(this.initializationActiveIds ??= this.getPersistedActiveIds())"
									: "(this.migrationActiveIds ??= this.getPersistedActiveIds())"
							assert(source.includes(snapshot), "Active snapshot mutation anchor changed")
							source = source.replace(snapshot, "this.getPersistedActiveIds()")
							applied = true
						}
						return { contents: source, loader: "ts" }
					})
				},
			},
		],
	})
	assert(!mutation || applied, "Snapshot mutation was not applied")
}

function records(): Record<TaskId, HistoryItem> {
	const item = (id: TaskId, fields: Partial<HistoryItem>): HistoryItem => ({
		id,
		number: 1,
		ts: 1,
		task: id,
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		...fields,
	})
	return {
		grandparent: item("grandparent", { status: "delegated", awaitingChildId: "parent", delegatedToId: "parent" }),
		parent: item("parent", {
			status: "delegated",
			awaitingChildId: "child",
			delegatedToId: "child",
			parentTaskId: "grandparent",
		}),
		child: item("child", { status: "active", parentTaskId: "parent" }),
		other: item("other", { status: "delegated" }),
	}
}

async function runCase(StoreClass: typeof Store, root: string, scenario: Scenario, order: TaskId[], fault?: Fault) {
	const initial = records()
	for (const id of ids) {
		const directory = path.join(root, "tasks", id)
		await fs.mkdir(directory, { recursive: true })
		if (scenario !== "migration")
			await fs.writeFile(path.join(directory, "history_item.json"), JSON.stringify(initial[id]))
	}
	if (scenario === "replay") {
		await fs.writeFile(
			path.join(root, "tasks", "_delegation_repair_intent.json"),
			JSON.stringify({
				version: 1,
				operationId: "checker",
				parentTaskId: "parent",
				childTaskId: "child",
				expected: {
					parent: { status: "delegated", awaitingChildId: "child", delegatedToId: "child" },
					child: { status: "active", parentTaskId: "parent" },
				},
				target: { childStatus: "interrupted", parentStatus: "active" },
			}),
		)
	}
	const store = new StoreClass(root)
	if (scenario === "migration") await store.initialize()
	const trace: string[] = []
	let writes = 0,
		injected = 0,
		attempts = 0
	const reconcile = store.reconcile.bind(store)
	store.reconcile = async (options) => {
		await reconcile(options)
		// Enumerate filesystem directory orders without depending on host readdir ordering.
		store["cache"] = new Map(order.map((id) => [id, store.get(id)!]))
		attempts++
		trace.push(`scan ${attempts}: ${order.map((id) => `${id}=${store.get(id)?.status}`).join(", ")}`)
	}
	const write = store["writeTaskFile"].bind(store)
	store["writeTaskFile"] = async (item, delta) => {
		assert(++writes <= MAX_WRITES, "Initialization write budget exhausted")
		const inject = (edge: Fault["edge"]) => {
			if (fault && edge === fault.edge && writes >= fault.write && injected < fault.repeats) {
				injected++
				trace.push(`${edge} write ${writes} ${item.id}=${item.status}: ${fault.code}`)
				throw Object.assign(new Error("injected repair failure"), { code: fault.code })
			}
		}
		trace.push(`before write ${writes} ${item.id}=${item.status}`)
		inject("before")
		const result = await write(item, delta)
		trace.push(`committed write ${writes} ${item.id}=${item.status}`)
		inject("after")
		return result
	}
	try {
		if (scenario === "migration") {
			// Migration has an explicit caller retry, rather than the store's timer loop.
			// Exercise that public entry point again after each injected failure.
			for (;;) {
				attempts++
				trace.push(
					`migration ${attempts}: ${order.map((id) => `${id}=${store.get(id)?.status ?? "legacy"}`).join(", ")}`,
				)
				try {
					await store.migrateFromGlobalState(order.map((id) => initial[id]))
					break
				} catch (error) {
					if (
						attempts > 2 ||
						!(error instanceof Error) ||
						!("code" in error) ||
						!["ELOCKED", "EBUSY"].includes(String(error.code))
					)
						throw error
				}
			}
		} else await store.initialize()
		assert.equal(injected, fault?.repeats ?? 0, "Fault schedule was not reached")
		assert.equal(attempts, injected + 1, "Retry landmark was not reached")
		assert(store.isHealthy, "Initialization did not publish a healthy snapshot")
		const expected = {
			grandparent: { ...initial.grandparent },
			parent: { ...initial.parent, status: "active", awaitingChildId: undefined, delegatedToId: undefined },
			child: { ...initial.child, status: "interrupted" },
			other: { ...initial.other, status: "active", awaitingChildId: undefined, delegatedToId: undefined },
		}
		for (const id of ids) {
			const disk: unknown = JSON.parse(
				await fs.readFile(path.join(root, "tasks", id, "history_item.json"), "utf8"),
			)
			// JSON normalization removes optional undefined fields from both sides.
			assert.deepEqual(disk, JSON.parse(JSON.stringify(expected[id])), `${id} disk state changed across retries`)
			assert.deepEqual(JSON.parse(JSON.stringify(store.get(id))), disk, `${id} cache differs from disk`)
		}
		await assert.rejects(fs.access(path.join(root, "tasks", "_delegation_repair_intent.json")), { code: "ENOENT" })
	} catch (error) {
		throw new Error(
			`Initialization invariant: recovery must preserve repaired parents and their ancestor links\nScenario: ${scenario}; order: ${order.join(" -> ")}; fault: ${JSON.stringify(fault ?? null)}\n${trace.join("\n")}`,
			{ cause: error },
		)
	} finally {
		store.dispose()
	}
}

async function main() {
	const mutation = process.argv.find((arg) => arg.startsWith("--mutation="))?.split("=")[1]
	assert(
		process.argv
			.slice(2)
			.every((arg) => ["--mutation=resnapshot-active", "--mutation=resnapshot-migration"].includes(arg)),
		"Unknown checker argument",
	)
	const work = await fs.mkdtemp(path.join(os.tmpdir(), "history-initialization-check-"))
	const warn = console.warn,
		error = console.error
	try {
		const bundle = path.join(work, "production.cjs")
		await bundleAt(bundle, mutation)
		// The generated module exports the production class with only the adapter/clock substitutions above.
		const { TaskHistoryStore } = createRequire(path.join(process.cwd(), "package.json"))(bundle) as {
			TaskHistoryStore: typeof Store
		}
		console.warn = console.error = () => {}
		const faults: Array<Fault | undefined> = [undefined]
		for (const write of [1, 2, 3])
			for (const code of ["ELOCKED", "EBUSY"] as const) {
				faults.push(
					{ write, code, edge: "before", repeats: 1 },
					{ write, code, edge: "before", repeats: 2 },
					{ write, code, edge: "after", repeats: 1 },
				)
			}
		let cases = 0
		for (const scenario of ["repair", "replay", "migration"] as const)
			for (const order of permutations(ids))
				for (const fault of faults) {
					assert(++cases <= MAX_CASES, "Initialization case budget exhausted")
					const root = path.join(work, `case-${cases}`)
					await runCase(TaskHistoryStore, root, scenario, order, fault)
					await fs.rm(root, { recursive: true, force: true })
				}
		assert.equal(cases, MAX_CASES, "Initialization exploration lost a scenario")
		assert(!mutation, "Active snapshot mutant survived")
		console.log(
			`History initialization check passed: ${cases} cases, 24 scan orders, repair, replay and migration, before/after commits, ELOCKED/EBUSY, up to two retries. No concurrency or process-crash proof.`,
		)
	} finally {
		console.warn = warn
		console.error = error
		await fs.rm(work, { recursive: true, force: true })
	}
}

void main().catch((error: unknown) => {
	console.error(error)
	process.exitCode = 1
})
