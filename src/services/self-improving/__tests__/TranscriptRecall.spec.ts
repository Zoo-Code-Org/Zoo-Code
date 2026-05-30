import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { TranscriptRecall } from "../TranscriptRecall"

describe("TranscriptRecall", () => {
	let tempDir: string
	let logger: { appendLine: ReturnType<typeof vi.fn> }

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-transcript-"))
		logger = { appendLine: vi.fn() }
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	it("records, persists, and searches transcript evidence", async () => {
		const recall = new TranscriptRecall(tempDir, logger)
		await recall.initialize()

		await recall.record({
			id: "entry-1",
			timestamp: 1,
			taskId: "task-1",
			mode: "code",
			summary: "Task failed while writing file",
			signal: "TASK_FAILURE",
			toolNames: ["write_to_file"],
			errorKey: "EACCES",
			success: false,
		})
		await recall.record({
			id: "entry-2",
			timestamp: 2,
			taskId: "task-2",
			mode: "code",
			summary: "Task completed after search",
			signal: "TASK_SUCCESS",
			toolNames: ["search_files"],
			success: true,
		})

		expect(recall.size).toBe(2)
		expect(recall.search("search_files")).toHaveLength(1)
		expect(recall.searchBySignal("TASK_FAILURE")).toHaveLength(1)
		expect(recall.searchByErrorKey("EACCES")).toHaveLength(1)

		const reloaded = new TranscriptRecall(tempDir, logger)
		await reloaded.initialize()
		expect(reloaded.getRecent(1)[0].id).toBe("entry-2")
	})

	it("initializes lazily when recording before initialize", async () => {
		const filePath = path.join(tempDir, "self-improving", "transcript-recall.json")
		await fs.mkdir(path.dirname(filePath), { recursive: true })
		await fs.writeFile(
			filePath,
			JSON.stringify([
				{
					id: "entry-0",
					timestamp: 0,
					summary: "Existing transcript entry",
					signal: "TASK_SUCCESS",
				},
			]),
			"utf8",
		)

		const recall = new TranscriptRecall(tempDir, logger)
		await recall.record({
			id: "entry-1",
			timestamp: 1,
			summary: "Recorded without explicit initialize",
			signal: "TASK_SUCCESS",
		})

		expect(recall.getRecent(2).map((entry) => entry.id)).toEqual(["entry-0", "entry-1"])
	})

	it("serializes concurrent lazy initialization before recording", async () => {
		const filePath = path.join(tempDir, "self-improving", "transcript-recall.json")
		await fs.mkdir(path.dirname(filePath), { recursive: true })
		await fs.writeFile(
			filePath,
			JSON.stringify([
				{
					id: "entry-0",
					timestamp: 0,
					summary: "Existing transcript entry",
					signal: "TASK_SUCCESS",
				},
			]),
			"utf8",
		)

		const recall = new TranscriptRecall(tempDir, logger)
		await Promise.all([
			recall.record({
				id: "entry-1",
				timestamp: 1,
				summary: "Concurrent record one",
				signal: "TASK_SUCCESS",
			}),
			recall.record({
				id: "entry-2",
				timestamp: 2,
				summary: "Concurrent record two",
				signal: "TASK_SUCCESS",
			}),
		])

		expect(recall.size).toBe(3)
		expect(
			recall
				.getRecent(3)
				.map((entry) => entry.id)
				.sort(),
		).toEqual(["entry-0", "entry-1", "entry-2"])
	})

	it("ignores malformed persisted entries", async () => {
		const filePath = path.join(tempDir, "self-improving", "transcript-recall.json")
		await fs.mkdir(path.dirname(filePath), { recursive: true })
		await fs.writeFile(
			filePath,
			JSON.stringify([
				{
					id: "entry-1",
					timestamp: 1,
					summary: "Valid transcript entry",
					signal: "TASK_SUCCESS",
				},
				{ id: "entry-2", timestamp: "bad", summary: 1, signal: null },
				"not-an-entry",
			]),
			"utf8",
		)

		const recall = new TranscriptRecall(tempDir, logger)
		await recall.initialize()

		expect(recall.size).toBe(1)
		expect(recall.search("valid")).toHaveLength(1)
	})

	it("clears persisted entries", async () => {
		const recall = new TranscriptRecall(tempDir, logger)
		await recall.initialize()
		await recall.record({
			id: "entry-1",
			timestamp: 1,
			summary: "Task completed",
			signal: "TASK_SUCCESS",
		})

		await recall.clear()
		expect(recall.size).toBe(0)

		const reloaded = new TranscriptRecall(tempDir, logger)
		await reloaded.initialize()
		expect(reloaded.size).toBe(0)
	})
})
