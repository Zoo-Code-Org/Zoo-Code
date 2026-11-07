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
	cancelSessionTitlesForProvider,
	drainSessionTitles,
	flushPendingSessionTitle,
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
		isDisposed?: boolean
	} = {},
): ClineProvider {
	const provider = {
		applySessionTitle: overrides.applySessionTitle ?? (async () => "applied" as const),
		isDisposed: overrides.isDisposed ?? false,
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
		['"""Multiple quoted"""', "Multiple quoted"],
		["'  Spaced quotes  '", "Spaced quotes"],
		["Title: Fix login bug", "Fix login bug"],
		["title: lowercase prefix", "lowercase prefix"],
		['"Quoted title"', "Quoted title"],
		["'Single quoted'", "Single quoted"],
		["“Curly quoted”", "Curly quoted"],
		["   Title: Fix login bug", "Fix login bug"],
		["   Fix login bug\nSecond line", "Fix login bug"],
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
		["   leading space   ", "leading space"],
	])("collapses whitespace in %j", (input, expected) => {
		expect(fallbackTitle(input)).toBe(expected)
	})

	it("cuts at the character limit before collapsing whitespace", () => {
		const input = "a".repeat(FALLBACK_TITLE_MAX_CHARS - 2) + " ".repeat(5) + "bcd"
		expect(fallbackTitle(input)).toBe("a".repeat(FALLBACK_TITLE_MAX_CHARS - 2))
		expect(fallbackTitle("ab" + " ".repeat(60) + "cd")).toBe("ab")
	})

	it("slices the first 42 characters before trimming or collapsing leading whitespace", () => {
		const input = " ".repeat(40) + "ABCDEF"
		expect(fallbackTitle(input)).toBe("AB")
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

	it("strips system-reminder blocks before deriving the fallback title", async () => {
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
			taskId: "task-sanitized-fallback",
			userMessage: "<system-reminder>internal instructions</system-reminder>Please fix the login button",
			apiConfiguration: testApiConfiguration,
			completePrompt: recorder.fn,
		})

		expect(applied).toEqual([{ taskId: "task-sanitized-fallback", title: "Please fix the login button" }])
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
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
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

		// 4 attempts for LLM title + 4 attempts for fallback title = 8 total attempts.
		expect(applyCalls).toBe(8)
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining("[session-title] giving up on task task-retry after 4 write attempts:"),
			expect.any(Error),
		)
		consoleErrorSpy.mockRestore()
	})

	it("attempts the fallback title when LLM title write retries fail", async () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const recorder = createCompletePromptRecorder(async () => "A".repeat(500))
		const applied: ApplyTitleCall[] = []
		const provider = createTitleProvider({
			applySessionTitle: async (taskId, title) => {
				if (title.length > 50) {
					throw new Error("payload too large")
				}
				applied.push({ taskId, title })
				return "applied"
			},
		})

		await generateSessionTitle({
			provider,
			taskId: "task-llm-write-fail",
			userMessage: "Fix login issue with auth flow",
			apiConfiguration: testApiConfiguration,
			completePrompt: recorder.fn,
		})

		expect(applied).toEqual([{ taskId: "task-llm-write-fail", title: "Fix login issue with auth flow" }])
		consoleErrorSpy.mockRestore()
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

	it("settles promptly via abortPromise when cancelled without completion settling", async () => {
		const recorder = createCompletePromptRecorder(() => new Promise<string>(() => {}))
		const applySpy = vi.fn().mockResolvedValue("applied" as const)
		const provider = createTitleProvider({ applySessionTitle: applySpy })

		const generation = generateSessionTitle({
			provider,
			taskId: "task-abort-prompt",
			userMessage: "Fix login bug",
			apiConfiguration: testApiConfiguration,
			completePrompt: recorder.fn,
		})

		await Promise.resolve()
		cancelSessionTitle("task-abort-prompt")
		await generation

		expect(applySpy).not.toHaveBeenCalled()
	})

	it("stops silently when cancelled during write retries", async () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const recorder = createCompletePromptRecorder(async () => "Generated Title")
		let applyCalls = 0
		const provider = createTitleProvider({
			applySessionTitle: async () => {
				applyCalls++
				cancelSessionTitle("task-cancel-retry")
				throw new Error("transient failure")
			},
		})

		await generateSessionTitle({
			provider,
			taskId: "task-cancel-retry",
			userMessage: "some root message",
			apiConfiguration: testApiConfiguration,
			completePrompt: recorder.fn,
		})

		expect(applyCalls).toBe(1)
		expect(consoleErrorSpy).not.toHaveBeenCalled()
		consoleErrorSpy.mockRestore()
	})

	it("does not write the fallback title once the generation was cancelled", async () => {
		const recorder = createCompletePromptRecorder(async () => "Generated Title")
		let applyCalls = 0
		const provider = createTitleProvider({
			applySessionTitle: async () => {
				applyCalls++
				// A manual rename lands while this write is in flight and the write fails.
				cancelSessionTitle("task-cancel-before-fallback")
				throw new Error("transient failure")
			},
		})

		await generateSessionTitle({
			provider,
			taskId: "task-cancel-before-fallback",
			userMessage: "Fix login bug",
			apiConfiguration: testApiConfiguration,
			completePrompt: recorder.fn,
		})

		// The fallback write is skipped at the cancellation check instead of being attempted.
		expect(applyCalls).toBe(1)
	})

	it("stops fallback retry immediately if the generation is cancelled", async () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const recorder = createCompletePromptRecorder(async () => {
			throw new Error("LLM failed")
		})
		let applyCalls = 0
		const provider = createTitleProvider({
			applySessionTitle: async () => {
				applyCalls++
				cancelSessionTitle("task-cancel-fallback-retry")
				throw new Error("transient failure")
			},
		})

		await generateSessionTitle({
			provider,
			taskId: "task-cancel-fallback-retry",
			userMessage: "Fix login bug",
			apiConfiguration: testApiConfiguration,
			completePrompt: recorder.fn,
		})

		expect(applyCalls).toBe(1)
		expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining("LLM call failed for task task-cancel-fallback-retry"),
			expect.anything(),
		)
		consoleErrorSpy.mockRestore()
	})

	it("safely ignores cancellation for an untracked task", () => {
		expect(() => cancelSessionTitle("non-existent-task")).not.toThrow()
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

	it("sends only the user text to the model when the message carries a system reminder", async () => {
		const recorder = createCompletePromptRecorder(async () => "Login fix title")
		const applied: ApplyTitleCall[] = []
		const provider = createTitleProvider({
			applySessionTitle: async (taskId, title) => {
				applied.push({ taskId, title })
				return "applied"
			},
		})

		await generateSessionTitle({
			provider,
			taskId: "task-reminder",
			userMessage:
				"<system-reminder>Environment details: workspace /home/user/project</system-reminder>Please fix the login button",
			apiConfiguration: testApiConfiguration,
			completePrompt: recorder.fn,
		})

		expect(recorder.calls).toHaveLength(1)
		expect(recorder.calls[0].prompt).toContain("Please fix the login button")
		expect(recorder.calls[0].prompt).not.toContain("<system-reminder>")
		expect(recorder.calls[0].prompt).not.toContain("</system-reminder>")
		expect(recorder.calls[0].prompt).not.toContain("Environment details")
		expect(applied).toEqual([{ taskId: "task-reminder", title: "Login fix title" }])
	})

	it("does not start a request for a provider that is already disposed", async () => {
		const recorder = createCompletePromptRecorder(async () => "Should not be requested")
		const provider = createTitleProvider({ isDisposed: true })

		await generateSessionTitle({
			provider,
			taskId: "task-disposed-start",
			userMessage: "Fix the login bug",
			apiConfiguration: testApiConfiguration,
			completePrompt: recorder.fn,
		})

		expect(recorder.calls).toHaveLength(0)
	})

	it("cancels and drains the generation a disposing provider owns", async () => {
		let abortSignal: AbortSignal | undefined
		const recorder = createCompletePromptRecorder(async ({ options }) => {
			abortSignal = options?.abortSignal
			return new Promise<string>(() => {})
		})
		const provider = createTitleProvider()

		const generation = generateSessionTitle({
			provider,
			taskId: "task-dispose",
			userMessage: "Fix the login bug",
			apiConfiguration: testApiConfiguration,
			completePrompt: recorder.fn,
		})

		expect(abortSignal?.aborted).toBe(false)
		cancelSessionTitlesForProvider(provider)
		expect(abortSignal?.aborted).toBe(true)

		// Draining waits for the aborted generation to settle instead of leaving the write behind.
		await drainSessionTitles(provider)
		await generation
	})

	it("cancels only the disposing provider's generation", async () => {
		const signals: Record<string, AbortSignal | undefined> = {}
		const recorder = createCompletePromptRecorder(async ({ prompt, options }) => {
			signals[prompt] = options?.abortSignal
			return new Promise<string>(() => {})
		})
		const providerA = createTitleProvider()
		const providerB = createTitleProvider()

		const generationA = generateSessionTitle({
			provider: providerA,
			taskId: "task-dispose-a",
			userMessage: "message for A",
			apiConfiguration: testApiConfiguration,
			completePrompt: recorder.fn,
		})
		const generationB = generateSessionTitle({
			provider: providerB,
			taskId: "task-dispose-b",
			userMessage: "message for B",
			apiConfiguration: testApiConfiguration,
			completePrompt: recorder.fn,
		})

		cancelSessionTitlesForProvider(providerA)

		const signalForA = Object.entries(signals).find(([prompt]) => prompt.includes("message for A"))?.[1]
		const signalForB = Object.entries(signals).find(([prompt]) => prompt.includes("message for B"))?.[1]
		expect(signalForA?.aborted).toBe(true)
		expect(signalForB?.aborted).toBe(false)

		await generationA
		cancelSessionTitle("task-dispose-b")
		await generationB
	})
})

