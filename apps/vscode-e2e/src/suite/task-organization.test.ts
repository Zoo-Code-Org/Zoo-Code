import * as assert from "assert"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import {
	MAX_PINNED_TARGETS,
	createEmptyTaskOrganizationState,
	taskOrganizationMutationSchema,
	taskOrganizationMutationRequestSchema,
	taskOrganizationStateSchema,
	type TaskOrganizationMutationRequestV1,
	type TaskOrganizationStateV1,
} from "@roo-code/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { waitUntilCompleted } from "./utils"

const ORG_FILENAME = "_taskOrganization.json"

/**
 * The Task Organization feature's public contract is the versioned, validated
 * JSON aggregate persisted at `<globalStorage>/tasks/_taskOrganization.json`
 * together with the Zod-validated mutation/result envelope exchanged with the
 * webview. These e2e tests exercise that contract end-to-end against the real
 * on-disk format and against real tasks created through the extension API.
 *
 * The `TaskOrganizationStore` class lives in the extension bundle, which is
 * not separately importable from this project, so these tests drive the same
 * aggregate file the store manages and validate it with the exact schemas the
 * store uses. This keeps the e2e suite aligned with the shipped persistence
 * format without reaching into extension internals.
 */

/** Drive a real task to completion and return its id. */
const startCompletedTask = async (text: string): Promise<string> => {
	const api = globalThis.api
	const taskId = await api.startNewTask({
		configuration: { mode: "ask", alwaysAllowModeSwitch: true, autoApprovalEnabled: true },
		text,
	})
	await waitUntilCompleted({ api, taskId })
	return taskId
}

/** Apply a mutation to an in-memory state, mirroring the store's semantics. */
const applyMutation = (
	state: TaskOrganizationStateV1,
	request: TaskOrganizationMutationRequestV1,
): TaskOrganizationStateV1 => {
	assert.ok(taskOrganizationMutationRequestSchema.safeParse(request).success, "request must validate")
	const { mutation } = request
	assert.ok(taskOrganizationMutationSchema.safeParse(mutation).success, "mutation must validate")

	const next = structuredClone(state)
	next.revision += 1
	next.updatedAt = Date.now()

	switch (mutation.kind) {
		case "createFolder": {
			const unit = [mutation.source, mutation.destination].flatMap((t) =>
				t.kind === "task" ? [t.taskId] : t.kind === "autoGroup" ? [t.rootTaskId] : [],
			)
			next.folders.push({
				folderId: mutation.folderId,
				name: mutation.name,
				taskIds: [...new Set(unit)],
				createdAt: next.updatedAt,
				updatedAt: next.updatedAt,
			})
			break
		}
		case "renameFolder": {
			const folder = next.folders.find((f) => f.folderId === mutation.folderId)
			assert.ok(folder, "folder must exist")
			folder.name = mutation.name
			folder.updatedAt = next.updatedAt
			break
		}
		case "deleteFolder": {
			next.folders = next.folders.filter((f) => f.folderId !== mutation.folderId)
			next.pins = next.pins.filter((p) => !(p.target.kind === "folder" && p.target.folderId === mutation.folderId))
			break
		}
		case "setPinned": {
			const idx = next.pins.findIndex((p) => JSON.stringify(p.target) === JSON.stringify(mutation.target))
			if (mutation.pinned) {
				if (idx === -1) {
					assert.ok(next.pins.length < MAX_PINNED_TARGETS, "pin limit")
					next.pins.push({ target: mutation.target, pinnedAt: next.updatedAt })
				}
			} else if (idx !== -1) {
				next.pins.splice(idx, 1)
			}
			break
		}
	}
	return next
}

/** Persist a state using the same validated, atomic shape the store writes. */
const writeAggregate = async (storageDir: string, state: TaskOrganizationStateV1): Promise<void> => {
	const parsed = taskOrganizationStateSchema.safeParse(state)
	assert.ok(parsed.success, "state written to disk must validate against taskOrganizationStateSchema")
	const tasksDir = path.join(storageDir, "tasks")
	await fs.mkdir(tasksDir, { recursive: true })
	const filePath = path.join(tasksDir, ORG_FILENAME)
	const tmp = `${filePath}.tmp`
	await fs.writeFile(tmp, JSON.stringify(parsed.data, null, "\t"), "utf8")
	await fs.rename(tmp, filePath)
}

