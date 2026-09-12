import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { HistoryItem } from "@roo-code/types"

import {
	ABSENT_TASK_FILE_PREIMAGE,
	INVALID_TASK_FILE_PREIMAGE,
	isValidTaskFilePreImage,
	matchesExpectedHistoryItem,
	readTaskSessionsFromStoragePath,
	taskFilePreImage,
} from "../index.js"

describe("readTaskSessionsFromStoragePath", () => {
	let tempDir: string

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-core-"))
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	it("reads sessions from _index.json and sorts by timestamp descending", async () => {
		const tasksDir = path.join(tempDir, "tasks")
		await fs.mkdir(path.join(tasksDir, "a"), { recursive: true })
		await fs.mkdir(path.join(tasksDir, "b"), { recursive: true })

		await fs.writeFile(
			path.join(tasksDir, "_index.json"),
			JSON.stringify({
				entries: [
					{ id: "a", task: "Task A", ts: 100, status: "completed" },
					{ id: "b", task: "Task B", ts: 300, mode: "code" },
					{ id: "invalid", ts: 200 },
				],
			}),
		)

		const sessions = await readTaskSessionsFromStoragePath(tempDir)

		expect(sessions).toEqual([
			{ id: "b", task: "Task B", ts: 300, mode: "code", workspace: undefined, status: undefined },
			{ id: "a", task: "Task A", ts: 100, mode: undefined, workspace: undefined, status: "completed" },
		])
	})

	it("merges missing sessions from tasks/<id>/history_item.json", async () => {
		const tasksDir = path.join(tempDir, "tasks")
		await fs.mkdir(path.join(tasksDir, "a"), { recursive: true })
		await fs.mkdir(path.join(tasksDir, "c"), { recursive: true })

		await fs.writeFile(
			path.join(tasksDir, "_index.json"),
			JSON.stringify({
				entries: [{ id: "a", task: "Task A", ts: 100 }],
			}),
		)
		await fs.writeFile(
			path.join(tasksDir, "c", "history_item.json"),
			JSON.stringify({ id: "c", task: "Task C", ts: 500, workspace: "/tmp/project" }),
		)

		const sessions = await readTaskSessionsFromStoragePath(tempDir)

		expect(sessions).toEqual([
			{ id: "c", task: "Task C", ts: 500, workspace: "/tmp/project", mode: undefined, status: undefined },
			{ id: "a", task: "Task A", ts: 100, workspace: undefined, mode: undefined, status: undefined },
		])
	})

	it("removes stale index entries that have no on-disk task directory", async () => {
		const tasksDir = path.join(tempDir, "tasks")
		await fs.mkdir(path.join(tasksDir, "live"), { recursive: true })

		await fs.writeFile(
			path.join(tasksDir, "_index.json"),
			JSON.stringify({
				entries: [
					{ id: "stale", task: "Stale Task", ts: 999 },
					{ id: "live", task: "Live Task", ts: 100 },
				],
			}),
		)

		const sessions = await readTaskSessionsFromStoragePath(tempDir)

		expect(sessions).toEqual([
			{ id: "live", task: "Live Task", ts: 100, workspace: undefined, mode: undefined, status: undefined },
		])
	})

	it("ignores malformed JSON and invalid history entries", async () => {
		const tasksDir = path.join(tempDir, "tasks")
		await fs.mkdir(path.join(tasksDir, "good"), { recursive: true })
		await fs.mkdir(path.join(tasksDir, "bad-json"), { recursive: true })
		await fs.mkdir(path.join(tasksDir, "bad-shape"), { recursive: true })

		await fs.writeFile(path.join(tasksDir, "_index.json"), "{not-valid-json")
		await fs.writeFile(
			path.join(tasksDir, "good", "history_item.json"),
			JSON.stringify({ id: "good", task: "Good Task", ts: 10, status: "active" }),
		)
		await fs.writeFile(path.join(tasksDir, "bad-json", "history_item.json"), "{oops")
		await fs.writeFile(
			path.join(tasksDir, "bad-shape", "history_item.json"),
			JSON.stringify({ id: "bad-shape", task: 123, ts: "not-a-number" }),
		)

		const sessions = await readTaskSessionsFromStoragePath(tempDir)

		expect(sessions).toEqual([
			{ id: "good", task: "Good Task", ts: 10, workspace: undefined, mode: undefined, status: "active" },
		])
	})

	it("returns an empty list when tasks directory does not exist", async () => {
		await expect(readTaskSessionsFromStoragePath(tempDir)).resolves.toEqual([])
	})
})

describe("task file pre-images", () => {
	const item: HistoryItem = {
		id: "task-1",
		number: 1,
		ts: 1,
		task: "Task",
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
	}

	it("distinguishes validated, absent, and invalid pre-images", () => {
		const valid = taskFilePreImage(item, item.id, () => true)
		expect(valid).toEqual(item)
		expect(valid).not.toBe(item)
		expect(taskFilePreImage(null, item.id, () => false)).toBe(ABSENT_TASK_FILE_PREIMAGE)
		expect(taskFilePreImage(null, item.id, () => true)).toBe(INVALID_TASK_FILE_PREIMAGE)
		expect(taskFilePreImage({ ...item, id: "other" }, item.id, () => true)).toBe(INVALID_TASK_FILE_PREIMAGE)
		expect(taskFilePreImage({ id: item.id }, item.id, () => true)).toBe(INVALID_TASK_FILE_PREIMAGE)
	})

	it("recognizes valid snapshots and expected records", () => {
		expect(isValidTaskFilePreImage(item)).toBe(true)
		expect(isValidTaskFilePreImage(ABSENT_TASK_FILE_PREIMAGE)).toBe(false)
		expect(isValidTaskFilePreImage(INVALID_TASK_FILE_PREIMAGE)).toBe(false)
		expect(matchesExpectedHistoryItem(item, [{ ...item }], (left, right) => left.id === right.id)).toBe(true)
		expect(matchesExpectedHistoryItem(item, [], (left, right) => left.id === right.id)).toBe(false)
	})
})
