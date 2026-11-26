import type { ClineMessage } from "@roo-code/types"
import { taskMetadata } from "../taskMetadata"

vi.mock("get-folder-size", () => ({ default: { loose: vi.fn().mockResolvedValue(0) } }))
vi.mock("../../../utils/storage", () => ({ getTaskDirectoryPath: vi.fn().mockResolvedValue("/metadata-test") }))

it("computes metrics without reading or joining command output bodies", async () => {
	let bodyReads = 0
	const messages: ClineMessage[] = [
		{ ts: 0, type: "say", say: "text", text: "Task" },
		{ ts: 1, type: "say", say: "api_req_started", text: '{"tokensIn":100,"tokensOut":20}' },
		{ ts: 2, type: "ask", ask: "command", text: "run script" },
		...Array.from({ length: 10_000 }, (_, i): ClineMessage => ({
			ts: i + 3,
			type: "say",
			say: "command_output",
			get text() {
				bodyReads++
				return "large output".repeat(1_000)
			},
		})),
		{ ts: 10_004, type: "say", say: "api_req_finished", text: '{"cost":0.5}' },
	]
	const { tokenUsage } = await taskMetadata({
		messages,
		taskId: "task",
		taskNumber: 1,
		globalStoragePath: "/storage",
		workspace: "/workspace",
	})
	expect(tokenUsage).toMatchObject({ totalTokensIn: 100, totalTokensOut: 20, totalCost: 0.5, contextTokens: 120 })
	expect(bodyReads).toBe(0)
})
