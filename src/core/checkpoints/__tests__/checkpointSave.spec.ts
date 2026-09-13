import fs from "fs/promises"
import os from "os"
import path from "path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Task } from "../../task/Task"
import { journalPath } from "../changeJournal"
import { checkpointSave } from "../index"

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureCheckpointCreated: vi.fn(),
			captureCheckpointRestored: vi.fn(),
			captureCheckpointDiffed: vi.fn(),
		},
	},
}))

/**
 * Minimal Task double for the checkpointSave wiring tests. Only the members
 * touched by getCheckpointService + checkpointSave are provided: a pre-set
 * checkpointService (so no git installation happens), the provider context
 * (journal dir + setting state), and say. Structural cast at the boundary,
 * matching the documented test-double style of the tool specs.
 */
function makeTask(options: { saveCheckpoint?: unknown; state?: Record<string, unknown>; enableCheckpoints?: boolean }) {
	const say = vi.fn().mockResolvedValue(undefined)
	// An explicit `saveCheckpoint: undefined` (a checkpoint that produced no
	// commit) must be preserved as-is; only an omitted option falls back to
	// the default commit result.
	const saveCheckpoint = vi
		.fn()
		.mockResolvedValue("saveCheckpoint" in options ? options.saveCheckpoint : { commit: "sha-card-1" })
	const providerDeref = {
		context: { globalStorageUri: { fsPath: globalStorageDir } },
		getState: vi.fn().mockResolvedValue(options.state ?? {}),
	}

	const task = {
		taskId: "task-card",
		cwd: "/workspace",
		enableCheckpoints: options.enableCheckpoints ?? true,
		checkpointService: {
			saveCheckpoint,
			isInitialized: true,
		},
		providerRef: { deref: vi.fn().mockReturnValue(providerDeref) },
		say,
	} as unknown as Task

	return { task, say, saveCheckpoint }
}

let globalStorageDir: string

beforeEach(async () => {
	globalStorageDir = await fs.mkdtemp(path.join(os.tmpdir(), "b3a-save-"))
})

afterEach(async () => {
	await fs.rm(globalStorageDir, { recursive: true, force: true })
})

