// npx vitest run core/task/__tests__/background-prompt-policy.spec.ts

// F-10: a background child's system prompt must be built from the child's
// effective tool policy (effectiveToolPolicy), exactly like the request's tool
// arrays, so the prompt never advertises a tool the runtime blocks. These
// tests capture the arguments Task.getSystemPrompt passes to SYSTEM_PROMPT.

import { BACKGROUND_CHILD_DISABLED_TOOLS, BACKGROUND_CHILD_EXPERIMENTS } from "../../background-subtasks/policy"
import { Task } from "../Task"

const systemPromptMock = vi.hoisted(() => ({
	capture: vi.fn((_context: unknown, ..._rest: unknown[]) => Promise.resolve("mock system prompt")),
}))

vi.mock("../../prompts/system", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../prompts/system")>()
	return { ...actual, SYSTEM_PROMPT: systemPromptMock.capture }
})

type CapturedSystemPromptArgs = {
	experiments: Record<string, boolean> | undefined
	disabledTools: string[] | undefined
}

/** Positional args of SYSTEM_PROMPT after (context, cwd, ...). */
function lastCallArgs(): CapturedSystemPromptArgs {
	const calls = systemPromptMock.capture.mock.calls
	expect(calls.length).toBeGreaterThan(0)
	const args = calls[calls.length - 1]
	// The capture mock sees the args as unknown[]; these single casts pin the
	// two SYSTEM_PROMPT parameters this spec asserts on.
	return {
		experiments: args[9] as Record<string, boolean> | undefined,
		disabledTools: args[16] as string[] | undefined,
	}
}

function buildPromptTask(isBackgroundChild: boolean) {
	const task = Object.create(Task.prototype) as Task
	task["rooIgnoreController"] = undefined
	Object.defineProperty(task, "cwd", { value: "/path/to/task-workspace" })
	task["diffStrategy"] = undefined
	task["api"] = { getModel: () => ({ id: "test-model" }) } as unknown as Task["api"]
	task["getTaskMode"] = vi.fn(async () => "code")
	const provider = {
		context: {},
		getSkillsManager: () => undefined,
	}
	// A double assertion is unavoidable here: `providerRef` is a `WeakRef<ClineProvider>`;
	// the stub provides only the members getSystemPrompt dereferences.
	task["providerRef"] = { deref: () => provider } as unknown as Task["providerRef"]
	if (isBackgroundChild) {
		Object.defineProperty(task, "isBackgroundSubtaskChild", { value: true })
		Object.defineProperty(task, "backgroundToolPolicy", {
			value: {
				disabledTools: BACKGROUND_CHILD_DISABLED_TOOLS,
				experiments: BACKGROUND_CHILD_EXPERIMENTS,
			},
		})
	} else {
		Object.defineProperty(task, "isBackgroundSubtaskChild", { value: false })
	}
	return task
}

describe("getSystemPrompt folds the background child's tool policy (F-10)", () => {
	beforeEach(() => {
		systemPromptMock.capture.mockClear()
	})

	it("passes the child's block list and experiment overrides for a background child", async () => {
		const task = buildPromptTask(true)
		const state = { mcpEnabled: false } as Parameters<Task["getSystemPrompt"]>[0]

		await task["getSystemPrompt"](state, {
			contextWindow: 200_000,
			maxTokens: 4096,
			supportsPromptCache: true,
		})

		const { experiments, disabledTools } = lastCallArgs()
		// The prompt must not advertise tools the child can never call.
		expect(disabledTools).toEqual(expect.arrayContaining([...BACKGROUND_CHILD_DISABLED_TOOLS]))
		expect(experiments?.customTools).toBe(false)
	})

	it("unions the child's policy with the user's global disabledTools", async () => {
		const task = buildPromptTask(true)
		const state = {
			mcpEnabled: false,
			disabledTools: ["readFile"],
			experiments: { customTools: true },
		} as unknown as Parameters<Task["getSystemPrompt"]>[0]

		await task["getSystemPrompt"](state, {
			contextWindow: 200_000,
			maxTokens: 4096,
			supportsPromptCache: true,
		})

		const { experiments, disabledTools } = lastCallArgs()
		// At least as restrictive as the user's own policy, never less: both the
		// state's entry and every policy entry are present, and the policy's
		// experiment override wins on conflict.
		expect(disabledTools).toEqual(expect.arrayContaining(["readFile", "write_to_file", "execute_command"]))
		expect(disabledTools?.indexOf("readFile")).toBeLessThan(disabledTools?.indexOf("write_to_file") ?? -1)
		expect(experiments?.customTools).toBe(false)
	})

	it("passes the state's own values through for a non-background task", async () => {
		const task = buildPromptTask(false)
		const state = {
			mcpEnabled: false,
			disabledTools: ["write_to_file"],
			experiments: { customTools: true },
		} as unknown as Parameters<Task["getSystemPrompt"]>[0]

		await task["getSystemPrompt"](state, {
			contextWindow: 200_000,
			maxTokens: 4096,
			supportsPromptCache: true,
		})

		const { experiments, disabledTools } = lastCallArgs()
		expect(disabledTools).toEqual(["write_to_file"])
		expect(experiments).toEqual({ customTools: true })
	})
})
