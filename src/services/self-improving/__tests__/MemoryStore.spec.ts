import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { MemoryStore } from "../MemoryStore"

describe("MemoryStore", () => {
	let tempDir: string
	const logger = { appendLine: vi.fn() }

	beforeEach(async () => {
		logger.appendLine.mockReset()
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-store-"))
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	it("deduplicates persisted entries and keeps the active snapshot frozen", async () => {
		const memoryDir = path.join(tempDir, "self-improving", "memory")
		await fs.mkdir(memoryDir, { recursive: true })
		await fs.writeFile(
			path.join(memoryDir, "environment.json"),
			JSON.stringify([
				{
					id: "env-1",
					content: "Prefer semantic search first",
					source: "learning",
					createdAt: 1,
					updatedAt: 1,
				},
				{
					id: "env-2",
					content: "prefer semantic search first",
					source: "learning",
					createdAt: 2,
					updatedAt: 2,
				},
				{
					id: "env-3",
					content: "Check existing tests before edits",
					source: "learning",
					createdAt: 3,
					updatedAt: 3,
				},
			]),
			"utf8",
		)
		await fs.writeFile(
			path.join(memoryDir, "user-profile.json"),
			JSON.stringify([
				{ id: "user-1", content: "User prefers concise summaries", source: "user", createdAt: 4, updatedAt: 4 },
			]),
			"utf8",
		)

		const store = new MemoryStore(tempDir, logger)
		await store.initialize()

		expect(await store.getStats()).toEqual({ entryCount: 3, backend: "builtin" })
		await expect(store.recall(2)).resolves.toMatchObject([{ id: "user-1" }, { id: "env-3" }])
		expect(store.getSnapshotString()).toContain("Prefer semantic search first")
		expect(store.getSnapshotString()).not.toContain("prefer semantic search first")

		await store.addEnvironmentEntry("Live write should not appear until next snapshot", {
			tags: ["live"],
		})

		expect((await store.getStats()).entryCount).toBe(4)
		expect(store.getSnapshotString()).not.toContain("Live write should not appear until next snapshot")

		store.takeSnapshot()
		expect(store.getSnapshotString()).toContain("Live write should not appear until next snapshot")
	})

	it("supports duplicate rejection, substring replace/remove, and bounded persistence", async () => {
		const store = new MemoryStore(tempDir, logger)
		await store.initialize()

		await expect(store.addEnvironmentEntry("Alpha guidance")).resolves.toMatchObject({ content: "Alpha guidance" })
		await expect(store.addEnvironmentEntry("alpha guidance")).resolves.toBeNull()

		await store.addEnvironmentEntry("Beta guidance")
		await store.addUserProfileEntry("User prefers short answers")
		await store.replaceEnvironmentEntry("beta", "Gamma guidance", { tags: ["replacement"] })
		await expect(store.removeEnvironmentEntry("alpha")).resolves.toBe(true)
		await expect(store.forgetByContent("   ")).resolves.toBe(0)

		for (let index = 0; index < 55; index += 1) {
			await store.addEnvironmentEntry(`Fact ${index}`)
		}

		const persisted = JSON.parse(
			await fs.readFile(path.join(tempDir, "self-improving", "memory", "environment.json"), "utf8"),
		) as Array<{ content: string }>

		expect((await store.getStats()).entryCount).toBe(51)
		expect(persisted).toHaveLength(50)
		expect(persisted.some((entry) => entry.content === "Gamma guidance")).toBe(false)
		expect(persisted.some((entry) => entry.content === "Alpha guidance")).toBe(false)
		expect(persisted.some((entry) => entry.content === "Fact 4")).toBe(false)
		expect(persisted.some((entry) => entry.content === "Fact 5")).toBe(true)
		expect(persisted.some((entry) => entry.content === "Fact 54")).toBe(true)
		expect(store.getSnapshotContext().entries.length).toBeLessThanOrEqual(10)
	})
})
