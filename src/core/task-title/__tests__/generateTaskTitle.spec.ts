import { providerIdentifiers, type ProviderSettings } from "@roo-code/types"

import {
	buildTitleInput,
	cleanTitle,
	fallbackTitle,
	generateTaskTitle,
	TASK_TITLE_MAX_CHARS,
	TASK_TITLE_MAX_INPUT_CHARS,
	type CompleteFn,
} from "../generateTaskTitle"

const PROMPT = "Please refactor the authentication module so that it supports refresh tokens"
const profile: ProviderSettings = { apiProvider: providerIdentifiers.anthropic }

/** Node's native AbortSignal.timeout ignores fake timers; route it through setTimeout instead. */
function useFakeAbortSignalTimeout() {
	vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
		const controller = new AbortController()
		setTimeout(() => controller.abort(new DOMException("The operation timed out", "TimeoutError")), ms)
		return controller.signal
	})
}

describe("cleanTitle", () => {
	it.each([
		["plain title", "Refactor auth module", "Refactor auth module"],
		["surrounding quotes", '"Refactor auth module"', "Refactor auth module"],
		["curly quotes", "“Refactor auth module”", "Refactor auth module"],
		["backticks", "`Refactor auth module`", "Refactor auth module"],
		["Title: prefix", "Title: Refactor auth module", "Refactor auth module"],
		["title prefix lowercase with quotes", 'title: "Refactor auth module"', "Refactor auth module"],
		["markdown heading and bold", "## **Refactor auth module**", "Refactor auth module"],
		["trailing period", "Refactor auth module.", "Refactor auth module"],
		["trailing punctuation run", "Refactor auth module?!…", "Refactor auth module"],
		["multiple lines", "\n\nRefactor auth module\nThis explains why", "Refactor auth module"],
		["closed think block", "<think>hmm\nmore</think>\nRefactor auth module", "Refactor auth module"],
		["closed thinking block", "<thinking>x</thinking>Refactor auth module", "Refactor auth module"],
		["Korean title", "인증 모듈 리팩터링.", "인증 모듈 리팩터링"],
	])("cleans %s", (_label, raw, expected) => {
		expect(cleanTitle(raw, PROMPT)).toBe(expected)
	})

	it.each([
		["empty", ""],
		["whitespace", "  \n\t "],
		["only a think block", "<think>reasoning</think>"],
		["unclosed think tag swallowing the rest", "<think>reasoning that never ends\nRefactor auth module"],
		["only quotes and punctuation", '"."'],
		["same as the prompt", PROMPT],
		["same as the prompt after whitespace normalization", `  ${PROMPT.replace(/ /g, "  ")}  `],
	])("returns undefined for %s", (_label, raw) => {
		expect(cleanTitle(raw, PROMPT)).toBeUndefined()
	})

	it("keeps text before an unclosed think tag", () => {
		expect(cleanTitle("Refactor auth module\n<think>oops", PROMPT)).toBe("Refactor auth module")
	})

	it("truncates to 50 characters without splitting surrogate pairs", () => {
		const raw = "😀".repeat(TASK_TITLE_MAX_CHARS + 10)
		const result = cleanTitle(raw, PROMPT)

		expect(Array.from(result ?? "")).toHaveLength(TASK_TITLE_MAX_CHARS)
		expect(result).toBe("😀".repeat(TASK_TITLE_MAX_CHARS))
	})
})

describe("fallbackTitle", () => {
	it.each([
		["short prompt unchanged", "Fix the login bug", "Fix the login bug"],
		["first line only", "Fix the login bug\nand also more things", "Fix the login bug"],
		["leading blank lines skipped", "\n\n  Fix   the\tlogin bug", "Fix the login bug"],
		["@mention reduced to file name", "Explain @/src/core/task/Task.ts please", "Explain Task.ts please"],
		["URL reduced to domain", "Read https://docs.example.com/guide/start?x=1 now", "Read docs.example.com now"],
		["empty", "", ""],
	])("%s", (_label, prompt, expected) => {
		expect(fallbackTitle(prompt)).toBe(expected)
	})

	it("cuts long text at a word boundary and appends an ellipsis within 42 characters", () => {
		const result = fallbackTitle("Please refactor the authentication module so that it supports refresh tokens")

		expect(result).toBe("Please refactor the authentication…")
		expect(Array.from(result).length).toBeLessThanOrEqual(42)
	})

	it("hard-cuts text without spaces without splitting surrogate pairs", () => {
		const result = fallbackTitle("😀".repeat(80))

		expect(result).toBe("😀".repeat(41) + "…")
	})

	it("keeps exactly 42 characters unchanged", () => {
		const exact = "a".repeat(42)
		expect(fallbackTitle(exact)).toBe(exact)
	})
})

