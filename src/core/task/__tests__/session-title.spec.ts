// pnpm --filter roo-cline test core/task/__tests__/session-title.spec.ts

import type { ApiHandler, CompletePromptOptions, SingleCompletionHandler } from "../../../api"

import {
	SESSION_TITLE_FALLBACK_LENGTH,
	SESSION_TITLE_TIMEOUT_MS,
	createSessionTitleFallback,
	generateSessionTitle,
	sanitizeGeneratedTitle,
	stripSystemReminderBlocks,
} from "../session-title"

/** A handler that only implements the single-shot completion path. */
function makeSingleShotHandler(
	impl: (prompt: string, options?: CompletePromptOptions) => Promise<string>,
): ApiHandler & SingleCompletionHandler {
	return { completePrompt: vi.fn(impl) } as unknown as ApiHandler & SingleCompletionHandler
}

/** A handler without `completePrompt`: the stream path is the only option. */
function makeStreamHandler(chunks: Array<{ type: string; text?: string }>): ApiHandler {
	async function* stream() {
		for (const chunk of chunks) {
			yield chunk as never
		}
	}
	return { createMessage: vi.fn(() => stream()) } as unknown as ApiHandler
}

describe("stripSystemReminderBlocks", () => {
	it("removes complete system-reminder blocks", () => {
		const message = "Fix the bug\n<system-reminder>some context</system-reminder>\nplease"
		expect(stripSystemReminderBlocks(message)).toBe("Fix the bug\n\nplease")
	})

	it("removes every block, not only the first", () => {
		const message = "<system-reminder>a</system-reminder>Fix it<system-reminder>b</system-reminder>"
		expect(stripSystemReminderBlocks(message)).toBe("Fix it")
	})

	it("removes an unclosed block to the end of the message", () => {
		const message = "Fix the bug\n<system-reminder>truncated paste without a closing tag"
		expect(stripSystemReminderBlocks(message)).toBe("Fix the bug\n")
	})
})

describe("createSessionTitleFallback", () => {
	it("returns the message unchanged when it is within the length limit", () => {
		expect(createSessionTitleFallback("Fix the login bug")).toBe("Fix the login bug")
		expect(createSessionTitleFallback("Fix the login bug").length).toBeLessThanOrEqual(
			SESSION_TITLE_FALLBACK_LENGTH,
		)
	})

	it("cuts the first 42 characters of a long message", () => {
		const long = "a".repeat(100)
		const title = createSessionTitleFallback(long)
		expect(title).toHaveLength(SESSION_TITLE_FALLBACK_LENGTH)
		expect(title).toBe("a".repeat(42))
	})

	it("collapses whitespace and trims the cut at a word boundary", () => {
		const title = createSessionTitleFallback(
			"hello\tworld\nthis is a long message that goes past the limit for sure",
		)
		expect(title).toBe("hello world this is a long message that go")
		expect(title).not.toMatch(/\s$/)
	})

	it("ignores system-reminder blocks when building the fallback", () => {
		const message =
			"<system-reminder>very long reminder text that alone would exceed the fallback limit anyway</system-reminder>"
		expect(createSessionTitleFallback(message)).toBe("")

		const mixed = "<system-reminder>hidden</system-reminder>Fix the login bug"
		expect(createSessionTitleFallback(mixed)).toBe("Fix the login bug")
	})
})

describe("sanitizeGeneratedTitle", () => {
	it.each([
		['"Fix the login bug"', "Fix the login bug"],
		["'Fix it'", "Fix it"],
		["**Fix it**", "Fix it"],
		["`Fix it`", "Fix it"],
		["  Fix   the bug  ", "Fix the bug"],
		["<think>reasoning</think>Fix the bug", "Fix the bug"],
	])("cleans %s to %s", (raw, expected) => {
		expect(sanitizeGeneratedTitle(raw)).toBe(expected)
	})
})

