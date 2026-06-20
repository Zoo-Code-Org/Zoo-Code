// npx vitest run src/api/providers/__tests__/vertex-credentials.spec.ts

// Mock vscode first to avoid import errors when the provider stack pulls
// transitive vscode-dependent modules during construction.
vitest.mock("vscode", () => ({
	workspace: {
		getConfiguration: () => ({
			get: (_key: string, defaultValue?: unknown) => defaultValue,
		}),
	},
}))

vitest.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureException: vitest.fn(),
		},
	},
}))

// Capture the constructor args passed to GoogleGenAI so we can assert on the
// credentials handed to GoogleAuth via googleAuthOptions.
const googleGenAICtor = vitest.fn()
vitest.mock("@google/genai", () => ({
	GoogleGenAI: vitest.fn().mockImplementation(function (args: unknown) {
		googleGenAICtor(args)
		return {
			models: {
				generateContentStream: vitest.fn(),
				generateContent: vitest.fn(),
			},
		}
	}),
	FunctionCallingConfigMode: { AUTO: "AUTO", ANY: "ANY", NONE: "NONE" },
}))

// Capture the constructor args passed to GoogleAuth (Anthropic-on-Vertex path).
const googleAuthCtor = vitest.fn()
vitest.mock("google-auth-library", () => ({
	GoogleAuth: vitest.fn().mockImplementation(function (args: unknown) {
		googleAuthCtor(args)
		return {
			/* GoogleAuth instance shape is opaque to these tests */
		}
	}),
}))

vitest.mock("@anthropic-ai/vertex-sdk", () => ({
	AnthropicVertex: vitest.fn().mockImplementation(function () {
		return {
			messages: { create: vitest.fn() },
		}
	}),
}))

import { GeminiHandler } from "../gemini"
import { VertexHandler } from "../vertex"
import { AnthropicVertexHandler } from "../anthropic-vertex"
import { parseVertexJsonCredentials } from "../utils/vertex-credentials"

const VALID_CREDS_JSON = JSON.stringify({
	type: "service_account",
	client_email: "test@example.iam.gserviceaccount.com",
	private_key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n",
})

describe("parseVertexJsonCredentials", () => {
	let warnSpy: ReturnType<typeof vi.spyOn>
	let errorSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		warnSpy = vi.spyOn(console, "warn").mockImplementation(function () {})
		errorSpy = vi.spyOn(console, "error").mockImplementation(function () {})
	})

	afterEach(() => {
		warnSpy.mockRestore()
		errorSpy.mockRestore()
	})

	it("returns undefined and does not warn for empty or whitespace input", () => {
		expect(parseVertexJsonCredentials(undefined)).toBeUndefined()
		expect(parseVertexJsonCredentials("")).toBeUndefined()
		expect(parseVertexJsonCredentials("   ")).toBeUndefined()
		expect(warnSpy).not.toHaveBeenCalled()
		expect(errorSpy).not.toHaveBeenCalled()
	})

	it("parses valid JSON credentials without warning", () => {
		const result = parseVertexJsonCredentials(VALID_CREDS_JSON)
		expect(result).toMatchObject({ type: "service_account" })
		expect(warnSpy).not.toHaveBeenCalled()
		expect(errorSpy).not.toHaveBeenCalled()
	})

	it.each([
		["Windows backslash path", "C:\\Users\\test\\creds.json"],
		["Windows forward-slash path", "C:/Users/test/creds.json"],
		["POSIX absolute path", "/home/test/creds.json"],
		["POSIX home path", "~/creds.json"],
		["POSIX relative ./", "./creds.json"],
		["POSIX relative ../", "../secrets/creds.json"],
	])("warns and returns undefined for %s", (_label, input) => {
		const result = parseVertexJsonCredentials(input)
		expect(result).toBeUndefined()
		expect(warnSpy).toHaveBeenCalledTimes(1)
		const [message] = warnSpy.mock.calls[0]
		expect(message).toContain("Google Cloud Credentials")
		expect(message).toContain("Google Cloud Key File Path")
		expect(message).toContain("GOOGLE_APPLICATION_CREDENTIALS")
		// Generic "Error parsing JSON" must not fire for the path case.
		expect(errorSpy).not.toHaveBeenCalled()
	})

	it("trims surrounding whitespace before detecting path shape", () => {
		expect(parseVertexJsonCredentials("  /tmp/creds.json  ")).toBeUndefined()
		expect(warnSpy).toHaveBeenCalledTimes(1)
	})

	it("does not echo the user's path in the warning (no PII in extension logs)", () => {
		const sensitivePath = "/home/somerealuser/secrets/sa-key.json"
		parseVertexJsonCredentials(sensitivePath)
		expect(warnSpy).toHaveBeenCalledTimes(1)
		const [message] = warnSpy.mock.calls[0]
		// The warning must identify the field and the env var, but must not
		// interpolate the user's actual input — usernames and directory names
		// would leak into extension logs otherwise.
		expect(message).toContain("Google Cloud Credentials")
		expect(message).toContain("GOOGLE_APPLICATION_CREDENTIALS")
		expect(message).not.toContain(sensitivePath)
		expect(message).not.toContain("somerealuser")
	})

	it("falls back to the generic JSON parse error path for malformed but non-path input", () => {
		const result = parseVertexJsonCredentials("not-json-and-not-a-path")
		expect(result).toBeUndefined()
		expect(warnSpy).not.toHaveBeenCalled()
		expect(errorSpy).toHaveBeenCalledTimes(1)
		const [message] = errorSpy.mock.calls[0]
		expect(message).toBe("Error parsing JSON (Vertex credentials):")
	})
})

