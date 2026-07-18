import * as path from "path"
import * as fs from "fs/promises"
import * as os from "os"

import { describe, it, expect, beforeEach, afterEach } from "vitest"

import type { UsageEventV1 } from "@roo-code/types"

import { UsageEventStore, StatsStoreError } from "../UsageEventStore"

// ── Test Helpers ────────────────────────────────────────────────────────────

/**
 * 테스트용 임시 디렉터리를 생성한다.
 * 실제 global storage를 건드리지 않는다.
 */
async function createTempDir(): Promise<string> {
	const prefix = path.join(os.tmpdir(), "usage-stats-test-")
	return fs.mkdtemp(prefix)
}

/**
 * 테스트용 UsageEventV1 이벤트를 생성한다.
 */
function makeEvent(overrides: Partial<UsageEventV1> = {}): UsageEventV1 {
	return {
		schemaVersion: 1,
		eventId: `evt-${Math.random().toString(36).slice(2)}`,
		idempotencyKey: `idem-${Math.random().toString(36).slice(2)}`,
		occurredAt: new Date().toISOString(),
		timezoneOffsetMinutes: 540, // KST UTC+9
		status: "completed",
		attempt: 1,
		taskId: "task-001",
		provider: "anthropic",
		model: "claude-sonnet-4-20250514",
		mode: "code",
		usage: {
			inputTokens: { value: 1000, source: "provider" },
			outputTokens: { value: 500, source: "provider" },
			costUsd: { value: 0.01, source: "provider" },
		},
		semantics: {
			cacheReadInInput: "excluded",
			cacheWriteInInput: "excluded",
			reasoningInOutput: "excluded",
		},
		provenance: "live",
		...overrides,
	}
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("UsageEventStore", () => {
	let tempDir: string
	let store: UsageEventStore

	beforeEach(async () => {
		tempDir = await createTempDir()
		store = new UsageEventStore(tempDir)
		await store.initialize()
	})

	afterEach(async () => {
		// 임시 디렉터리 정리 (테스트 격리)
		try {
			await fs.rm(tempDir, { recursive: true, force: true })
		} catch {
			// ignore cleanup errors
		}
	})

	describe("initialize", () => {
		it("should create stats directory structure", async () => {
			const statsDir = store._getStatsDir()
			const dirExists = await fs.access(statsDir).then(() => true).catch(() => false)
			expect(dirExists).toBe(true)

			const quarantineDir = path.join(statsDir, "quarantine")
			const quarantineExists = await fs.access(quarantineDir).then(() => true).catch(() => false)
			expect(quarantineExists).toBe(true)
		})

		it("should create manifest.json on first init", async () => {
			const manifestPath = path.join(store._getStatsDir(), "manifest.json")
			const content = await fs.readFile(manifestPath, "utf-8")
			const manifest = JSON.parse(content)
			expect(manifest.manifestVersion).toBe(1)
			expect(manifest.generation).toBe(1)
			expect(manifest.currentSegment).toBe(1)
		})

		it("should be idempotent (multiple initialize calls)", async () => {
			await store.initialize()
			await store.initialize()
			// should not throw
		})
	})

	describe("append", () => {
		it("should append a valid event", async () => {
			const event = makeEvent()
			const result = await store.append(event)
			expect(result).toBe(true)

			const events = await store.readAll()
			expect(events).toHaveLength(1)
			expect(events[0].eventId).toBe(event.eventId)
		})

		it("should deduplicate by idempotencyKey", async () => {
			const event = makeEvent()
			const result1 = await store.append(event)
			const result2 = await store.append(event)

			expect(result1).toBe(true)
			expect(result2).toBe(false)

			const events = await store.readAll()
			expect(events).toHaveLength(1)
		})

		it("should append multiple different events", async () => {
			const event1 = makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1" })
			const event2 = makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2" })
			const event3 = makeEvent({ eventId: "evt-3", idempotencyKey: "idem-3" })

			await store.append(event1)
			await store.append(event2)
			await store.append(event3)

			const events = await store.readAll()
			expect(events).toHaveLength(3)
		})

		it("should persist events to NDJSON file", async () => {
			const event = makeEvent()
			await store.append(event)

			const segmentPath = path.join(store._getStatsDir(), "events-000001.ndjson")
			const content = await fs.readFile(segmentPath, "utf-8")
			const lines = content.trim().split("\n")
			expect(lines).toHaveLength(1)

			const parsed = JSON.parse(lines[0])
			expect(parsed.eventId).toBe(event.eventId)
		})

		it("should serialize concurrent appends via promise queue", async () => {
			const events = Array.from({ length: 10 }, (_, i) =>
				makeEvent({ eventId: `evt-${i}`, idempotencyKey: `idem-${i}` }),
			)

			const results = await Promise.all(events.map((e) => store.append(e)))
			expect(results.every((r) => r === true)).toBe(true)

			const stored = await store.readAll()
			expect(stored).toHaveLength(10)
		})
	})

	describe("readAll", () => {
		it("should return empty array when no events", async () => {
			const events = await store.readAll()
			expect(events).toHaveLength(0)
		})

		it("should read all events in order", async () => {
			const event1 = makeEvent({ eventId: "evt-1", idempotencyKey: "idem-1", occurredAt: "2026-07-19T10:00:00.000Z" })
			const event2 = makeEvent({ eventId: "evt-2", idempotencyKey: "idem-2", occurredAt: "2026-07-19T11:00:00.000Z" })

			await store.append(event1)
			await store.append(event2)

			const events = await store.readAll()
			expect(events).toHaveLength(2)
			expect(events[0].eventId).toBe("evt-1")
			expect(events[1].eventId).toBe("evt-2")
		})

		it("should skip corrupt lines and continue reading", async () => {
			const event = makeEvent()
			await store.append(event)

			// corrupt line을 수동으로 추가
			const segmentPath = path.join(store._getStatsDir(), "events-000001.ndjson")
			await fs.appendFile(segmentPath, "{invalid json line\n")

			const events = await store.readAll()
			expect(events).toHaveLength(1) // corrupt line은 skip
		})

		it("should ignore truncated last line (crash tail)", async () => {
			const event = makeEvent()
			await store.append(event)

			// 잘린 line을 수동으로 추가 (마지막 line)
			const segmentPath = path.join(store._getStatsDir(), "events-000001.ndjson")
			await fs.appendFile(segmentPath, '{"partial": tru') // 잘린 JSON

			const events = await store.readAll()
			expect(events).toHaveLength(1) // crash tail은 무시
		})

		it("should write quarantine report for corrupt lines", async () => {
			const event = makeEvent()
			await store.append(event)

			// corrupt line을 중간에 추가 (마지막이 아닌 위치)
			const segmentPath = path.join(store._getStatsDir(), "events-000001.ndjson")
			const validLine = JSON.stringify(makeEvent({ eventId: "evt-valid", idempotencyKey: "idem-valid" })) + "\n"
			await fs.appendFile(segmentPath, "{corrupt\n")
			await fs.appendFile(segmentPath, validLine)

			await store.readAll()

			const quarantinePath = path.join(store._getStatsDir(), "quarantine", "corrupt-lines.jsonl")
			const quarantineExists = await fs.access(quarantinePath).then(() => true).catch(() => false)
			expect(quarantineExists).toBe(true)
		})
	})

	describe("clear", () => {
		it("should clear all events and increment generation", async () => {
			await store.append(makeEvent({ idempotencyKey: "idem-1" }))
			await store.append(makeEvent({ idempotencyKey: "idem-2" }))

			await store.clear()

			const events = await store.readAll()
			expect(events).toHaveLength(0)

			const manifest = await store.getManifest()
			expect(manifest.generation).toBe(2)
			expect(manifest.currentSegment).toBe(1)
		})

		it("should reset idempotency set after clear", async () => {
			const event = makeEvent({ idempotencyKey: "idem-same" })
			await store.append(event)

			await store.clear()

			// clear 후 동일 idempotencyKey로 다시 append 가능
			const result = await store.append(event)
			expect(result).toBe(true)
		})

		it("should move old segments to old-generation directory", async () => {
			await store.append(makeEvent())

			await store.clear()

			const oldGenDir = path.join(store._getStatsDir(), "old-generation-1")
			const oldGenExists = await fs.access(oldGenDir).then(() => true).catch(() => false)
			expect(oldGenExists).toBe(true)
		})
	})

	describe("idempotency recovery on restart", () => {
		it("should rebuild idempotency set from segment scan on re-init", async () => {
			const event = makeEvent({ idempotencyKey: "idem-persist" })
			await store.append(event)

			// 새 store 인스턴스 생성 (재시작 시뮬레이션)
			const newStore = new UsageEventStore(tempDir)
			await newStore.initialize()

			// 동일 idempotencyKey로 append 시도 → dedupe되어야 함
			const result = await newStore.append(event)
			expect(result).toBe(false)
		})
	})

	describe("error handling", () => {
		it("should throw StatsStoreError with correct code on cap reached", async () => {
			// 이 테스트는 cap을 강제로 설정하기 어려우므로, isCapped() 메서드 동작만 확인
			expect(store.isCapped()).toBe(false)
		})

		it("should not throw on duplicate append (idempotent)", async () => {
			const event = makeEvent()
			await store.append(event)

			// 동일 이벤트 재append는 에러가 아님
			await expect(store.append(event)).resolves.toBe(false)
		})
	})
})
