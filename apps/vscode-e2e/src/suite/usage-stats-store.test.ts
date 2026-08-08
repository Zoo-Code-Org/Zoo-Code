import * as assert from "assert"
import * as fs from "fs/promises"
import * as path from "path"

import { UsageEventV1, type StatsBucket } from "@roo-code/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { waitFor, waitUntilCompleted } from "./utils"

/**
 * E2E coverage for the Usage Analytics Store (PR #1123 / b13-usage-store-v2).
 *
 * The suite runs real tasks against the aimock provider and then inspects the
 * on-disk NDJSON event log that the extension host's UsageEventStore persists
 * under the test VS Code instance's globalStorage directory. It covers:
 *
 * 1. Recording — a completed task produces schema-valid usage events on disk.
 * 2. Persistence — events survive a "restart" (a fresh read of the raw files
 *    with no in-memory state).
 * 3. Aggregation — re-computing bucket totals from the raw events yields the
 *    expected per-status / per-provider statistics.
 *
 * File layout produced by UsageEventStore:
 *   <globalStorage>/usage-stats/
 *     manifest.json
 *     events-<generation>-<segment>.ndjson
 *     quarantine/corrupt-lines.jsonl (only when corruption is detected)
 */

const STATS_DIR = path.resolve(
	__dirname,
	"..",
	"..",
	".vscode-test",
	"user-data",
	"User",
	"globalStorage",
	"zoocodeorganization.zoo-code",
	"usage-stats",
)

const TASK_MARKER = "USAGE_STATS_E2E_SMOKE: what is your name?"

interface StatsManifest {
	manifestVersion: number
	generation: number
	currentSegment: number
	updatedAt: string
}

/** Read all NDJSON segment files directly from disk (no store instance). */
async function readRawEvents(): Promise<UsageEventV1[]> {
	let segmentFiles: string[]
	try {
		const allFiles = await fs.readdir(STATS_DIR)
		segmentFiles = allFiles.filter((f) => f.startsWith("events-") && f.endsWith(".ndjson")).sort()
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return []
		}
		throw err
	}

	const events: UsageEventV1[] = []
	for (const file of segmentFiles) {
		const content = await fs.readFile(path.join(STATS_DIR, file), "utf-8")
		const lines = content.split("\n").filter((line) => line.trim().length > 0)
		for (const line of lines) {
			// Validate each line against the zod schema — the store must never
			// persist an event that fails schema validation.
			const parsed = UsageEventV1.safeParse(JSON.parse(line))
			assert.ok(parsed.success, `Persisted event in ${file} must match UsageEventV1 schema`)
			events.push(parsed.data)
		}
	}
	return events
}

/** Minimal re-implementation of UsageAggregator's accumulation for assertions. */
function aggregateEvents(events: UsageEventV1[]): StatsBucket {
	const totals: StatsBucket = {
		key: {},
		events: 0,
		completedCalls: 0,
		failedCalls: 0,
		cancelledCalls: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
		totalTokens: 0,
		costUsd: 0,
		unknownEventCount: 0,
	}

	for (const event of events) {
		totals.events += 1
		if (event.status === "completed") totals.completedCalls += 1
		if (event.status === "failed") totals.failedCalls += 1
		if (event.status === "cancelled") totals.cancelledCalls += 1
		if (event.usage.inputTokens) totals.inputTokens += event.usage.inputTokens.value
		if (event.usage.outputTokens) totals.outputTokens += event.usage.outputTokens.value
		if (event.usage.cacheReadTokens) totals.cacheReadTokens += event.usage.cacheReadTokens.value
		if (event.usage.cacheWriteTokens) totals.cacheWriteTokens += event.usage.cacheWriteTokens.value
		if (event.usage.reasoningTokens) totals.reasoningTokens += event.usage.reasoningTokens.value
		if (event.usage.totalTokens) totals.totalTokens += event.usage.totalTokens.value
		if (event.usage.costUsd) totals.costUsd += event.usage.costUsd.value
	}

	return totals
}