describe("checkpointSave change-card emission (B3a)", () => {
	it("emits a full-detail change card after a successful per-write checkpoint and still appends the journal", async () => {
		const { task, say, saveCheckpoint } = makeTask({ state: { changeCardDetail: "full" } })

		await checkpointSave(task, false, true, {
			path: "src/a.ts",
			operation: "create",
			diffStats: { additions: 2, deletions: 1 },
			diff: "+line-a\n+line-b\n-old",
		})

		expect(saveCheckpoint).toHaveBeenCalledWith(expect.stringContaining("task-card"), expect.any(Object))

		const cardCalls = say.mock.calls.filter(([type]) => type === "change_card")
		expect(cardCalls).toHaveLength(1)
		const [type, text, images, partial, sayOptions, _progress, options] = cardCalls[0] as unknown as [
			string,
			string,
			undefined,
			undefined,
			undefined,
			undefined,
			{ isNonInteractive?: boolean },
		]
		expect(type).toBe("change_card")
		expect(images).toBeUndefined()
		expect(options).toEqual({ isNonInteractive: true })
		const card = JSON.parse(text as string) as {
			checkpointIds: string[]
			files: Array<{ path: string; additions: number; deletions: number; diff?: string }>
			totalFiles: number
			detail: string
		}
		expect(card.checkpointIds).toEqual(["sha-card-1"])
		expect(card.totalFiles).toBe(1)
		expect(card.detail).toBe("full")
		expect(card.files).toEqual([{ path: "src/a.ts", additions: 2, deletions: 1, diff: "+line-a\n+line-b\n-old" }])

		// B2 regression: the journal entry is still appended with the commit id.
		const journalRaw = await fs.readFile(journalPath(globalStorageDir, "task-card"), "utf8")
		const entries = journalRaw
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line))
		expect(entries).toHaveLength(1)
		expect(entries[0]).toMatchObject({ path: "src/a.ts", operation: "create", checkpointId: "sha-card-1" })
	})

	it("emits a summary card without diffs for the default (summary) setting", async () => {
		const { task, say } = makeTask({})

		await checkpointSave(task, false, true, {
			path: "src/a.ts",
			operation: "update",
			diffStats: { additions: 1, deletions: 0 },
			diff: "+x",
		})

		const cardCall = say.mock.calls.find(([type]) => type === "change_card")
		expect(cardCall).toBeDefined()
		const card = JSON.parse((cardCall as unknown as [string, string])[1]) as {
			files: Array<Record<string, unknown>>
			detail: string
		}
		expect(card.detail).toBe("summary")
		expect(card.files[0]).not.toHaveProperty("diff")
	})

	it("emits a compact card for auto-approved steps even when the setting is full", async () => {
		const { task, say } = makeTask({ state: { changeCardDetail: "full" } })

		await checkpointSave(task, false, true, {
			path: "src/a.ts",
			operation: "create",
			diffStats: { additions: 1, deletions: 0 },
			diff: "+x",
			autoApproved: true,
		})

		const cardCall = say.mock.calls.find(([type]) => type === "change_card")
		expect(cardCall).toBeDefined()
		const card = JSON.parse((cardCall as unknown as [string, string])[1]) as {
			files: Array<Record<string, unknown>>
			detail: string
		}
		expect(card.detail).toBe("summary")
		expect(card.files[0]).not.toHaveProperty("diff")
	})

	it("emits one card with all writes for a multi-file step", async () => {
		const { task, say } = makeTask({ state: { changeCardDetail: "full" } })

		await checkpointSave(task, false, true, [
			{ path: "src/a.ts", operation: "create", diffStats: { additions: 2, deletions: 0 }, diff: "+a1\n+a2" },
			{ path: "src/b.ts", operation: "delete", diffStats: { additions: 0, deletions: 3 } },
		])

		const cardCalls = say.mock.calls.filter(([type]) => type === "change_card")
		expect(cardCalls).toHaveLength(1)
		const card = JSON.parse((cardCalls[0] as unknown as [string, string])[1]) as {
			files: Array<{ path: string; diff?: string }>
			totalFiles: number
		}
		expect(card.totalFiles).toBe(2)
		expect(card.files.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"])
		expect(card.files[0].diff).toBe("+a1\n+a2")
		expect(card.files[1]).not.toHaveProperty("diff")
	})

	it("emits no change card for baseline checkpoints without write info", async () => {
		const { task, say } = makeTask({})

		await checkpointSave(task)

		// `say` is invoked with seven arguments, so a three-argument
		// `toHaveBeenCalledWith` negative assertion can never fail; filter the
		// recorded calls by type instead.
		const cardCalls = say.mock.calls.filter(([type]) => type === "change_card")
		expect(cardCalls).toHaveLength(0)
	})

	it("emits no change card when the checkpoint produced no commit", async () => {
		const { task, say } = makeTask({ saveCheckpoint: undefined })

		await checkpointSave(task, false, true, { path: "src/a.ts", operation: "create" })

		const cardCalls = say.mock.calls.filter(([type]) => type === "change_card")
		expect(cardCalls).toHaveLength(0)
	})

	it("emits no change card when checkpoints are disabled for the task", async () => {
		const { task, say } = makeTask({ enableCheckpoints: false })

		await checkpointSave(task, false, true, { path: "src/a.ts", operation: "create", diff: "+x" })

		expect(say).not.toHaveBeenCalled()
	})

	it("keeps the journal append when a card emission failure occurs", async () => {
		const { task, say } = makeTask({})
		say.mockImplementation(async (type: string) => {
			if (type === "change_card") {
				throw new Error("task aborted")
			}
		})

		await checkpointSave(task, false, true, {
			path: "src/a.ts",
			operation: "create",
			diffStats: { additions: 1, deletions: 0 },
			diff: "+x",
		})

		// The say failure is contained: the journal is still written.
		const journalRaw = await fs.readFile(journalPath(globalStorageDir, "task-card"), "utf8")
		expect(journalRaw).toContain("src/a.ts")
	})
})