describe("GeminiHandler vertex credentials wiring", () => {
	let warnSpy: ReturnType<typeof vi.spyOn>
	let errorSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		warnSpy = vi.spyOn(console, "warn").mockImplementation(function () {})
		errorSpy = vi.spyOn(console, "error").mockImplementation(function () {})
		googleGenAICtor.mockClear()
	})

	afterEach(() => {
		warnSpy.mockRestore()
		errorSpy.mockRestore()
	})

	it("passes parsed JSON credentials through to GoogleGenAI", () => {
		new GeminiHandler({
			apiModelId: "gemini-2.0-flash-001",
			vertexProjectId: "p",
			vertexRegion: "us-central1",
			vertexJsonCredentials: VALID_CREDS_JSON,
			isVertex: true,
		})

		expect(warnSpy).not.toHaveBeenCalled()
		expect(googleGenAICtor).toHaveBeenCalledTimes(1)
		const args = googleGenAICtor.mock.calls[0][0]
		expect(args.googleAuthOptions.credentials).toMatchObject({ type: "service_account" })
	})

	it("warns and falls through past the JSON branch when the field looks like a path", () => {
		new GeminiHandler({
			apiModelId: "gemini-2.0-flash-001",
			vertexProjectId: "p",
			vertexRegion: "us-central1",
			vertexJsonCredentials: "C:\\Users\\dev\\sa.json",
			isVertex: true,
		})

		expect(warnSpy).toHaveBeenCalledTimes(1)
		expect(googleGenAICtor).toHaveBeenCalledTimes(1)
		const args = googleGenAICtor.mock.calls[0][0]
		// With only a path-shaped vertexJsonCredentials (no vertexKeyFile),
		// the ternary falls all the way through to the bare isVertex branch:
		// new GoogleGenAI({ vertexai: true, project, location }) — no
		// googleAuthOptions block.
		expect(args.googleAuthOptions).toBeUndefined()
		expect(args.vertexai).toBe(true)
		// Generic "Error parsing JSON" must not fire for the path case.
		expect(errorSpy).not.toHaveBeenCalled()
	})

	it("uses vertexKeyFile when vertexJsonCredentials is path-shaped AND vertexKeyFile is set", () => {
		new GeminiHandler({
			apiModelId: "gemini-2.0-flash-001",
			vertexProjectId: "p",
			vertexRegion: "us-central1",
			vertexJsonCredentials: "C:\\Users\\dev\\sa.json",
			vertexKeyFile: "my-key-file.json",
			isVertex: true,
		})

		expect(googleGenAICtor).toHaveBeenCalledTimes(1)
		const args = googleGenAICtor.mock.calls[0][0]
		// The path-shaped input must not poison the JSON branch; the fallback
		// to the vertexKeyFile branch must take effect.
		expect(args.googleAuthOptions?.keyFile).toBe("my-key-file.json")
		expect(args.googleAuthOptions?.credentials).toBeUndefined()
		// The warning for the path-shaped input still fires.
		expect(warnSpy).toHaveBeenCalledTimes(1)
		// Generic "Error parsing JSON" must not fire for the path case.
		expect(errorSpy).not.toHaveBeenCalled()
	})

	it("does not warn or supply credentials when neither field is set", () => {
		new GeminiHandler({
			apiModelId: "gemini-2.0-flash-001",
			vertexProjectId: "p",
			vertexRegion: "us-central1",
			isVertex: true,
		})

		expect(warnSpy).not.toHaveBeenCalled()
		expect(googleGenAICtor).toHaveBeenCalledTimes(1)
		const args = googleGenAICtor.mock.calls[0][0]
		// In this branch the constructor builds GoogleGenAI without googleAuthOptions.
		expect(args.googleAuthOptions).toBeUndefined()
	})
})

