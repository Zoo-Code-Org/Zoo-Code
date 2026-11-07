import { describe, expect, it, vi } from "vitest"

import { providerIdentifiers, type ClineMessage } from "@roo-code/types"

vi.mock("get-folder-size", () => ({ default: { loose: vi.fn(async () => 1234) } }))
vi.mock("../../../utils/storage", () => ({ getTaskDirectoryPath: vi.fn(async () => "/tmp/task") }))
vi.mock("../../../i18n", () => ({ t: (k: string) => k }))

import { taskMetadata } from "../taskMetadata"

const say = (say: ClineMessage["say"], text: string, ts: number): ClineMessage => ({ ts, type: "say", say, text })

const base = {
	taskId: "t1",
	taskNumber: 1,
	globalStoragePath: "/tmp",
	workspace: "/ws",
}

describe("taskMetadata – usageByModel", () => {
	it("records per provider+model usage on the history item", async () => {
		const messages = [
			say("text", "do the thing", 1),
			say(
				"api_req_started",
				JSON.stringify({
					apiProvider: providerIdentifiers.githubCopilot,
					modelId: "claude-opus-5.5",
					tokensIn: 900,
					tokensOut: 90,
					cost: 0,
				}),
				2,
			),
			say(
				"api_req_started",
				JSON.stringify({
					apiProvider: providerIdentifiers.gemini,
					modelId: "gemini-pro",
					tokensIn: 100,
					tokensOut: 10,
					cost: 0.2,
				}),
				3,
			),
		]
		const { historyItem } = await taskMetadata({ ...base, messages })

		expect(historyItem.usageByModel).toEqual([
			{
				apiProvider: providerIdentifiers.githubCopilot,
				modelId: "claude-opus-5.5",
				requests: 1,
				tokensIn: 900,
				tokensOut: 90,
				cost: 0,
			},
			{
				apiProvider: providerIdentifiers.gemini,
				modelId: "gemini-pro",
				requests: 1,
				tokensIn: 100,
				tokensOut: 10,
				cost: 0.2,
			},
		])
		// Existing totals are unchanged by the new breakdown.
		expect(historyItem.tokensIn).toBe(1000)
		expect(historyItem.totalCost).toBeCloseTo(0.2)
	})

	it("leaves usageByModel undefined when nothing was recorded, so a stored breakdown is cleared", async () => {
		const { historyItem } = await taskMetadata({ ...base, messages: [say("text", "hello", 1)] })
		expect(historyItem).toHaveProperty("usageByModel", undefined)
		// Nothing is written for it: the stored shape of older tasks is unchanged.
		expect(JSON.parse(JSON.stringify(historyItem))).not.toHaveProperty("usageByModel")
	})

	it("leaves usageByModel undefined for a task with no messages", async () => {
		const { historyItem } = await taskMetadata({ ...base, messages: [] })
		expect(historyItem).toHaveProperty("usageByModel", undefined)
		expect(historyItem.tokensIn).toBe(0)
	})
})
