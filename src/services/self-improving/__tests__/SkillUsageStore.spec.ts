import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { SkillUsageStore } from "../SkillUsageStore"

describe("SkillUsageStore", () => {
	let tempDir: string
	const logger = { appendLine: vi.fn() }

	beforeEach(async () => {
		logger.appendLine.mockReset()
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-usage-store-"))
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	it("creates and persists telemetry sidecar records", async () => {
		const store = new SkillUsageStore(tempDir, logger)
		await store.initialize()

		const record = store.getOrCreate("skill-1", "Generated Skill", "agent")
		const persistedPath = path.join(tempDir, "self-improving", "skill-usage.json")
		const deadline = Date.now() + 1000
		let persisted: Array<{ skillId: string; skillName: string }> = []

		while (Date.now() < deadline) {
			try {
				persisted = JSON.parse(await fs.readFile(persistedPath, "utf8")) as Array<{
					skillId: string
					skillName: string
				}>
				if (persisted.some((entry) => entry.skillId === "skill-1")) {
					break
				}
			} catch {
				// Persist is async; retry until the file is ready.
			}

			await new Promise((resolve) => setTimeout(resolve, 25))
		}

		expect(record).toMatchObject({ skillId: "skill-1", skillName: "Generated Skill", createdBy: "agent" })
		expect(persisted).toContainEqual(expect.objectContaining({ skillId: "skill-1", skillName: "Generated Skill" }))
	})

	it("tracks counters, pinning, and lifecycle candidates", async () => {
		const filePath = path.join(tempDir, "self-improving", "skill-usage.json")
		await fs.mkdir(path.dirname(filePath), { recursive: true })
		await fs.writeFile(
			filePath,
			JSON.stringify([
				{
					skillId: "skill-1",
					skillName: "Dormant Skill",
					createdBy: "bundled",
					state: "active",
					pinned: false,
					viewCount: 0,
					useCount: 0,
					patchCount: 0,
					createdAt: 1,
					lastActivityAt: 1,
				},
			]),
			"utf8",
		)

		const store = new SkillUsageStore(tempDir, logger)
		await store.initialize()

		await store.bumpView("skill-1")
		await store.bumpUse("skill-1")
		await store.bumpPatch("skill-1")
		await store.pin("skill-1")
		await store.transitionState("skill-1", "stale")

		expect(store.get("skill-1")).toMatchObject({
			pinned: true,
			state: "active",
			viewCount: 1,
			useCount: 1,
			patchCount: 1,
		})

		await store.unpin("skill-1")
		await store.transitionState("skill-1", "stale")

		expect(store.getByState("stale")).toHaveLength(1)
		expect(store.getArchiveCandidates(0)).toHaveLength(1)
		expect(store.getStats()).toEqual({
			total: 1,
			active: 0,
			stale: 1,
			archived: 0,
			pinned: 0,
			agentCreated: 0,
			pinnedAgentCreated: 0,
		})
	})
})