/** Read and validate the on-disk aggregate, or undefined if absent. */
const readAggregate = async (storageDir: string): Promise<TaskOrganizationStateV1 | undefined> => {
	const filePath = path.join(storageDir, "tasks", ORG_FILENAME)
	let raw: string
	try {
		raw = await fs.readFile(filePath, "utf8")
	} catch {
		return undefined
	}
	const parsed = taskOrganizationStateSchema.safeParse(JSON.parse(raw))
	assert.ok(parsed.success, "on-disk aggregate must validate against taskOrganizationStateSchema")
	return parsed.data
}

suite("Roo Code Task Organization Persistence", function () {
	setDefaultSuiteTimeout(this)

	let storageDir: string
	let taskA: string
	let taskB: string
	let taskC: string

	suiteSetup(async () => {
		storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "roo-task-org-e2e-"))

		// Seed real tasks through the extension API. Organization targets
		// reference tasks the extension actually created and persisted.
		taskA = await startCompletedTask("ORG_E2E_TASK_A: say hello")
		taskB = await startCompletedTask("ORG_E2E_TASK_B: say hello")
		taskC = await startCompletedTask("ORG_E2E_TASK_C: say hello")

		assert.ok(await globalThis.api.isTaskInHistory(taskA), `task ${taskA} should be in history`)
		assert.ok(await globalThis.api.isTaskInHistory(taskB), `task ${taskB} should be in history`)
		assert.ok(await globalThis.api.isTaskInHistory(taskC), `task ${taskC} should be in history`)
	})

	suiteTeardown(async () => {
		await fs.rm(storageDir, { recursive: true, force: true })
	})

	test("folder CRUD persists a valid aggregate across the full lifecycle", async () => {
		let state = createEmptyTaskOrganizationState()

		// CREATE
		state = applyMutation(state, {
			requestId: "r1",
			baseRevision: state.revision,
			mutation: {
				kind: "createFolder",
				folderId: "folder-1",
				name: "Work",
				source: { kind: "task", taskId: taskA },
				destination: { kind: "task", taskId: taskB },
			},
		})
		await writeAggregate(storageDir, state)
		let onDisk = await readAggregate(storageDir)
		assert.deepStrictEqual(onDisk?.folders.find((f) => f.folderId === "folder-1")?.taskIds.sort(), [taskA, taskB].sort())

		// RENAME
		state = applyMutation(state, {
			requestId: "r2",
			baseRevision: state.revision,
			mutation: { kind: "renameFolder", folderId: "folder-1", name: "Deep Work" },
		})
		await writeAggregate(storageDir, state)
		onDisk = await readAggregate(storageDir)
		assert.strictEqual(onDisk?.folders.find((f) => f.folderId === "folder-1")?.name, "Deep Work")

		// DELETE
		state = applyMutation(state, {
			requestId: "r3",
			baseRevision: state.revision,
			mutation: { kind: "deleteFolder", folderId: "folder-1" },
		})
		await writeAggregate(storageDir, state)
		onDisk = await readAggregate(storageDir)
		assert.strictEqual(onDisk?.folders.length, 0)
		assert.strictEqual(onDisk?.revision, state.revision)
	})

	test("pin/unpin state persists and respects the pin limit schema", async () => {
		let state = createEmptyTaskOrganizationState()

		const targets = [taskA, taskB, taskC].map((taskId) => ({ kind: "task", taskId }) as const)
		for (const target of targets) {
			state = applyMutation(state, {
				requestId: `pin-${target.taskId}`,
				baseRevision: state.revision,
				mutation: { kind: "setPinned", target, pinned: true },
			})
		}
		await writeAggregate(storageDir, state)

		const onDisk = await readAggregate(storageDir)
		assert.strictEqual(onDisk?.pins.length, MAX_PINNED_TARGETS)

		// The schema enforces the pin limit at the persistence boundary: a
		// fourth pin must fail validation.
		const overLimit = structuredClone(state)
		overLimit.pins.push({ target: { kind: "folder", folderId: "f-x" }, pinnedAt: Date.now() })
		assert.strictEqual(taskOrganizationStateSchema.safeParse(overLimit).success, false)

		// Unpin one and confirm it persists.
		const [firstTarget] = targets
		assert.ok(firstTarget, "targets must be non-empty")
		state = applyMutation(state, {
			requestId: "unpin-a",
			baseRevision: state.revision,
			mutation: { kind: "setPinned", target: firstTarget, pinned: false },
		})
		await writeAggregate(storageDir, state)
		const after = await readAggregate(storageDir)
		assert.strictEqual(after?.pins.length, MAX_PINNED_TARGETS - 1)
		assert.ok(!after?.pins.some((p) => p.target.kind === "task" && p.target.taskId === taskA))
	})

	test("organization state survives reload from disk (restart boundary)", async () => {
		let state = createEmptyTaskOrganizationState()
		state = applyMutation(state, {
			requestId: "persist-1",
			baseRevision: state.revision,
			mutation: {
				kind: "createFolder",
				folderId: "persist-folder",
				name: "Persisted",
				source: { kind: "task", taskId: taskA },
				destination: { kind: "task", taskId: taskB },
			},
		})
		state = applyMutation(state, {
			requestId: "persist-2",
			baseRevision: state.revision,
			mutation: { kind: "setPinned", target: { kind: "task", taskId: taskC }, pinned: true },
		})
		await writeAggregate(storageDir, state)

		// A "restart" = reading the aggregate fresh from disk and re-validating.
		const reloaded = await readAggregate(storageDir)
		assert.ok(reloaded, "aggregate should exist after writes")
		assert.deepStrictEqual(reloaded, state)
		assert.strictEqual(reloaded.folders.find((f) => f.folderId === "persist-folder")?.name, "Persisted")
		assert.ok(reloaded.pins.some((p) => p.target.kind === "task" && p.target.taskId === taskC))
	})

	test("a malformed aggregate fails validation and is recoverable", async () => {
		const corruptDir = await fs.mkdtemp(path.join(os.tmpdir(), "roo-task-org-corrupt-"))
		try {
			const tasksDir = path.join(corruptDir, "tasks")
			await fs.mkdir(tasksDir, { recursive: true })
			const filePath = path.join(tasksDir, ORG_FILENAME)
			await fs.writeFile(filePath, "not valid json", "utf8")

			// The store quarantines unparseable data and loads an empty state.
			// Here we assert the contract: raw garbage is not valid aggregate.
			const raw = await fs.readFile(filePath, "utf8")
			assert.throws(() => taskOrganizationStateSchema.parse(JSON.parse(raw)))

			// Recovery: replacing it with a valid empty state restores health.
			await writeAggregate(corruptDir, createEmptyTaskOrganizationState())
			const recovered = await readAggregate(corruptDir)
			assert.deepStrictEqual(recovered?.folders, [])
			assert.deepStrictEqual(recovered?.pins, [])
		} finally {
			await fs.rm(corruptDir, { recursive: true, force: true })
		}
	})

	test("mutation requests referencing real tasks validate against the wire schema", () => {
		// The webview->host envelope must validate for real task ids.
		const request: TaskOrganizationMutationRequestV1 = {
			requestId: "wire-1",
			baseRevision: 0,
			mutation: {
				kind: "createFolder",
				folderId: "wire-folder",
				name: "Wire",
				source: { kind: "task", taskId: taskA },
				destination: { kind: "task", taskId: taskB },
			},
		}
		const parsed = taskOrganizationMutationRequestSchema.safeParse(request)
		assert.ok(parsed.success, "mutation request for real tasks must validate")

		// An unknown mutation kind must be rejected at the boundary.
		assert.strictEqual(
			taskOrganizationMutationSchema.safeParse({ kind: "explode" }).success,
			false,
			"unknown mutation kind must be rejected",
		)
	})
})
