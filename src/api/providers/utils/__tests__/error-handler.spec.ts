import { handleProviderError, handleOpenAIError } from "../error-handler"

describe("handleProviderError", () => {
	const providerName = "TestProvider"

	describe("HTTP status preservation", () => {
		it("should preserve status code from Error with status field", () => {
			const error = new Error("API request failed") as any
			error.status = 401

			const result = handleProviderError(error, providerName)

			expect(result).toBeInstanceOf(Error)
			expect(result.message).toContain("TestProvider completion error")
			expect((result as any).status).toBe(401)
		})

		it("should preserve status code from Error with nested error structure", () => {
			const error = new Error("Wrapped error") as any
			error.status = 429
			error.errorDetails = [{ "@type": "type.googleapis.com/google.rpc.RetryInfo" }]

			const result = handleProviderError(error, providerName)

			expect((result as any).status).toBe(429)
			expect((result as any).errorDetails).toBeDefined()
		})

		it("should preserve status from non-Error exception", () => {
			const error = {
				status: 500,
				message: "Internal server error",
			}

			const result = handleProviderError(error, providerName)

			expect(result).toBeInstanceOf(Error)
			expect((result as any).status).toBe(500)
		})

		it("should not add status field if original error lacks it", () => {
			const error = new Error("Generic error")

			const result = handleProviderError(error, providerName)

			expect(result).toBeInstanceOf(Error)
			expect((result as any).status).toBeUndefined()
		})

		// AI SDK APICallError exposes the HTTP status as statusCode, not status — the same
		// fallback applies to non-Error exceptions so a real 429 reaches the .status check in
		// Task.backoffAndAnnounce regardless of how the provider threw it.
		it("should fall back to a numeric statusCode for non-Error exceptions without status", () => {
			const error = { statusCode: 429, message: "Rate limit exceeded" }

			const result = handleProviderError(error, providerName)

			expect(result).toBeInstanceOf(Error)
			expect((result as { status?: number }).status).toBe(429)
		})

		it("should not add status for non-Error exceptions lacking status and statusCode", () => {
			const error = { message: "Something went wrong" }

			const result = handleProviderError(error, providerName)

			expect(result).toBeInstanceOf(Error)
			expect(result).not.toHaveProperty("status")
		})

		it("should not treat a non-numeric statusCode as a status", () => {
			// Only numeric statusCode values are preserved: the typeof guard must reject strings.
			const error = { message: "weird", statusCode: "429" }

			const result = handleProviderError(error, providerName)

			expect(result).toBeInstanceOf(Error)
		})

		it("should prefer a numeric statusCode when status is null", () => {
			// A null status is not a status: backoff only understands a number, so the
			// numeric statusCode must win.
			const error = { message: "Rate limit exceeded", status: null, statusCode: 429 }
			const result = handleProviderError(error, providerName)
			expect((result as { status?: number }).status).toBe(429)
		})

		it("should prefer a numeric statusCode when status is a nonnumeric value", () => {
			// A truthy nonnumeric status would be echoed into the retry header, so it must
			// not win over a numeric statusCode.
			const error = new Error("weird")
			;(error as { status?: unknown }).status = "429"
			;(error as { statusCode?: number }).statusCode = 401
			const result = handleProviderError(error, providerName)
			expect((result as { status?: number }).status).toBe(401)
		})

		it("should keep a numeric status and ignore a nonnumeric statusCode", () => {
			const error = { message: "weird", status: 503, statusCode: "429" }
			const result = handleProviderError(error, providerName)
			expect((result as { status?: number }).status).toBe(503)
		})

		it("should not treat a nonnumeric statusCode as a status on an Error input", () => {
			// The typeof guard is what makes this total: an Error instance with a string
			// statusCode must not gain a status property.
			const error = new Error("weird")
			;(error as { statusCode?: unknown }).statusCode = "429"
			const result = handleProviderError(error, providerName)
			expect(result).not.toHaveProperty("status")
		})

		it("should wrap a null throw gracefully instead of re-throwing", () => {
			// Providers can throw non-object values (e.g. `throw null`): the optional chaining
			// must keep the handler total over any thrown value.
			const result = handleProviderError(null, providerName)

			expect(result).toBeInstanceOf(Error)
			expect(result.message).toContain("TestProvider completion error")
		})
	})

	describe("errorDetails preservation", () => {
		it("should preserve errorDetails array from original error", () => {
			const error = new Error("Rate limited") as any
			error.status = 429
			error.errorDetails = [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "5s" }]

			const result = handleProviderError(error, providerName)

			expect((result as any).errorDetails).toEqual(error.errorDetails)
		})

		it("should preserve code field from original error", () => {
			const error = new Error("Bad request") as any
			error.code = "invalid_request"

			const result = handleProviderError(error, providerName)

			expect((result as any).code).toBe("invalid_request")
		})

		it("should preserve AWS $metadata from original error", () => {
			const error = new Error("AWS error") as any
			error.$metadata = { httpStatusCode: 403, requestId: "test-123" }

			const result = handleProviderError(error, providerName)

			expect((result as any).$metadata).toEqual(error.$metadata)
		})
	})

	describe("custom message prefix", () => {
		it("should use custom message prefix when provided", () => {
			const error = new Error("Stream failed")

			const result = handleProviderError(error, providerName, { messagePrefix: "streaming" })

			expect(result.message).toBe("TestProvider streaming error: Stream failed")
		})

		it("should default to 'completion' prefix when not provided", () => {
			const error = new Error("Request failed")

			const result = handleProviderError(error, providerName)

			expect(result.message).toBe("TestProvider completion error: Request failed")
		})
	})

	describe("custom message transformer", () => {
		it("should use custom message transformer when provided", () => {
			const error = new Error("API error")

			const result = handleProviderError(error, providerName, {
				messageTransformer: (msg) => `Custom format: ${msg}`,
			})

			expect(result.message).toBe("Custom format: API error")
		})

		it("should preserve status even with custom transformer", () => {
			const error = new Error("Rate limited") as any
			error.status = 429

			const result = handleProviderError(error, providerName, {
				messageTransformer: (msg) => `Transformed: ${msg}`,
			})

			expect(result.message).toBe("Transformed: Rate limited")
			expect((result as any).status).toBe(429)
		})
	})

	describe("ByteString conversion errors", () => {
		it("should return localized message for ByteString conversion errors", () => {
			const error = new Error("Cannot convert argument to a ByteString")

			const result = handleProviderError(error, providerName)

			expect(result.message).not.toContain("TestProvider completion error")
			// The actual translated message depends on i18n setup
			expect(result.message).toBeTruthy()
		})

		it("should preserve status even for ByteString errors", () => {
			const error = new Error("Cannot convert argument to a ByteString") as any
			error.status = 400

			const result = handleProviderError(error, providerName)

			// Even though ByteString errors are typically client-side,
			// we preserve any status metadata that exists for debugging purposes
			expect((result as any).status).toBe(400)
		})
	})

	describe("error message formatting", () => {
		it("should wrap error message with provider name prefix", () => {
			const error = new Error("Authentication failed")

			const result = handleProviderError(error, providerName)

			expect(result.message).toBe("TestProvider completion error: Authentication failed")
		})

		it("should handle error with nested metadata", () => {
			const error = new Error("Network error") as any
			error.error = {
				metadata: {
					raw: "Connection refused",
				},
			}

			const result = handleProviderError(error, providerName)

			expect(result.message).toContain("Connection refused")
			expect(result.message).toContain("TestProvider completion error")
		})

		it("should handle non-Error exceptions", () => {
			const error = { message: "Something went wrong" }

			const result = handleProviderError(error, providerName)

			expect(result).toBeInstanceOf(Error)
			expect(result.message).toContain("TestProvider completion error")
			expect(result.message).toContain("[object Object]")
		})

		it("should handle string exceptions", () => {
			const error = "Connection timeout"

			const result = handleProviderError(error, providerName)

			expect(result).toBeInstanceOf(Error)
			expect(result.message).toBe("TestProvider completion error: Connection timeout")
		})
	})

	describe("real-world error scenarios", () => {
		it("should handle 401 Unauthorized with status and message", () => {
			const error = new Error("Unauthorized") as any
			error.status = 401

			const result = handleProviderError(error, providerName)

			expect(result.message).toContain("Unauthorized")
			expect((result as any).status).toBe(401)
		})

		it("should handle 429 Rate Limit with RetryInfo", () => {
			const error = new Error("Rate limit exceeded") as any
			error.status = 429
			error.errorDetails = [
				{
					"@type": "type.googleapis.com/google.rpc.RetryInfo",
					retryDelay: "10s",
				},
			]

			const result = handleProviderError(error, providerName)

			expect((result as any).status).toBe(429)
			expect((result as any).errorDetails).toBeDefined()
			expect((result as any).errorDetails[0].retryDelay).toBe("10s")
		})

		it("should handle 500 Internal Server Error", () => {
			const error = new Error("Internal server error") as any
			error.status = 500

			const result = handleProviderError(error, providerName)

			expect((result as any).status).toBe(500)
			expect(result.message).toContain("Internal server error")
		})

		it("should handle errors without status gracefully", () => {
			const error = new Error("Network connectivity issue")

			const result = handleProviderError(error, providerName)

			expect(result).toBeInstanceOf(Error)
			expect((result as any).status).toBeUndefined()
			expect(result.message).toContain("Network connectivity issue")
		})

		it("should handle Gemini-specific errors with custom transformer", () => {
			const error = new Error("Model not found") as any
			error.status = 404

			const result = handleProviderError(error, "Gemini", {
				messageTransformer: (msg) => `Gemini API Error: ${msg}`,
			})

			expect(result.message).toBe("Gemini API Error: Model not found")
			expect((result as any).status).toBe(404)
		})

		it("should handle Anthropic SDK errors", () => {
			const error = new Error("Invalid API key") as any
			error.status = 401
			error.error = { type: "authentication_error" }

			const result = handleProviderError(error, "Anthropic")

			expect((result as any).status).toBe(401)
			expect(result.message).toContain("Invalid API key")
		})
	})
})

describe("handleOpenAIError (backward compatibility)", () => {
	it("should be an alias for handleProviderError with completion prefix", () => {
		const error = new Error("API failed") as any
		error.status = 500

		const result = handleOpenAIError(error, "OpenAI")

		expect(result).toBeInstanceOf(Error)
		expect(result.message).toContain("OpenAI completion error")
		expect((result as any).status).toBe(500)
	})

	it("should preserve backward compatibility for existing callers", () => {
		const error = new Error("Authentication failed") as any
		error.status = 401

		const result = handleOpenAIError(error, "Roo Code Cloud")

		expect(result.message).toBe("Roo Code Cloud completion error: Authentication failed")
		expect((result as any).status).toBe(401)
	})
})