describe("generateSessionTitle", () => {
	it("returns the generated title from the single-shot path", async () => {
		const handler = makeSingleShotHandler(async () => "  Fix the login bug  ")
		const completePrompt = handler.completePrompt as ReturnType<typeof vi.fn>

		await expect(generateSessionTitle(handler, "Fix the login bug")).resolves.toBe("Fix the login bug")

		const [prompt, options] = completePrompt.mock.calls[0]
		expect(prompt).toContain("User message:")
		expect(prompt).toContain("Fix the login bug")
		expect(options?.abortSignal).toBeInstanceOf(AbortSignal)
		expect(options?.taskId).toBeUndefined()
	})

	it("passes the task id for provider-side tracking", async () => {
		const handler = makeSingleShotHandler(async () => "A title")
		await generateSessionTitle(handler, "Fix the login bug", { taskId: "task-1" })
		expect((handler.completePrompt as ReturnType<typeof vi.fn>).mock.calls[0][1]?.taskId).toBe("task-1")
	})

	it("asks for five to ten words in the language of the user", async () => {
		const handler = makeSingleShotHandler(async () => "로그인 버그 수정")
		await generateSessionTitle(handler, "로그인 버그를 수정해줘")
		const prompt = (handler.completePrompt as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
		expect(prompt).toContain("five to ten words")
		expect(prompt).toContain("language of the user message")
	})

	it("drains the createMessage stream when the provider has no single-shot path", async () => {
		const handler = makeStreamHandler([
			{ type: "text", text: "Fix " },
			{ type: "reasoning", text: "hidden" },
			{ type: "text", text: "the login bug" },
		])

		await expect(generateSessionTitle(handler, "Fix the login bug")).resolves.toBe("Fix the login bug")

		const createMessage = handler.createMessage as ReturnType<typeof vi.fn>
		const [systemPrompt, messages, metadata] = createMessage.mock.calls[0]
		expect(systemPrompt).toContain("five to ten words")
		expect(messages).toEqual([{ role: "user", content: expect.stringContaining("Fix the login bug") }])
		expect(metadata.taskId).toBe("")
		expect(metadata.abortSignal).toBeInstanceOf(AbortSignal)
	})

	it("returns the 42-character fallback when the request fails", async () => {
		const handler = makeSingleShotHandler(async () => {
			throw new Error("provider down")
		})

		const message = "This first message is long enough to be cut at the fallback length limit for sure"
		await expect(generateSessionTitle(handler, message)).resolves.toBe(createSessionTitleFallback(message))
	})

	it("returns the fallback when the model returns nothing usable", async () => {
		const handler = makeSingleShotHandler(async () => '""')
		await expect(generateSessionTitle(handler, "Fix the login bug")).resolves.toBe("Fix the login bug")
	})

	it("uses the fallback after the time limit even when the provider ignores the abort signal", async () => {
		const handler = makeSingleShotHandler((_prompt, options) => {
			// A request that never settles and never observes the signal.
			void options?.abortSignal
			return new Promise<string>(() => {})
		})

		const start = Date.now()
		await expect(generateSessionTitle(handler, "Fix the login bug", { timeoutMs: 25 })).resolves.toBe(
			"Fix the login bug",
		)
		expect(Date.now() - start).toBeLessThan(SESSION_TITLE_TIMEOUT_MS)
	})

	it("aborts the request when the external signal fires", async () => {
		const handler = makeSingleShotHandler(
			(_prompt, options) =>
				new Promise<string>((_resolve, reject) => {
					options?.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
				}),
		)
		const controller = new AbortController()

		const pending = generateSessionTitle(handler, "Fix the login bug", { signal: controller.signal })
		setTimeout(() => controller.abort(), 5)

		await expect(pending).resolves.toBe("Fix the login bug")
	})

	it("returns an empty string for an empty or reminder-only message without a request", async () => {
		const handler = makeSingleShotHandler(async () => "should not be called")

		await expect(generateSessionTitle(handler, "")).resolves.toBe("")
		await expect(generateSessionTitle(handler, "<system-reminder>only a reminder</system-reminder>")).resolves.toBe(
			"",
		)

		expect(handler.completePrompt as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
	})

	it("never throws, whatever the provider does", async () => {
		const handler = makeSingleShotHandler(async () => {
			throw new Error("boom")
		})
		await expect(generateSessionTitle(handler, "Fix the login bug")).resolves.toBeTypeOf("string")
	})

	it("keeps the default time limit at 15 seconds", () => {
		expect(SESSION_TITLE_TIMEOUT_MS).toBe(15_000)
		expect(SESSION_TITLE_FALLBACK_LENGTH).toBe(42)
	})
})