describe("flushPendingSessionTitle", () => {
	it("applies a title that was generated before the history item existed", async () => {
		const recorder = createCompletePromptRecorder(async () => "Generated Title")
		let historyItemPersisted = false
		const applied: ApplyTitleCall[] = []
		const provider = createTitleProvider({
			applySessionTitle: async (taskId, title) => {
				if (!historyItemPersisted) {
					return "not-ready"
				}
				applied.push({ taskId, title })
				return "applied"
			},
		})

		await generateSessionTitle({
			provider,
			taskId: "task-deferred",
			userMessage: "Fix the login bug",
			apiConfiguration: testApiConfiguration,
			completePrompt: recorder.fn,
		})
		expect(applied).toHaveLength(0)

		// The first write attempted before the record existed is retried until it lands.
		await flushPendingSessionTitle("task-deferred")
		expect(applied).toHaveLength(0)

		historyItemPersisted = true
		await flushPendingSessionTitle("task-deferred")

		expect(applied).toEqual([{ taskId: "task-deferred", title: "Generated Title" }])

		// The title is applied once; a later save does not repeat the write.
		await flushPendingSessionTitle("task-deferred")
		expect(applied).toHaveLength(1)
	})

	it("applies the fallback title once the history item exists", async () => {
		const recorder = createCompletePromptRecorder(async () => {
			throw new Error("api down")
		})
		let historyItemPersisted = false
		const applied: ApplyTitleCall[] = []
		const provider = createTitleProvider({
			applySessionTitle: async (taskId, title) => {
				if (!historyItemPersisted) {
					return "not-ready"
				}
				applied.push({ taskId, title })
				return "applied"
			},
		})

		await generateSessionTitle({
			provider,
			taskId: "task-deferred-fallback",
			userMessage: "Fix login bug",
			apiConfiguration: testApiConfiguration,
			completePrompt: recorder.fn,
		})

		historyItemPersisted = true
		await flushPendingSessionTitle("task-deferred-fallback")

		expect(applied).toEqual([{ taskId: "task-deferred-fallback", title: "Fix login bug" }])
	})

	it("keeps the pending title when the retry fails", async () => {
		const recorder = createCompletePromptRecorder(async () => "Generated Title")
		let attempt = 0
		const applied: ApplyTitleCall[] = []
		const provider = createTitleProvider({
			applySessionTitle: async (taskId, title) => {
				attempt++
				if (attempt === 1) {
					return "not-ready"
				}
				if (attempt === 2) {
					throw new Error("transient write failure")
				}
				applied.push({ taskId, title })
				return "applied"
			},
		})

		await generateSessionTitle({
			provider,
			taskId: "task-deferred-retry",
			userMessage: "Fix the login bug",
			apiConfiguration: testApiConfiguration,
			completePrompt: recorder.fn,
		})

		await flushPendingSessionTitle("task-deferred-retry")
		expect(applied).toHaveLength(0)

		await flushPendingSessionTitle("task-deferred-retry")
		expect(applied).toEqual([{ taskId: "task-deferred-retry", title: "Generated Title" }])
	})

	it("drops the pending title of a disposed provider", async () => {
		const recorder = createCompletePromptRecorder(async () => "Generated Title")
		const applySpy = vi.fn().mockResolvedValue("not-ready" as const)
		const provider = createTitleProvider({ applySessionTitle: applySpy })

		await generateSessionTitle({
			provider,
			taskId: "task-deferred-disposed",
			userMessage: "Fix the login bug",
			apiConfiguration: testApiConfiguration,
			completePrompt: recorder.fn,
		})

		Object.assign(provider, { isDisposed: true })
		await flushPendingSessionTitle("task-deferred-disposed")

		expect(applySpy).toHaveBeenCalledTimes(1)
	})

	it("drops the pending title when the task is cancelled", async () => {
		const recorder = createCompletePromptRecorder(async () => "Generated Title")
		let historyItemPersisted = false
		const applySpy = vi.fn().mockImplementation(async () => (historyItemPersisted ? "applied" : "not-ready"))
		const provider = createTitleProvider({ applySessionTitle: applySpy })

		await generateSessionTitle({
			provider,
			taskId: "task-deferred-cancelled",
			userMessage: "Fix the login bug",
			apiConfiguration: testApiConfiguration,
			completePrompt: recorder.fn,
		})

		cancelSessionTitle("task-deferred-cancelled")
		historyItemPersisted = true
		await flushPendingSessionTitle("task-deferred-cancelled")

		expect(applySpy).toHaveBeenCalledTimes(1)
	})

	it("does not restore a pending title when the generation is cancelled before the retry", async () => {
		const recorder = createCompletePromptRecorder(async () => "Generated Title")
		let historyItemPersisted = false
		const applySpy = vi.fn().mockImplementation(async () => {
			// The task is deleted or renamed while the write is in flight.
			cancelSessionTitle("task-not-ready-cancelled")
			return historyItemPersisted ? "applied" : "not-ready"
		})
		const provider = createTitleProvider({ applySessionTitle: applySpy })

		await generateSessionTitle({
			provider,
			taskId: "task-not-ready-cancelled",
			userMessage: "Fix the login bug",
			apiConfiguration: testApiConfiguration,
			completePrompt: recorder.fn,
		})

		// The cancelled generation must not queue a title that a later save would apply.
		historyItemPersisted = true
		await flushPendingSessionTitle("task-not-ready-cancelled")
		expect(applySpy).toHaveBeenCalledTimes(1)
	})

	it("drains a deferred title write before the store is released", async () => {
		let releaseWrite!: () => void
		const writeGate = new Promise<void>((resolve) => {
			releaseWrite = resolve
		})
		let historyItemPersisted = false
		const provider = createTitleProvider({
			applySessionTitle: async () => {
				if (!historyItemPersisted) {
					return "not-ready"
				}
				await writeGate
				return "applied"
			},
		})
		const recorder = createCompletePromptRecorder(async () => "Generated Title")

		await generateSessionTitle({
			provider,
			taskId: "task-drain-flush",
			userMessage: "Fix the login bug",
			apiConfiguration: testApiConfiguration,
			completePrompt: recorder.fn,
		})

		historyItemPersisted = true
		void flushPendingSessionTitle("task-drain-flush")

		let drained = false
		const drain = drainSessionTitles(provider).then(() => {
			drained = true
		})
		await new Promise((resolve) => setTimeout(resolve, 10))
		// The drain waits for the deferred write instead of releasing the store underneath it.
		expect(drained).toBe(false)

		releaseWrite()
		await drain
		expect(drained).toBe(true)
	})

	it("drops a settled pending title when the provider is disposed", async () => {
		const recorder = createCompletePromptRecorder(async () => "Generated Title")
		let historyItemPersisted = false
		const applySpy = vi.fn().mockImplementation(async () => (historyItemPersisted ? "applied" : "not-ready"))
		const provider = createTitleProvider({ applySessionTitle: applySpy })

		await generateSessionTitle({
			provider,
			taskId: "task-dispose-pending",
			userMessage: "Fix the login bug",
			apiConfiguration: testApiConfiguration,
			completePrompt: recorder.fn,
		})

		// The generation already finished, so only the pending entry remains for disposal to drop.
		cancelSessionTitlesForProvider(provider)
		historyItemPersisted = true
		await flushPendingSessionTitle("task-dispose-pending")

		expect(applySpy).toHaveBeenCalledTimes(1)
	})

	it("does nothing when no title is pending", async () => {
		await expect(flushPendingSessionTitle("unknown-task")).resolves.toBeUndefined()
	})
})