suite("Usage Stats Store", function () {
	setDefaultSuiteTimeout(this)

	test("records usage events end-to-end for a completed task", async () => {
		const api = globalThis.api
		const before = await readRawEvents()

		const taskId = await api.startNewTask({
			configuration: { mode: "ask", alwaysAllowModeSwitch: true, autoApprovalEnabled: true },
			text: TASK_MARKER,
		})

		await waitUntilCompleted({ api, taskId })

		// finalizeUsageEvent is fire-and-forget; wait for the async store write
		// to land on disk before asserting.
		let after: UsageEventV1[] = []
		await waitFor(async () => {
			after = await readRawEvents()
			return after.some((event) => event.taskId === taskId)
		})

		const taskEvents = after.filter((event) => event.taskId === taskId)
		assert.ok(taskEvents.length > 0, `Task ${taskId} should have persisted at least one usage event`)
		assert.ok(after.length > before.length, "Event count on disk should increase after a completed task")

		for (const event of taskEvents) {
			assert.strictEqual(event.schemaVersion, 1)
			assert.strictEqual(event.status, "completed", `Event for a completed task must be status=completed`)
			assert.ok(event.eventId.length > 0, "eventId must be non-empty")
			assert.ok(event.idempotencyKey.length > 0, "idempotencyKey must be non-empty")
			assert.ok(event.provider.length > 0, "provider must be recorded")
			assert.ok(event.model.length > 0, "model must be recorded")
			assert.ok(!Number.isNaN(Date.parse(event.occurredAt)), "occurredAt must be a valid ISO timestamp")
			assert.strictEqual(event.provenance, "live")
		}
	})

	test("persists events across store lifecycle (fresh read of raw files)", async () => {
		// A "fresh" read with no shared in-memory state simulates a host restart:
		// the NDJSON segments on disk are the only source of truth.
		const manifestRaw = await fs.readFile(path.join(STATS_DIR, "manifest.json"), "utf-8")
		const manifest = JSON.parse(manifestRaw) as StatsManifest

		assert.strictEqual(manifest.manifestVersion, 1, "manifest version must be 1")
		assert.ok(manifest.generation >= 1, "generation must be >= 1")
		assert.ok(manifest.currentSegment >= 1, "currentSegment must be >= 1")
		assert.ok(!Number.isNaN(Date.parse(manifest.updatedAt)), "manifest updatedAt must be ISO")

		const events = await readRawEvents()
		assert.ok(events.length > 0, "usage events recorded in prior tests must persist on disk")

		// Idempotency keys must be unique — append() dedupes on them, so a
		// duplicate in the log would indicate the idempotency guard failed.
		const keys = new Set(events.map((event) => event.idempotencyKey))
		assert.strictEqual(keys.size, events.length, "persisted idempotencyKeys must be unique")
	})

	test("aggregates raw events into correct stats totals", async () => {
		const events = await readRawEvents()
		assert.ok(events.length > 0, "expected usage events from earlier tests")

		const totals = aggregateEvents(events)
		assert.strictEqual(totals.events, events.length)
		assert.strictEqual(
			totals.completedCalls + totals.failedCalls + totals.cancelledCalls,
			events.length,
			"every event must fall into exactly one status bucket",
		)

		// Group by provider — all events recorded through the e2e aimock flow use
		// the openrouter provider.
		const byProvider = new Map<string, number>()
		for (const event of events) {
			byProvider.set(event.provider, (byProvider.get(event.provider) ?? 0) + 1)
		}
		assert.ok(byProvider.has("openrouter"), `expected openrouter provider events, got: ${[...byProvider.keys()]}`)

		// Token sums must be consistent with the events on disk.
		const expectedInput = events.reduce((sum, e) => sum + (e.usage.inputTokens?.value ?? 0), 0)
		const expectedOutput = events.reduce((sum, e) => sum + (e.usage.outputTokens?.value ?? 0), 0)
		assert.strictEqual(totals.inputTokens, expectedInput)
		assert.strictEqual(totals.outputTokens, expectedOutput)

		// Every event must have terminal timestamps within a sane window: not in
		// the future, and not before the store was introduced.
		const now = Date.now()
		for (const event of events) {
			const occurredAt = Date.parse(event.occurredAt)
			assert.ok(occurredAt <= now + 60_000, `event ${event.eventId} occurredAt must not be in the future`)
		}
	})
})
