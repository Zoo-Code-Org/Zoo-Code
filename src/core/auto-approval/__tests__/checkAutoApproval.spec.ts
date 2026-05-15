import { checkAutoApproval } from "../index"

describe("checkAutoApproval", () => {
	it("always asks follow-up questions in YOLO mode", async () => {
		const result = await checkAutoApproval({
			state: {
				autoApprovalEnabled: true,
				yoloMode: true,
				alwaysAllowFollowupQuestions: true,
				followupAutoApproveTimeoutMs: 1000,
			},
			ask: "followup",
			text: JSON.stringify({
				suggest: [{ answer: "Continue" }],
			}),
		})

		expect(result).toEqual({ decision: "ask" })
	})

	it("approves protected writes in YOLO mode when protected writes are allowed", async () => {
		const result = await checkAutoApproval({
			state: {
				yoloMode: true,
				alwaysAllowWriteProtected: true,
			},
			ask: "tool",
			text: JSON.stringify({
				tool: "editedExistingFile",
			}),
			isProtected: true,
		})

		expect(result).toEqual({ decision: "approve" })
	})

	it("approves non-protected write tools in YOLO mode", async () => {
		const result = await checkAutoApproval({
			state: {
				yoloMode: true,
			},
			ask: "tool",
			text: JSON.stringify({
				tool: "newFileCreated",
				isOutsideWorkspace: true,
			}),
		})

		expect(result).toEqual({ decision: "approve" })
	})

	it("still asks before protected writes in YOLO mode when protected writes are not auto-approved", async () => {
		const result = await checkAutoApproval({
			state: {
				yoloMode: true,
			},
			ask: "tool",
			text: JSON.stringify({
				tool: "editedExistingFile",
			}),
			isProtected: true,
		})

		expect(result).toEqual({ decision: "ask" })
	})

	it("still denies commands that match denied prefixes in YOLO mode", async () => {
		const result = await checkAutoApproval({
			state: {
				yoloMode: true,
				deniedCommands: ["rm -rf"],
			},
			ask: "command",
			text: "rm -rf /tmp/test",
		})

		expect(result).toEqual({ decision: "deny" })
	})
})