describe("VertexHandler inherits the path-shape guard from GeminiHandler", () => {
	let warnSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		warnSpy = vi.spyOn(console, "warn").mockImplementation(function () {})
		googleGenAICtor.mockClear()
	})

	afterEach(() => {
		warnSpy.mockRestore()
	})

	it("warns and falls through past the JSON branch when the field looks like a POSIX path", () => {
		new VertexHandler({
			apiModelId: "gemini-2.0-flash-001",
			vertexProjectId: "p",
			vertexRegion: "us-central1",
			vertexJsonCredentials: "/home/dev/sa.json",
		})

		expect(warnSpy).toHaveBeenCalledTimes(1)
		const args = googleGenAICtor.mock.calls[0][0]
		// VertexHandler extends GeminiHandler with isVertex:true. With only a
		// path-shaped vertexJsonCredentials, the ternary falls through to the
		// bare isVertex branch with no googleAuthOptions.
		expect(args.googleAuthOptions).toBeUndefined()
		expect(args.vertexai).toBe(true)
	})
})

describe("AnthropicVertexHandler vertex credentials wiring", () => {
	let warnSpy: ReturnType<typeof vi.spyOn>
	let errorSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		warnSpy = vi.spyOn(console, "warn").mockImplementation(function () {})
		errorSpy = vi.spyOn(console, "error").mockImplementation(function () {})
		googleAuthCtor.mockClear()
	})

	afterEach(() => {
		warnSpy.mockRestore()
		errorSpy.mockRestore()
	})

	it("passes parsed JSON credentials through to GoogleAuth", () => {
		new AnthropicVertexHandler({
			apiModelId: "claude-3-5-sonnet-v2@20241022",
			vertexProjectId: "p",
			vertexRegion: "us-east5",
			vertexJsonCredentials: VALID_CREDS_JSON,
		})

		expect(warnSpy).not.toHaveBeenCalled()
		expect(googleAuthCtor).toHaveBeenCalledTimes(1)
		const args = googleAuthCtor.mock.calls[0][0]
		expect(args.credentials).toMatchObject({ type: "service_account" })
	})

	it("warns and skips the GoogleAuth construction when the field looks like a Windows path", () => {
		new AnthropicVertexHandler({
			apiModelId: "claude-3-5-sonnet-v2@20241022",
			vertexProjectId: "p",
			vertexRegion: "us-east5",
			vertexJsonCredentials: "C:\\Users\\dev\\sa.json",
		})

		expect(warnSpy).toHaveBeenCalledTimes(1)
		// With only a path-shaped vertexJsonCredentials (no vertexKeyFile),
		// every branch in the constructor falls through to the bare
		// `new AnthropicVertex({ projectId, region })` and GoogleAuth is
		// never instantiated.
		expect(googleAuthCtor).not.toHaveBeenCalled()
		expect(errorSpy).not.toHaveBeenCalled()
	})

	it("uses vertexKeyFile when vertexJsonCredentials is path-shaped AND vertexKeyFile is set", () => {
		new AnthropicVertexHandler({
			apiModelId: "claude-3-5-sonnet-v2@20241022",
			vertexProjectId: "p",
			vertexRegion: "us-east5",
			vertexJsonCredentials: "C:\\Users\\dev\\sa.json",
			vertexKeyFile: "my-key-file.json",
		})

		// The path-shaped input must not poison the JSON branch; the fallback
		// to the vertexKeyFile branch must take effect.
		expect(googleAuthCtor).toHaveBeenCalledTimes(1)
		const args = googleAuthCtor.mock.calls[0][0]
		expect(args.keyFile).toBe("my-key-file.json")
		expect(args.credentials).toBeUndefined()
		// The warning for the path-shaped input still fires.
		expect(warnSpy).toHaveBeenCalledTimes(1)
		// Generic "Error parsing JSON" must not fire for the path case.
		expect(errorSpy).not.toHaveBeenCalled()
	})

	it("does not invoke GoogleAuth when neither credentials nor keyFile is set", () => {
		new AnthropicVertexHandler({
			apiModelId: "claude-3-5-sonnet-v2@20241022",
			vertexProjectId: "p",
			vertexRegion: "us-east5",
		})

		expect(warnSpy).not.toHaveBeenCalled()
		expect(googleAuthCtor).not.toHaveBeenCalled()
	})
})
