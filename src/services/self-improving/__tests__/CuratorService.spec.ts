import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { CuratorService } from "../CuratorService"
import { SkillUsageStore } from "../SkillUsageStore"

const DAY_MS = 24 * 60 * 60 * 1000

describe("CuratorService", () => {
	let tempDir: string
	let logger: { appendLine: ReturnType<typeof vi.fn> }

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-curator-"))
		logger = { appendLine: vi.fn() }
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	async function seedSkillUsage(records: unknown[]): Promise<void> {
		const targetDir = path.join(tempDir, "self-improving")
		await fs.mkdir(targetDir, { recursive: true })
		await fs.writeFile(path.join(targetDir, "skill-usage.json"), JSON.stringify(records, null, 2), "utf-8")
	}

	it("defers the first run once before applying transitions", async () => {
		const now = Date.now()
		await seedSkillUsage([
			{
				skillId: "agent-skill",
				skillName: "Agent Skill",
				createdBy: "agent",
				state: "active",
				pinned: false,
				viewCount: 1,
				useCount: 1,
				patchCount: 0,
				createdAt: now - 30 * DAY_MS,
				lastActivityAt: now - 20 * DAY_MS,
			},
		])

		const skillUsageStore = new SkillUsageStore(tempDir, logger)
		await skillUsageStore.initialize()

		const service = new CuratorService(tempDir, skillUsageStore, logger, {
			intervalMs: 0,
			minIdleMs: 0,
			firstRunDeferred: true,
			backupsEnabled: false,
		})
		await service.initialize()

		const deferred = await service.run(now)
		expect(deferred.error).toBe("Skipped: first-run deferral")
		expect(deferred.transitions).toHaveLength(0)

		const applied = await service.run(now + 1)
		expect(applied.transitions).toHaveLength(1)
		expect(applied.transitions[0]).toMatchObject({
			skillId: "agent-skill",
			fromState: "active",
			toState: "stale",
		})
		expect(skillUsageStore.get("agent-skill")?.state).toBe("stale")
	})

	it("writes backups and reports while protecting pinned and non-agent skills", async () => {
		const now = Date.now()
		await seedSkillUsage([
			{
				skillId: "agent-skill",
				skillName: "Agent Skill",
				createdBy: "agent",
				state: "active",
				pinned: false,
				viewCount: 1,
				useCount: 1,
				patchCount: 0,
				createdAt: now - 30 * DAY_MS,
				lastActivityAt: now - 20 * DAY_MS,
			},
			{
				skillId: "user-skill",
				skillName: "User Skill",
				createdBy: "user",
				state: "active",
				pinned: false,
				viewCount: 1,
				useCount: 1,
				patchCount: 0,
				createdAt: now - 30 * DAY_MS,
				lastActivityAt: now - 20 * DAY_MS,
			},
			{
				skillId: "pinned-skill",
				skillName: "Pinned Skill",
				createdBy: "agent",
				state: "active",
				pinned: true,
				viewCount: 1,
				useCount: 1,
				patchCount: 0,
				createdAt: now - 30 * DAY_MS,
				lastActivityAt: now - 20 * DAY_MS,
			},
		])

		const skillUsageStore = new SkillUsageStore(tempDir, logger)
		await skillUsageStore.initialize()

		const service = new CuratorService(tempDir, skillUsageStore, logger, {
			intervalMs: 0,
			minIdleMs: 0,
			firstRunDeferred: false,
			backupsEnabled: true,
		})
		await service.initialize()

		const report = await service.run(now)
		expect(report.backupPath).toBeTruthy()
		expect(report.transitions).toHaveLength(1)
		expect(skillUsageStore.get("agent-skill")?.state).toBe("stale")
		expect(skillUsageStore.get("user-skill")?.state).toBe("active")
		expect(skillUsageStore.get("pinned-skill")?.state).toBe("active")

		const runDir = path.join(tempDir, "self-improving", "curator", "reports", report.runId)
		const runJson = JSON.parse(await fs.readFile(path.join(runDir, "run.json"), "utf-8"))
		const markdown = await fs.readFile(path.join(runDir, "REPORT.md"), "utf-8")
		const latest = await service.getLatestReport()

		expect(runJson.runId).toBe(report.runId)
		expect(markdown).toContain("# Curator Run Report")
		expect(latest?.runId).toBe(report.runId)
	})
})
