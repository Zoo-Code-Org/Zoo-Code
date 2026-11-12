import * as fs from "fs"
import * as path from "path"
import { formatEmbeddingError, sanitizeErrorMessage } from "../validation-helpers"
import { EmbeddingError } from "../indexing-errors"
import { t } from "../../../../i18n"

vi.mock("../../../../i18n", () => ({ t: vi.fn((key: string) => key) }))

describe("formatEmbeddingError", () => {
	it.each([
		[401, "permanent", "embeddings:authenticationFailed"],
		[429, "rate-limit", "embeddings:failedWithStatus"],
		[503, "server", "embeddings:failedWithStatus"],
	] as const)(
		"keeps classification and delay for HTTP %s as a single attempt",
		(status, classification, key) => {
			const cause = Object.assign(new Error("failure"), { status, headers: new Headers({ "retry-after": "2" }) })
			const error = formatEmbeddingError(cause)
			expect(error).toBeInstanceOf(EmbeddingError)
			expect(error).toMatchObject({ classification, statusCode: status, retryAfterMs: 2000, cause })
			expect(error.message).toBe(key)
			if (status !== 401) {
				expect(t).toHaveBeenLastCalledWith(key, { attempts: 1, statusCode: status, errorMessage: "failure" })
			}
		},
	)

	it("preserves connection errors with no headers", () => {
		const cause = new TypeError("fetch failed", { cause: new Error("network") })
		const error = formatEmbeddingError(cause)
		expect(error).toMatchObject({ classification: "connection", cause })
		expect(error.retryAfterMs).toBeUndefined()
		expect(t).toHaveBeenLastCalledWith("embeddings:failedWithError", { attempts: 1, errorMessage: "fetch failed" })
	})

	it("supplies every placeholder used by the failure messages in all locales", () => {
		formatEmbeddingError(Object.assign(new Error("failure"), { status: 503 }))
		const statusArgs = vi.mocked(t).mock.lastCall?.[1] ?? {}
		formatEmbeddingError(new TypeError("fetch failed"))
		const errorArgs = vi.mocked(t).mock.lastCall?.[1] ?? {}
		const localesRoot = path.resolve(__dirname, "../../../../i18n/locales")
		const locales = fs.readdirSync(localesRoot)
		expect(locales).toHaveLength(18)
		for (const locale of locales) {
			const messages: Record<string, unknown> = JSON.parse(
				fs.readFileSync(path.join(localesRoot, locale, "embeddings.json"), "utf8"),
			)
			for (const [key, args] of [
				["failedWithStatus", statusArgs],
				["failedWithError", errorArgs],
			] as const) {
				const placeholders = [...String(messages[key]).matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1])
				expect(placeholders.length, `${locale} ${key}`).toBeGreaterThan(0)
				for (const placeholder of placeholders) expect(args, `${locale} ${key}`).toHaveProperty(placeholder)
			}
		}
	})
})

