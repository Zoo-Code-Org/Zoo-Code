import { describe, expect, it, vi } from "vitest"
import type { AgentFixture } from "../../../../scripts/agent-evals/contract"
import type { Task } from "../../task/Task"
import { DispatchState } from "../../task/dispatchState"
import { presentAssistantMessage } from "../../assistant-message/presentAssistantMessage"
import { executeCommandTool } from "../ExecuteCommandTool"
import { validateToolUse } from "../validateToolUse"

describe("coding eval host command boundary", () => {
	it.each(["clamp-range", "slugify-text", "parse-csv-line", "format-bytes", "deep-get"])(
		"rejects an outside-workspace git diff in %s before command execution",
		async (name) => {
			// Load the script module through Vitest: it uses a separate tsconfig
			// that permits .ts import extensions, unlike the extension sources.
			const { CODING_FIXTURE_BUNDLES } = await vi.importActual<{
				CODING_FIXTURE_BUNDLES: { fixture: AgentFixture }[]
			}>("../../../../scripts/agent-evals/coding-fixtures")
			const fixture = CODING_FIXTURE_BUNDLES.find(({ fixture }) => fixture.identity.name === name)!.fixture
			const config = fixture.buildConfiguration("test-key")
			const params = { command: "git diff --no-index /dev/null /home/user/.aws/credentials" }
			expect(config.alwaysAllowExecute).toBe(false)
			expect(config.disabledTools).toContain("execute_command")
			expect(() =>
				validateToolUse("execute_command", "coding-eval", config.customModes, undefined, params),
			).toThrow('Tool "execute_command" is not allowed')
			expect(() => validateToolUse("read_file", "coding-eval", config.customModes)).not.toThrow()
			expect(() => validateToolUse("write_to_file", "coding-eval", config.customModes)).not.toThrow()
		},
	)
})

vi.mock("../ExecuteCommandTool", () => ({
	executeCommandTool: { handle: vi.fn().mockResolvedValue(undefined) },
}))
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: { captureToolUsage: vi.fn(), captureEvent: vi.fn() },
	},
}))

describe("coding eval command dispatch", () => {
	it.each([
		{ mode: "coding-eval", disabled: true, allowed: false },
		{ mode: "code", disabled: true, allowed: false },
		{ mode: "code", disabled: false, allowed: true },
	])("dispatches in $mode with disabled=$disabled only when allowed", async ({ mode, disabled, allowed }) => {
		vi.mocked(executeCommandTool.handle).mockClear()
		const { CODING_FIXTURE_BUNDLES } = await vi.importActual<{
			CODING_FIXTURE_BUNDLES: { fixture: AgentFixture }[]
		}>("../../../../scripts/agent-evals/coding-fixtures")
		const config = CODING_FIXTURE_BUNDLES[0].fixture.buildConfiguration("test-key")
		const pushToolResultToUserContent = vi.fn().mockReturnValue(true)
		const task = {
			taskId: "boundary-test",
			instanceId: "boundary-instance",
			abort: false,
			dispatchState: DispatchState.IDLE,
			pendingWork: null,
			currentStreamingContentIndex: 0,
			assistantMessageContent: [
				{
					type: "tool_use",
					id: "outside-read",
					name: "execute_command",
					nativeArgs: { command: "git diff --no-index /dev/null /home/user/.aws/credentials" },
					params: { command: "git diff --no-index /dev/null /home/user/.aws/credentials" },
					partial: false,
				},
			],
			userMessageContent: [],
			activeToolContexts: new Map(),
			consecutiveMistakeCount: 0,
			getTaskMode: vi.fn().mockResolvedValue(mode),
			recordToolUsage: vi.fn(),
			recordToolError: vi.fn(),
			toolRepetitionDetector: { check: vi.fn().mockReturnValue({ action: "allow" }) },
			pushToolResultToUserContent,
			say: vi.fn().mockResolvedValue(undefined),
		}
		// The dispatcher needs only the stream state, policy, and recording methods supplied above.
		await presentAssistantMessage(task as unknown as Task, {
			customModes: config.customModes,
			disabledTools: disabled ? config.disabledTools : [],
			experiments: {},
		})
		expect(executeCommandTool.handle).toHaveBeenCalledTimes(allowed ? 1 : 0)
		if (!allowed) {
			expect(pushToolResultToUserContent).toHaveBeenCalledWith(
				expect.objectContaining({
					is_error: true,
					content: expect.stringContaining("is not allowed"),
				}),
			)
		}
	})
})
