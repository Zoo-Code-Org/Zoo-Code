import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { HistoryItem } from "@roo-code/types"

import { collectPersistenceDiagnostics } from "../persistence"

describe("collectPersistenceDiagnostics", () => {
	let storagePath: string

	beforeEach(async () => {
		storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-diagnostics-test-"))
	})

	afterEach(async () => {
		await fs.rm(storagePath, { recursive: true, force: true })
	})

	it("inspects task files structurally without returning content", async () => {
		const history: HistoryItem[] = [
			{
				id: "raw-parent-id",
				number: 1,
				ts: 10,
				task: "PRIVATE TASK TITLE",
				tokensIn: 1,
				tokensOut: 1,
				totalCost: 0,
				status: "delegated",
				childIds: ["raw-child-id"],
				awaitingChildId: "raw-child-id",
			},
			{
				id: "raw-child-id",
				parentTaskId: "raw-parent-id",
				number: 2,
				ts: 20,
				task: "SECRET CHILD TITLE",
				tokensIn: 2,
				tokensOut: 2,
				totalCost: 0,
				status: "active",
			},
		]
		const tasksPath = path.join(storagePath, "tasks")
		await fs.mkdir(path.join(tasksPath, "raw-child-id"), { recursive: true })
		await fs.writeFile(path.join(tasksPath, "_index.json"), JSON.stringify({ version: 1, entries: history }))
		await fs.writeFile(path.join(tasksPath, "raw-child-id", "history_item.json"), JSON.stringify(history[1]))
		await fs.writeFile(
			path.join(tasksPath, "raw-child-id", "ui_messages.json"),
			JSON.stringify([
				{ ts: 100, text: "PRIVATE PROMPT" },
				{ ts: 200, text: "PRIVATE RESPONSE" },
			]),
		)

		const result = await collectPersistenceDiagnostics({
			storagePath,
			history,
			currentTaskIds: ["raw-child-id"],
			pseudonymize: (value) => `hashed-${value === "raw-child-id" ? "child" : "parent"}`,
		})

		expect(result.index).toMatchObject({ parseStatus: "valid", version: 1, entryCount: 2 })
		expect(result.tasks.find((task) => task.id === "hashed-child")?.uiMessages).toMatchObject({
			parseStatus: "valid",
			messageCount: 2,
			firstTimestamp: 100,
			lastTimestamp: 200,
		})
		const serialized = JSON.stringify(result)
		expect(serialized).not.toContain("PRIVATE")
		expect(serialized).not.toContain("raw-child-id")
	})

	it("reports corrupt and missing files without throwing", async () => {
		const history: HistoryItem[] = [
			{
				id: "task-1",
				number: 1,
				ts: 10,
				task: "not reported",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
			},
		]
		const taskPath = path.join(storagePath, "tasks", "task-1")
		await fs.mkdir(taskPath, { recursive: true })
		await fs.writeFile(path.join(taskPath, "ui_messages.json"), "not json")

		const result = await collectPersistenceDiagnostics({
			storagePath,
			history,
			currentTaskIds: ["task-1"],
			pseudonymize: () => "task-hash",
		})

		expect(result.index.exists).toBe(false)
		expect(result.tasks[0].historyItem.exists).toBe(false)
		expect(result.tasks[0].uiMessages.parseStatus).toBe("invalid")
	})

	it("reports cycles in parent relationships", async () => {
		const history: HistoryItem[] = [
			{
				id: "task-1",
				parentTaskId: "task-2",
				number: 1,
				ts: 10,
				task: "not reported",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
			},
			{
				id: "task-2",
				parentTaskId: "task-1",
				number: 2,
				ts: 20,
				task: "not reported",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
			},
		]

		const result = await collectPersistenceDiagnostics({
			storagePath,
			history,
			currentTaskIds: ["task-1"],
			pseudonymize: (value) => `hashed-${value}`,
		})

		expect(result.tasks).toHaveLength(2)
		expect(result.tasks.every((task) => task.integrityFindings.includes("parentCycle"))).toBe(true)
	})
})
