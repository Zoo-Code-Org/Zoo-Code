// cd src && npx vitest run core/task-persistence/__tests__/taskMetadata.spec.ts
//
// DTE series 2/5: taskMetadata() persists the active task-local thinking effort
// (and its provenance) on the history item via
//   ...(thinkingEffort && { thinkingEffort }),
//   ...(thinkingEffortSource && { thinkingEffortSource }),
// so that reopening the task from history restores it.
//
// These tests drive the real taskMetadata() with both truthy and falsy effort
// values so both sides of the logical-AND spread are covered.
import { describe, it, expect, vi, beforeEach } from "vitest"
import * as os from "os"
import * as path from "path"
import * as fs from "fs/promises"

import type { ClineMessage, ReasoningEffortExtended } from "@roo-code/types"

vi.mock("get-folder-size", () => ({
	__esModule: true,
	default: { loose: vi.fn().mockResolvedValue(0) },
}))
vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: vi
		.fn()
		.mockImplementation((globalStoragePath, taskId) => Promise.resolve(`${globalStoragePath}/tasks/${taskId}`)),
}))

// Import after mocks
import { taskMetadata } from "../taskMetadata"

let tmpBaseDir: string

beforeEach(async () => {
	// Unique writable temp dir as the global storage path (mirrors taskMessages.spec.ts).
	tmpBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "roo-taskmetadata-"))
})

function taskSayMessage(text: string): ClineMessage {
	return {
		ts: 1_700_000_000_000,
		type: "say",
		say: "task",
		text,
	}
}

async function runMetadata(overrides: { thinkingEffort?: ReasoningEffortExtended; thinkingEffortSource?: string }) {
	return taskMetadata({
		taskId: "task-meta-1",
		taskNumber: 7,
		messages: [taskSayMessage("Do the thing")],
		globalStoragePath: tmpBaseDir,
		workspace: "workspace",
		...overrides,
	})
}

describe("taskMetadata thinkingEffort persistence", () => {
	it("omits the effort fields from the history item when not provided", async () => {
		const { historyItem } = await runMetadata({})

		expect(historyItem.thinkingEffort).toBeUndefined()
		expect(historyItem.thinkingEffortSource).toBeUndefined()
		// The rest of the history item is still written.
		expect(historyItem.id).toBe("task-meta-1")
		expect(historyItem.task).toBe("Do the thing")
	})

	it("persists the effort and its provenance on the history item when provided", async () => {
		const { historyItem } = await runMetadata({ thinkingEffort: "low", thinkingEffortSource: "you" })

		expect(historyItem.thinkingEffort).toBe("low")
		expect(historyItem.thinkingEffortSource).toBe("you")
	})
})
