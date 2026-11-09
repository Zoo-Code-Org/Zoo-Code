import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { ProviderSettings } from "@roo-code/types"
import { providerIdentifiers } from "@roo-code/types"

import {
	generateTaskTitle,
	cleanGeneratedTitle,
	fallbackTaskTitle,
	MAX_TITLE_LENGTH,
	MAX_INPUT_PROMPT_LENGTH,
	FALLBACK_TITLE_MAX_LENGTH,
	DEFAULT_TITLE_TIMEOUT_MS,
} from "../taskTitleGenerator"
import { singleCompletionHandler } from "../../../utils/single-completion-handler"

vi.mock("../../../utils/single-completion-handler", () => ({
	singleCompletionHandler: vi.fn(),
}))

describe("taskTitleGenerator", () => {
	const mockApiConfig: ProviderSettings = {
		apiProvider: providerIdentifiers.anthropic,
		apiKey: "test-key",
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("fallbackTaskTitle", () => {
		it("returns the first 42 characters of the prompt (issue #2333)", () => {
			expect(fallbackTaskTitle("Fix the login page button alignment issue on mobile devices")).toBe(
				"Fix the login page button alignment issue",
			)
		})

		it("truncates prompts longer than FALLBACK_TITLE_MAX_LENGTH", () => {
			const longPrompt = "x".repeat(FALLBACK_TITLE_MAX_LENGTH + 10)
			expect(fallbackTaskTitle(longPrompt)).toBe("x".repeat(FALLBACK_TITLE_MAX_LENGTH))
		})

		it("normalizes whitespace before truncating", () => {
			expect(fallbackTaskTitle("  Fix   the\n\nlogin   issue  ")).toBe("Fix the login issue")
		})

		it("keeps shorter prompts unchanged", () => {
			expect(fallbackTaskTitle("Short prompt")).toBe("Short prompt")
		})
	})

	describe("cleanGeneratedTitle", () => {
		it("normalizes whitespace and linebreaks", () => {
			const input = "  Fix   the\n\nlogin   issue  "
			expect(cleanGeneratedTitle(input)).toBe("Fix the login issue")
		})

		it("removes enclosing double quotes", () => {
			expect(cleanGeneratedTitle('"Fix login page"')).toBe("Fix login page")
		})

		it("removes enclosing single quotes and backticks", () => {
			expect(cleanGeneratedTitle("'Fix login page'")).toBe("Fix login page")
			expect(cleanGeneratedTitle("`Fix login page`")).toBe("Fix login page")
		})

		it("removes trailing punctuation (periods, exclamation marks)", () => {
			expect(cleanGeneratedTitle("Fix login page.")).toBe("Fix login page")
			expect(cleanGeneratedTitle("Fix login page!!!")).toBe("Fix login page")
			expect(cleanGeneratedTitle("Fix login page!?")).toBe("Fix login page")
		})

		it("truncates titles exceeding MAX_TITLE_LENGTH", () => {
			const longTitle = "A".repeat(MAX_TITLE_LENGTH + 20)
			const cleaned = cleanGeneratedTitle(longTitle)
			expect(cleaned.length).toBe(MAX_TITLE_LENGTH)
			expect(cleaned).toBe("A".repeat(MAX_TITLE_LENGTH))
		})
	})

	describe("generateTaskTitle", () => {
		it("returns undefined when prompt is empty or only whitespace", async () => {
			expect(await generateTaskTitle("", mockApiConfig)).toBeUndefined()
			expect(await generateTaskTitle("   \n\t  ", mockApiConfig)).toBeUndefined()
			expect(singleCompletionHandler).not.toHaveBeenCalled()
		})

		it("returns undefined when abortSignal is already aborted", async () => {
			const controller = new AbortController()
			controller.abort()

			const result = await generateTaskTitle("Do something", mockApiConfig, {
				abortSignal: controller.signal,
			})

			expect(result).toBeUndefined()
			expect(singleCompletionHandler).not.toHaveBeenCalled()
		})

		it("returns undefined when apiConfiguration is invalid or missing apiProvider", async () => {
			const invalidConfig = {} as unknown as ProviderSettings
			expect(await generateTaskTitle("Do something", invalidConfig)).toBeUndefined()
			expect(singleCompletionHandler).not.toHaveBeenCalled()
		})

		it("generates and cleans title on successful completion", async () => {
			vi.mocked(singleCompletionHandler).mockResolvedValueOnce('  "Fix Login Bug."  ')

			const result = await generateTaskTitle("Please fix the login page button bug", mockApiConfig, {
				taskId: "task-123",
			})

			expect(result).toBe("Fix Login Bug")
			expect(singleCompletionHandler).toHaveBeenCalledWith(
				mockApiConfig,
				expect.stringContaining("Please fix the login page button bug"),
				expect.objectContaining({
					taskId: "task-123",
					timeoutMs: DEFAULT_TITLE_TIMEOUT_MS,
				}),
			)

			// Issue #2333: the model request for the title is limited to 15 seconds.
			expect(DEFAULT_TITLE_TIMEOUT_MS).toBe(15000)
		})

		it("truncates prompt exceeding MAX_INPUT_PROMPT_LENGTH before sending", async () => {
			const longPrompt = "x".repeat(MAX_INPUT_PROMPT_LENGTH + 500)
			vi.mocked(singleCompletionHandler).mockResolvedValueOnce("Summary Title")

			await generateTaskTitle(longPrompt, mockApiConfig)

			const calledPrompt = vi.mocked(singleCompletionHandler).mock.calls[0]?.[1] as string
			expect(calledPrompt).toContain("x".repeat(MAX_INPUT_PROMPT_LENGTH))
			expect(calledPrompt).not.toContain("x".repeat(MAX_INPUT_PROMPT_LENGTH + 1))
		})

		it("returns undefined gracefully when singleCompletionHandler throws", async () => {
			vi.mocked(singleCompletionHandler).mockRejectedValueOnce(new Error("API rate limited"))

			const result = await generateTaskTitle("Do something", mockApiConfig)
			expect(result).toBeUndefined()
		})

		it("aborts when parent signal triggers during completion", async () => {
			const controller = new AbortController()
			vi.mocked(singleCompletionHandler).mockImplementationOnce(async (_config, _prompt, opts) => {
				controller.abort()
				if (opts?.abortSignal?.aborted) {
					throw new Error("Aborted")
				}
				return "Completed Title"
			})

			const result = await generateTaskTitle("Do something", mockApiConfig, {
				abortSignal: controller.signal,
			})

			expect(result).toBeUndefined()
		})

		it("aborts when timeout is reached", async () => {
			vi.mocked(singleCompletionHandler).mockImplementationOnce(
				(_config, _prompt, opts) =>
					new Promise((resolve, reject) => {
						opts?.abortSignal?.addEventListener("abort", () => {
							reject(new Error("Timeout aborted"))
						})
					}),
			)

			const result = await generateTaskTitle("Do something", mockApiConfig, {
				timeoutMs: 50,
			})

			expect(result).toBeUndefined()
		})

		describe("with a completion that ignores the abort signal", () => {
			beforeEach(() => {
				vi.useFakeTimers()
				vi.mocked(singleCompletionHandler).mockImplementationOnce(() => new Promise<string>(() => {}))
			})

			afterEach(() => {
				vi.useRealTimers()
			})

			it("settles with undefined once the timeout elapses", async () => {
				const result = generateTaskTitle("Do something", mockApiConfig, { timeoutMs: 1_000 })

				await vi.advanceTimersByTimeAsync(1_000)

				await expect(result).resolves.toBeUndefined()
			})

			it("settles with undefined when the parent signal aborts", async () => {
				const controller = new AbortController()
				const result = generateTaskTitle("Do something", mockApiConfig, {
					abortSignal: controller.signal,
					timeoutMs: 60_000,
				})

				await vi.advanceTimersByTimeAsync(0)
				controller.abort()

				await expect(result).resolves.toBeUndefined()
			})
		})

		it("uses a customized TASK_TITLE support prompt when one is saved", async () => {
			vi.mocked(singleCompletionHandler).mockResolvedValueOnce("Custom Title")

			await generateTaskTitle("Do something", mockApiConfig, {
				customSupportPrompts: { TASK_TITLE: "My template: ${userInput}" },
			})

			expect(vi.mocked(singleCompletionHandler).mock.calls[0]?.[1]).toBe("My template: Do something")
		})

		it("returns undefined when cleaned title is empty", async () => {
			vi.mocked(singleCompletionHandler).mockResolvedValueOnce('   ""   ')

			const result = await generateTaskTitle("Do something", mockApiConfig)
			expect(result).toBeUndefined()
		})
	})
})