describe("buildTitleInput", () => {
	it("caps the input at 1,000 characters", () => {
		expect(Array.from(buildTitleInput("x".repeat(5_000)))).toHaveLength(TASK_TITLE_MAX_INPUT_CHARS)
	})

	it("keeps only the beginning of long code blocks", () => {
		const body = Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n")
		const result = buildTitleInput(`Look at this:\n\`\`\`ts\n${body}\n\`\`\`\nthanks`)

		expect(result).toContain("line0")
		expect(result).toContain("line7")
		expect(result).not.toContain("line20")
		expect(result).toContain("thanks")
	})

	it("leaves short code blocks intact", () => {
		const text = "```ts\nconst a = 1\n```"
		expect(buildTitleInput(text)).toBe(text)
	})
})

describe("generateTaskTitle", () => {
	it("sends the TASK_TITLE prompt with a merged signal and the 15s timeout, and cleans the result", async () => {
		const complete = vi.fn<CompleteFn>().mockResolvedValue('"Refactor auth module."')

		const title = await generateTaskTitle({ profile, prompt: PROMPT, complete })

		expect(title).toBe("Refactor auth module")
		expect(complete).toHaveBeenCalledTimes(1)
		const [usedProfile, request, options] = complete.mock.calls[0]!
		expect(usedProfile).toBe(profile)
		expect(request).toContain(PROMPT)
		expect(options?.timeoutMs).toBe(15_000)
		expect(options?.abortSignal).toBeInstanceOf(AbortSignal)
		expect(options).not.toHaveProperty("taskId")
	})

	it("uses a custom TASK_TITLE support prompt", async () => {
		const complete = vi.fn<CompleteFn>().mockResolvedValue("Title")

		await generateTaskTitle({
			profile,
			prompt: PROMPT,
			customSupportPrompts: { TASK_TITLE: "CUSTOM: ${userInput}" },
			complete,
		})

		expect(complete.mock.calls[0]![1]).toBe(`CUSTOM: ${PROMPT}`)
	})

	it("returns undefined when the model output is unusable", async () => {
		const complete = vi.fn<CompleteFn>().mockResolvedValue("<think>nothing</think>")

		await expect(generateTaskTitle({ profile, prompt: PROMPT, complete })).resolves.toBeUndefined()
	})

	it("propagates provider failures", async () => {
		const complete = vi.fn<CompleteFn>().mockRejectedValue(new Error("boom"))

		await expect(generateTaskTitle({ profile, prompt: PROMPT, complete })).rejects.toThrow("boom")
	})

	it("rejects promptly when the caller aborts, even if the provider ignores the signal", async () => {
		const controller = new AbortController()
		const complete = vi.fn<CompleteFn>().mockReturnValue(new Promise<string>(() => {}))

		const pending = generateTaskTitle({ profile, prompt: PROMPT, complete, signal: controller.signal })
		controller.abort()

		await expect(pending).rejects.toMatchObject({ name: "AbortError" })
	})

	describe("timeout", () => {
		beforeEach(() => {
			vi.useFakeTimers()
			useFakeAbortSignalTimeout()
		})
		afterEach(() => {
			vi.restoreAllMocks()
			vi.useRealTimers()
		})

		it("settles when the timeout elapses even if the provider ignores the signal", async () => {
			const complete = vi.fn<CompleteFn>().mockReturnValue(new Promise<string>(() => {}))

			const pending = generateTaskTitle({ profile, prompt: PROMPT, complete, timeoutMs: 15_000 })
			const outcome = pending.then(
				() => "resolved",
				(error: Error) => error.name,
			)
			await vi.advanceTimersByTimeAsync(15_001)

			await expect(outcome).resolves.toBe("AbortError")
		})
	})
})
