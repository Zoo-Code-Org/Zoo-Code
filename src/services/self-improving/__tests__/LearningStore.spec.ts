import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "fs/promises"
import * as path from "path"
import os from "os"
import crypto from "crypto"

import { LearningStore } from "../LearningStore"

describe("LearningStore", () => {
	let testDir: string
	const logger = { appendLine: () => {} }

	beforeEach(async () => {
		testDir = path.join(os.tmpdir(), `learning-store-test-${crypto.randomUUID()}`)
		await fs.mkdir(testDir, { recursive: true })
	})

	afterEach(async () => {
		await fs.rm(testDir, { recursive: true, force: true })
	})

	it("should initialize with empty state when no files exist", async () => {
		const store = new LearningStore(testDir, logger)

		await store.initialize()

		expect(store.getPatterns()).toHaveLength(0)
		expect(store.getRecentEvents()).toHaveLength(0)
	})

	it("should fall back to empty state on corrupted JSON", async () => {
		const stateDir = path.join(testDir, "self-improving")
		await fs.mkdir(stateDir, { recursive: true })
		await fs.writeFile(path.join(stateDir, "state.json"), "not valid json{{{", "utf-8")

		const store = new LearningStore(testDir, logger)

		await store.initialize()

		expect(store.getPatterns()).toHaveLength(0)
		expect(store.getRecentEvents()).toHaveLength(0)
	})

	it("should load valid state correctly", async () => {
		const store = new LearningStore(testDir, logger)
		await store.initialize()

		store.addEvent({
			id: "test-event",
			signal: "TASK_SUCCESS",
			timestamp: Date.now(),
			context: {},
			outcome: { success: true },
		})

		await store.persist()

		const store2 = new LearningStore(testDir, logger)
		await store2.initialize()

		expect(store2.getRecentEvents()).toHaveLength(1)
	})

	it("does not commit state.json when earlier pattern persistence fails", async () => {
		const store = new LearningStore(testDir, logger)
		await store.initialize()

		store.addEvent({
			id: "baseline-event",
			signal: "TASK_SUCCESS",
			timestamp: 1,
			context: {},
			outcome: { success: true },
		})
		await store.persist()

		const statePath = path.join(testDir, "self-improving", "state.json")
		const baselineState = await fs.readFile(statePath, "utf-8")

		store.addPattern({
			id: "pattern-1",
			patternType: "prompt",
			state: "active",
			summary: "Pattern 1",
			confidenceScore: 0.8,
			frequency: 1,
			successRate: 1,
			firstSeenAt: 1,
			lastSeenAt: 1,
			sourceSignals: ["TASK_SUCCESS"],
			context: {},
		})
		store.addEvent({
			id: "new-event",
			signal: "TASK_SUCCESS",
			timestamp: 2,
			context: {},
			outcome: { success: true },
		})

		vi.spyOn(store as any, "persistPatternFiles").mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 50))
			throw new Error("pattern persist failed")
		})

		await store.persist()

		const stateAfterFailedPersist = await fs.readFile(statePath, "utf-8")
		expect(stateAfterFailedPersist).toBe(baselineState)
	})

	it("ignores uncommitted pattern files that are not referenced by state.json", async () => {
		const store = new LearningStore(testDir, logger)
		await store.initialize()
		await store.persist()

		const baseDir = path.join(testDir, "self-improving")
		await fs.mkdir(path.join(baseDir, "patterns"), { recursive: true })
		await fs.writeFile(
			path.join(baseDir, "patterns", "stray-pattern.json"),
			JSON.stringify({
				id: "stray-pattern",
				patternType: "prompt",
				state: "active",
				summary: "Should stay invisible until state.json commits it",
				confidenceScore: 0.9,
				frequency: 2,
				successRate: 1,
				firstSeenAt: 1,
				lastSeenAt: 1,
				sourceSignals: ["TASK_SUCCESS"],
				context: {},
			}),
			"utf-8",
		)

		const reloadedStore = new LearningStore(testDir, logger)
		await reloadedStore.initialize()

		expect(reloadedStore.getPatterns()).toEqual([])
	})

	it("should enforce max patterns bound", async () => {
		const store = new LearningStore(testDir, logger)
		await store.initialize()

		for (let i = 0; i < 120; i++) {
			store.addPattern({
				id: `pattern-${i}`,
				patternType: "prompt",
				state: "active",
				summary: `Pattern ${i}`,
				confidenceScore: i / 120,
				frequency: 1,
				successRate: 1,
				firstSeenAt: i,
				lastSeenAt: i,
				sourceSignals: ["TASK_SUCCESS"],
				context: {},
			})
		}

		await store.persist()

		expect(store.getPatterns().length).toBeLessThanOrEqual(100)
	})

	it("should enforce max events bound", async () => {
		const store = new LearningStore(testDir, logger)
		await store.initialize()

		for (let i = 0; i < 600; i++) {
			store.addEvent({
				id: `event-${i}`,
				signal: "TASK_SUCCESS",
				timestamp: Date.now(),
				context: {},
				outcome: { success: true },
			})
		}

		await store.persist()

		expect(store.getRecentEvents().length).toBeLessThanOrEqual(500)
	})
})