describe("sanitizeErrorMessage", () => {
	it("should sanitize Unix-style file paths", () => {
		const input = "Error reading file /Users/username/projects/myapp/src/index.ts"
		const expected = "Error reading file [REDACTED_PATH]"
		expect(sanitizeErrorMessage(input)).toBe(expected)
	})

	it("should sanitize Windows-style file paths", () => {
		const input = "Cannot access C:\\Users\\username\\Documents\\project\\file.js"
		const expected = "Cannot access [REDACTED_PATH]"
		expect(sanitizeErrorMessage(input)).toBe(expected)
	})

	it("should sanitize relative file paths", () => {
		const input = "File not found: ./src/components/Button.tsx"
		const expected = "File not found: [REDACTED_PATH]"
		expect(sanitizeErrorMessage(input)).toBe(expected)

		const input2 = "Cannot read ../config/settings.json"
		const expected2 = "Cannot read [REDACTED_PATH]"
		expect(sanitizeErrorMessage(input2)).toBe(expected2)
	})

	it("should sanitize URLs with various protocols", () => {
		const input = "Failed to connect to http://localhost:11434/api/embed"
		const expected = "Failed to connect to [REDACTED_URL]"
		expect(sanitizeErrorMessage(input)).toBe(expected)

		const input2 = "Error fetching https://api.example.com:8080/v1/embeddings"
		const expected2 = "Error fetching [REDACTED_URL]"
		expect(sanitizeErrorMessage(input2)).toBe(expected2)
	})

	it("should sanitize IP addresses", () => {
		const input = "Connection refused at 192.168.1.100"
		const expected = "Connection refused at [REDACTED_IP]"
		expect(sanitizeErrorMessage(input)).toBe(expected)
	})

	it("should sanitize port numbers", () => {
		const input = "Server running on :8080 failed"
		const expected = "Server running on :[REDACTED_PORT] failed"
		expect(sanitizeErrorMessage(input)).toBe(expected)
	})

	it("should sanitize email addresses", () => {
		const input = "User john.doe@example.com not found"
		const expected = "User [REDACTED_EMAIL] not found"
		expect(sanitizeErrorMessage(input)).toBe(expected)
	})

	it("should sanitize paths in quotes", () => {
		const input = 'Cannot open file "/home/user/documents/secret.txt"'
		const expected = 'Cannot open file "[REDACTED_PATH]"'
		expect(sanitizeErrorMessage(input)).toBe(expected)
	})

	it("should handle complex error messages with multiple sensitive items", () => {
		const input = "Failed to fetch http://localhost:11434 from /Users/john/project at 192.168.1.1:3000"
		const expected = "Failed to fetch [REDACTED_URL] from [REDACTED_PATH] at [REDACTED_IP]:[REDACTED_PORT]"
		expect(sanitizeErrorMessage(input)).toBe(expected)
	})

	it.each([
		[null, "null"],
		[undefined, "undefined"],
		[123, "123"],
		[{}, "[object Object]"],
	])("handles runtime non-string input %o", (input, expected) => {
		// Exercise untyped callers without weakening the production string contract.
		const sanitizeRuntimeInput = sanitizeErrorMessage as unknown as (value: unknown) => string
		expect(sanitizeRuntimeInput(input)).toBe(expected)
	})

	it("should preserve non-sensitive error messages", () => {
		const input = "Invalid JSON format"
		expect(sanitizeErrorMessage(input)).toBe(input)

		const input2 = "Connection timeout"
		expect(sanitizeErrorMessage(input2)).toBe(input2)
	})

	it("should handle file paths with special characters", () => {
		const input = 'Error in "/path/to/file with spaces.txt"'
		const expected = 'Error in "[REDACTED_PATH]"'
		expect(sanitizeErrorMessage(input)).toBe(expected)
	})

	it("should sanitize multiple occurrences of sensitive data", () => {
		const input = "Copy from /src/file1.js to /dest/file2.js failed"
		const expected = "Copy from [REDACTED_PATH] to [REDACTED_PATH] failed"
		expect(sanitizeErrorMessage(input)).toBe(expected)
	})
})

describe("validation rate limits", () => {
	it("rethrows the original 429 before custom handling", async () => {
		const { withValidationErrorHandling } = await import("../validation-helpers")
		const error = new EmbeddingError("limited", { status: 429 }, { retryAfterMs: 61_000 })
		const handler = vi.fn()
		await expect(
			withValidationErrorHandling(
				async () => {
					throw error
				},
				"openai",
				{
					beforeStandardHandling: handler,
				},
			),
		).rejects.toBe(error)
		expect(handler).not.toHaveBeenCalled()
	})
	it("still accepts valid configuration and converts permanent failure", async () => {
		const { withValidationErrorHandling } = await import("../validation-helpers")
		await expect(withValidationErrorHandling(async () => ({ valid: true }), "openai")).resolves.toEqual({
			valid: true,
		})
		await expect(
			withValidationErrorHandling(async () => {
				throw new Error("bad key")
			}, "openai"),
		).resolves.toEqual({ valid: false, error: "bad key" })
	})
})
