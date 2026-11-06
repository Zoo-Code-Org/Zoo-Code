// npx vitest run core/task/__tests__/session-title.spec.ts

import { providerIdentifiers, type ProviderSettings } from "@roo-code/types"

import type { CompletePromptOptions } from "../../../api"
import type { ClineProvider } from "../../webview/ClineProvider"
import {
	FALLBACK_TITLE_MAX_CHARS,
	SESSION_TITLE_TIMEOUT_MS,
	fallbackTitle,
	generateSessionTitle,
	cancelSessionTitle,
	sanitizeUserMessageForTitle,
	extractLlmTitle,
	type SessionTitleApplyResult,
} from "../session-title"

type CompletePromptCall = {
	prompt: string
	apiConfiguration: ProviderSettings
	options: CompletePromptOptions | undefined
}

type ApplyTitleCall = { taskId: string; title: string }

/**
 * The orchestration only needs the one provider method it calls. The double is
 * typed structurally and cast once at the construction site (AGENTS.md): the
 * test never reads other provider members.
 */
function createTitleProvider(
	overrides: {
		applySessionTitle?: (taskId: string, title: string) => Promise<SessionTitleApplyResult>
	} = {},
): ClineProvider {
	const provider = {
		applySessionTitle: overrides.applySessionTitle ?? (async () => "applied" as const),
	}
	return provider as unknown as ClineProvider
}

function createCompletePromptRecorder(impl: (call: CompletePromptCall) => Promise<string>): {
	fn: (config: ProviderSettings, prompt: string, options?: CompletePromptOptions) => Promise<string>
	calls: CompletePromptCall[]
} {
	const calls: CompletePromptCall[] = []
	const fn = (apiConfiguration: ProviderSettings, prompt: string, options: CompletePromptCall["options"]) => {
		const call = { prompt, apiConfiguration, options }
		calls.push(call)
		return impl(call)
	}
	return { fn, calls }
}

const testApiConfiguration: ProviderSettings = {
	apiProvider: providerIdentifiers.anthropic,
	apiModelId: "claude-3-5-sonnet-20241022",
	apiKey: "test-api-key",
}

describe("sanitizeUserMessageForTitle", () => {
	it.each([
		["plain message", "plain message"],
		["  padded  ", "padded"],
		["before <system-reminder>hidden</system-reminder> after", "before  after"],
		["<system-reminder>a</system-reminder>\n<system-reminder>b</system-reminder>real", "real"],
		["start <system-reminder>unterminated", "start"],
		["<system-reminder>only system</system-reminder>", ""],
		["a<system-reminder>x</system-reminder>b<system-reminder>y</system-reminder>c", "abc"],
		["keep </system-reminder> stray close", "keep </system-reminder> stray close"],
	])("sanitizes %j", (input, expected) => {
		expect(sanitizeUserMessageForTitle(input)).toBe(expected)
	})

	it("handles many unterminated openings in linear time", () => {
		const input = "<system-reminder>".repeat(50_000)
		const startedAt = performance.now()

		expect(sanitizeUserMessageForTitle(input)).toBe("")
		expect(performance.now() - startedAt).toBeLessThan(500)
	})
})

describe("extractLlmTitle", () => {
	it.each([
		["Fix login bug in auth flow", "Fix login bug in auth flow"],
		["Fix Title: parsing in task history", "Fix Title: parsing in task history"],
		['Fix "quoted" search terms', 'Fix "quoted" search terms'],
		['"Leading quote only', "Leading quote only"],
		['Trailing quote only"', "Trailing quote only"],
		["Title: Fix login bug", "Fix login bug"],
		["title: lowercase prefix", "lowercase prefix"],
		['"Quoted title"', "Quoted title"],
		["'Single quoted'", "Single quoted"],
		["“Curly quoted”", "Curly quoted"],
		["First line\nSecond line", "First line"],
		['Title: "Nested cleanup"', "Nested cleanup"],
	])("extracts %j", (input, expected) => {
		expect(extractLlmTitle(input)).toBe(expected)
	})

	it.each([[""], ["   "], ["\n\n"], ['""'], ["Title:"]])("returns undefined for %j", (input) => {
		expect(extractLlmTitle(input)).toBeUndefined()
	})
})

describe("fallbackTitle", () => {
	it.each([
		["\n\nsecond\nthird", "second third"],
		["Fix\nlogin   bug", "Fix login bug"],
	])("collapses whitespace in %j", (input, expected) => {
		expect(fallbackTitle(input)).toBe(expected)
	})

	it("cuts at the character limit before collapsing whitespace", () => {
		const input = "a".repeat(FALLBACK_TITLE_MAX_CHARS - 2) + " ".repeat(5) + "bcd"
		expect(fallbackTitle(input)).toBe("a".repeat(FALLBACK_TITLE_MAX_CHARS - 2))
		expect(fallbackTitle("ab" + " ".repeat(60) + "cd")).toBe("ab")
	})

	it("caps the fallback at the character limit", () => {
		const long = "a".repeat(FALLBACK_TITLE_MAX_CHARS + 10)
		expect(fallbackTitle(long)).toBe("a".repeat(FALLBACK_TITLE_MAX_CHARS))
		expect(fallbackTitle(long)).toHaveLength(FALLBACK_TITLE_MAX_CHARS)
	})

	it.each([[""], ["   \n  \t"]])("returns undefined for %j", (input) => {
		expect(fallbackTitle(input)).toBeUndefined()
	})
})

describe("generateSessionTitle", () => {
	it("applies the cleaned LLM title", async () => {
		const recorder = createCompletePromptRecorder(async () => 'Title: "Fix Login Bug"\nextra')
		const applied: ApplyTitleCall[] = []
		const provider = createTitleProvider({
			applySessionTitle: async (taskId, title) => {
				applied.push({ taskId, title })
				return "applied"
			},
		})

		await generateSessionTitle({
			provider,
			taskId: "task-1",
			userMessage: "please fix the login bug",
			apiConfiguration: testApiConfiguration,
			completePrompt: recorder.fn,
		})

		expect(recorder.calls).toHaveLength(1)
		expect(recorder.calls[0].prompt).toContain("please fix the login bug")
		expect(recorder.calls[0].prompt).toContain("Create a descriptive 5-10 word title")
		expect(recorder.calls[0].options?.taskId).toBe("task-1")
		expect(recorder.calls[0].options?.timeoutMs).toBe(SESSION_TITLE_TIMEOUT_MS)
		expect(recorder.calls[0].apiConfiguration).toBe(testApiConfiguration)
		expect(applied).toEqual([{ taskId: "task-1", title: "Fix Login Bug" }])
	})

	it("falls back to the start of the message when the LLM fails", async () => {
		const recorder = createCompletePromptRecorder(async () => {
			throw new Error("api down")
		})
		const applied: ApplyTitleCall[] = []
		const provider = createTitleProvider({
			applySessionTitle: async (taskId, title) => {
				applied.push({ taskId, title })
				return "applied"
			},
		})

		await generateSessionTitle({
			provider,
			taskId: "task-2",
			userMessage: "first line of the request\nsecond line",
			apiConfiguration: testApiConfiguration,
			completePrompt: recorder.fn,
		})

		expect(applied).toEqual([{ taskId: "task-2", title: "first line of the request second line" }])
	})

	it.each([[""], ["   "], ['""'], ["Title:"]])(
		"falls back to the message start when the LLM returns the unusable response %j",
		async (response) => {
			const recorder = createCompletePromptRecorder(async () => response)
			const applied: ApplyTitleCall[] = []
			const provider = createTitleProvider({
				applySessionTitle: async (taskId, title) => {
					applied.push({ taskId, title })
					return "applied"
				},
			})

			await generateSessionTitle({
				provider,
				taskId: "task-unusable",
				userMessage: "Short first line\nwith more text after it that goes on and on",
				apiConfiguration: testApiConfiguration,
				completePrompt: recorder.fn,
			})

			expect(applied).toEqual([{ taskId: "task-unusable", title: "Short first line with more text after it t" }])
		},
	)

	it("falls back when the LLM times out", async () => {
		vi.useFakeTimers()
		try {
			const recorder = createCompletePromptRecorder(() => new Promise<string>(() => {}))
			const applied: ApplyTitleCall[] = []
			const provider = createTitleProvider({
				applySessionTitle: async (taskId, title) => {
					applied.push({ taskId, title })
					return "applied"
				},
			})

			const generation = generateSessionTitle({
				provider,
				taskId: "task-timeout",
				userMessage: "timeout message body",
				apiConfiguration: testApiConfiguration,
				completePrompt: recorder.fn,
			})
			// Drain microtasks so the raced completion settles first.
			await vi.advanceTimersByTimeAsync(SESSION_TITLE_TIMEOUT_MS + 1)
			await generation

			expect(recorder.calls[0].options?.abortSignal?.aborted).toBe(true)
			expect(applied).toEqual([{ taskId: "task-timeout", title: "timeout message body" }])
		} finally {
			vi.useRealTimers()
		}
	})

	it.each([[""], ["   "], ["<system-reminder>only system content</system-reminder>"]])(
		"skips everything for sanitized-empty message %j",
		async (userMessage) => {
			const recorder = createCompletePromptRecorder(async () => "should not be called")
			const provider = createTitleProvider()

			await generateSessionTitle({
				provider,
				taskId: "task-skip",
				userMessage,
				apiConfiguration: testApiConfiguration,
				completePrompt: recorder.fn,
			})

			expect(recorder.calls).toHaveLength(0)
		},
	)

	it("stops immediately on conflict so a manual title always wins", async () => {
		const recorder = createCompletePromptRecorder(async () => "Generated Title")
		let applyCalls = 0
		const provider = createTitleProvider({
			applySessionTitle: async () => {
				applyCalls++
				return "conflict"
			},
		})

		await generateSessionTitle({
			provider,
			taskId: "task-conflict",
			userMessage: "some root message",
			apiConfiguration: testApiConfiguration,
			completePrompt: recorder.fn,
		})

		expect(applyCalls).toBe(1)
	})

	it("retries a failing write up to the retry cap, then gives up", async () => {
		const recorder = createCompletePromptRecorder(async () => "Generated Title")
		let applyCalls = 0
		const provider = createTitleProvider({
			applySessionTitle: async () => {
				applyCalls++
				throw new Error("disk on fire")
			},
		})

		await generateSessionTitle({
			provider,
			taskId: "task-retry",
			userMessage: "some root message",
			apiConfiguration: testApiConfiguration,
			completePrompt: recorder.fn,
		})

		// 1 initial attempt + 3 retries.
		expect(applyCalls).toBe(4)
	})

	it("recovers when a retried write succeeds", async () => {
		const recorder = createCompletePromptRecorder(async () => "Generated Title")
		let applyCalls = 0
		const provider = createTitleProvider({
			applySessionTitle: async () => {
				applyCalls++
				if (applyCalls < 3) {
					throw new Error("transient")
				}
				return "applied"
			},
		})

		await generateSessionTitle({
			provider,
			taskId: "task-retry-recover",
			userMessage: "some root message",
			apiConfiguration: testApiConfiguration,
			completePrompt: recorder.fn,
		})

		expect(applyCalls).toBe(3)
	})

	it("runs only one generation per task at a time", async () => {
		let release: (() => void) | undefined
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const recorder = createCompletePromptRecorder(async () => {
			await gate
			return "First Title"
		})
		const applied: ApplyTitleCall[] = []
		const provider = createTitleProvider({
			applySessionTitle: async (taskId, title) => {
				applied.push({ taskId, title })
				return "applied"
			},
		})

		const first = generateSessionTitle({
			provider,
			taskId: "task-dedup",
			userMessage: "root message",
			apiConfiguration: testApiConfiguration,
			completePrompt: recorder.fn,
		})
		const second = generateSessionTitle({
			provider,
			taskId: "task-dedup",
			userMessage: "root message",
			apiConfiguration: testApiConfiguration,
			completePrompt: recorder.fn,
		})
		release!()
		await Promise.all([first, second])

		expect(applied).toHaveLength(1)
		expect(applied[0].title).toBe("First Title")
	})

	it("aborts in-flight generation and does not apply title when cancelled", async () => {
		let abortSignal: AbortSignal | undefined
		let resolveCompletion!: (val: string) => void
		const completionPromise = new Promise<string>((resolve) => {
			resolveCompletion = resolve
		})
		const recorder = createCompletePromptRecorder(async ({ options }) => {
			abortSignal = options?.abortSignal
			return completionPromise
		})
		const applied: ApplyTitleCall[] = []
		const provider = createTitleProvider({
			applySessionTitle: async (taskId, title) => {
				applied.push({ taskId, title })
				return "applied"
			},
		})

		const generation = generateSessionTitle({
			provider,
			taskId: "task-cancel",
			userMessage: "User prompt to name",
			apiConfiguration: testApiConfiguration,
			completePrompt: recorder.fn,
		})

		expect(recorder.calls).toHaveLength(1)
		expect(abortSignal?.aborted).toBe(false)

		cancelSessionTitle("task-cancel")

		expect(abortSignal?.aborted).toBe(true)
		resolveCompletion("Generated title")
		await generation

		expect(applied).toHaveLength(0)
	})

	it("skips LLM completion and uses fallback title when rateLimitSeconds is set", async () => {
		const recorder = createCompletePromptRecorder(async () => "LLM Title")
		const applied: ApplyTitleCall[] = []
		const provider = createTitleProvider({
			applySessionTitle: async (taskId, title) => {
				applied.push({ taskId, title })
				return "applied"
			},
		})

		await generateSessionTitle({
			provider,
			taskId: "task-ratelimit",
			userMessage: "Fix urgent production issue in login flow",
			apiConfiguration: { ...testApiConfiguration, rateLimitSeconds: 5 },
			completePrompt: recorder.fn,
		})

		expect(recorder.calls).toHaveLength(0)
		expect(applied).toEqual([{ taskId: "task-ratelimit", title: "Fix urgent production issue in login flow" }])
	})

	it("never rejects even when everything fails", async () => {
		const provider = createTitleProvider({
			applySessionTitle: async () => {
				throw new Error("write failed")
			},
		})

		await expect(
			generateSessionTitle({
				provider,
				taskId: "task-quiet",
				userMessage: "root message",
				apiConfiguration: testApiConfiguration,
				completePrompt: async () => {
					throw new Error("llm failed")
				},
			}),
		).resolves.toBeUndefined()
	})
})
