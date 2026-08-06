import { getApiKeyFromEnv, getProviderSettings, providerRequiresApiKey } from "../provider.js"

// Bedrock-relevant AWS environment variables. Cleared before each test so the
// suite is hermetic regardless of the host machine's ambient AWS configuration.
const AWS_ENV_KEYS = [
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"AWS_PROFILE",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_BEDROCK_API_KEY",
]

describe("getApiKeyFromEnv", () => {
	const originalEnv = process.env

	beforeEach(() => {
		// Reset process.env before each test.
		process.env = { ...originalEnv }
	})

	afterEach(() => {
		process.env = originalEnv
	})

	it("should return API key from environment variable for anthropic", () => {
		process.env.ANTHROPIC_API_KEY = "test-anthropic-key"
		expect(getApiKeyFromEnv("anthropic")).toBe("test-anthropic-key")
	})

	it("should return API key from environment variable for openrouter", () => {
		process.env.OPENROUTER_API_KEY = "test-openrouter-key"
		expect(getApiKeyFromEnv("openrouter")).toBe("test-openrouter-key")
	})

	it("should return API key from environment variable for openai", () => {
		process.env.OPENAI_API_KEY = "test-openai-key"
		expect(getApiKeyFromEnv("openai-native")).toBe("test-openai-key")
	})

	it("should return API key from environment variable for bedrock", () => {
		process.env.AWS_BEDROCK_API_KEY = "test-bedrock-key"
		expect(getApiKeyFromEnv("bedrock")).toBe("test-bedrock-key")
	})

	it("should return undefined when API key is not set", () => {
		delete process.env.ANTHROPIC_API_KEY
		expect(getApiKeyFromEnv("anthropic")).toBeUndefined()
	})
})

describe("providerRequiresApiKey", () => {
	it("returns false for bedrock (AWS credential chain / profile / direct creds are valid)", () => {
		expect(providerRequiresApiKey("bedrock")).toBe(false)
	})

	it.each(["anthropic", "openai-native", "gemini", "openrouter", "vercel-ai-gateway"] as const)(
		"returns true for '%s'",
		(provider) => {
			expect(providerRequiresApiKey(provider)).toBe(true)
		},
	)
})

describe("getProviderSettings", () => {
	const originalEnv = process.env

	beforeEach(() => {
		process.env = { ...originalEnv }
		for (const key of AWS_ENV_KEYS) {
			delete process.env[key]
		}
	})

	afterEach(() => {
		process.env = originalEnv
	})

	it("sets apiProvider for the selected provider", () => {
		const config = getProviderSettings("anthropic", undefined, undefined)
		expect(config.apiProvider).toBe("anthropic")
	})

	describe("bedrock authentication modes", () => {
		it("mode 1: bearer token / API key sets awsUseApiKey and awsApiKey", () => {
			const config = getProviderSettings("bedrock", "bearer-token-123", undefined)

			expect(config.apiProvider).toBe("bedrock")
			expect(config.awsUseApiKey).toBe(true)
			expect(config.awsApiKey).toBe("bearer-token-123")
			// API-key mode must not enable profile or direct-credential fields.
			expect(config.awsUseProfile).toBeUndefined()
			expect(config.awsProfile).toBeUndefined()
			expect(config.awsAccessKey).toBeUndefined()
			expect(config.awsSecretKey).toBeUndefined()
		})

		it("mode 2: AWS_PROFILE sets awsUseProfile and awsProfile", () => {
			process.env.AWS_PROFILE = "my-sso-profile"

			const config = getProviderSettings("bedrock", undefined, undefined)

			expect(config.awsUseProfile).toBe(true)
			expect(config.awsProfile).toBe("my-sso-profile")
			expect(config.awsUseApiKey).toBeUndefined()
			expect(config.awsApiKey).toBeUndefined()
			expect(config.awsAccessKey).toBeUndefined()
		})

		it("mode 3: direct credentials map AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY", () => {
			process.env.AWS_ACCESS_KEY_ID = "AKIAEXAMPLE"
			process.env.AWS_SECRET_ACCESS_KEY = "secret-example"

			const config = getProviderSettings("bedrock", undefined, undefined)

			expect(config.awsAccessKey).toBe("AKIAEXAMPLE")
			expect(config.awsSecretKey).toBe("secret-example")
			expect(config.awsSessionToken).toBeUndefined()
			expect(config.awsUseApiKey).toBeUndefined()
			expect(config.awsUseProfile).toBeUndefined()
		})

		it("mode 3: direct credentials include AWS_SESSION_TOKEN when present", () => {
			process.env.AWS_ACCESS_KEY_ID = "AKIAEXAMPLE"
			process.env.AWS_SECRET_ACCESS_KEY = "secret-example"
			process.env.AWS_SESSION_TOKEN = "session-token-example"

			const config = getProviderSettings("bedrock", undefined, undefined)

			expect(config.awsAccessKey).toBe("AKIAEXAMPLE")
			expect(config.awsSecretKey).toBe("secret-example")
			expect(config.awsSessionToken).toBe("session-token-example")
		})

		it("mode 4: default credential chain — no creds set does NOT throw and sets no explicit auth fields", () => {
			expect(() => getProviderSettings("bedrock", undefined, undefined)).not.toThrow()

			const config = getProviderSettings("bedrock", undefined, undefined)

			// Region is always resolved, but none of the explicit auth modes engage,
			// leaving the AWS SDK to resolve credentials via its default chain.
			expect(config.awsUseApiKey).toBeUndefined()
			expect(config.awsApiKey).toBeUndefined()
			expect(config.awsUseProfile).toBeUndefined()
			expect(config.awsProfile).toBeUndefined()
			expect(config.awsAccessKey).toBeUndefined()
			expect(config.awsSecretKey).toBeUndefined()
		})

		it("prioritises API key over AWS_PROFILE and direct credentials", () => {
			process.env.AWS_PROFILE = "my-profile"
			process.env.AWS_ACCESS_KEY_ID = "AKIAEXAMPLE"
			process.env.AWS_SECRET_ACCESS_KEY = "secret-example"

			const config = getProviderSettings("bedrock", "bearer-token-123", undefined)

			expect(config.awsUseApiKey).toBe(true)
			expect(config.awsApiKey).toBe("bearer-token-123")
			expect(config.awsUseProfile).toBeUndefined()
			expect(config.awsAccessKey).toBeUndefined()
		})

		it("prioritises AWS_PROFILE over direct credentials when no API key is present", () => {
			process.env.AWS_PROFILE = "my-profile"
			process.env.AWS_ACCESS_KEY_ID = "AKIAEXAMPLE"
			process.env.AWS_SECRET_ACCESS_KEY = "secret-example"

			const config = getProviderSettings("bedrock", undefined, undefined)

			expect(config.awsUseProfile).toBe(true)
			expect(config.awsProfile).toBe("my-profile")
			expect(config.awsAccessKey).toBeUndefined()
			expect(config.awsSecretKey).toBeUndefined()
		})
	})

	describe("bedrock region resolution", () => {
		it("defaults awsRegion to us-east-1 when no region env is set", () => {
			const config = getProviderSettings("bedrock", undefined, undefined)
			expect(config.awsRegion).toBe("us-east-1")
		})

		it("uses AWS_REGION when set", () => {
			process.env.AWS_REGION = "eu-west-1"
			const config = getProviderSettings("bedrock", undefined, undefined)
			expect(config.awsRegion).toBe("eu-west-1")
		})

		it("falls back to AWS_DEFAULT_REGION when AWS_REGION is unset", () => {
			process.env.AWS_DEFAULT_REGION = "ap-southeast-2"
			const config = getProviderSettings("bedrock", undefined, undefined)
			expect(config.awsRegion).toBe("ap-southeast-2")
		})

		it("prefers AWS_REGION over AWS_DEFAULT_REGION", () => {
			process.env.AWS_REGION = "eu-west-1"
			process.env.AWS_DEFAULT_REGION = "ap-southeast-2"
			const config = getProviderSettings("bedrock", undefined, undefined)
			expect(config.awsRegion).toBe("eu-west-1")
		})
	})

	describe("bedrock cross-region inference auto-enable", () => {
		it.each([
			"us.anthropic.claude-3-5-sonnet-20241022-v2:0",
			"eu.anthropic.claude-3-5-sonnet",
			"apac.amazon.nova-pro",
		])("enables awsUseCrossRegionInference for regional-prefixed model '%s'", (model) => {
			const config = getProviderSettings("bedrock", undefined, model)
			expect(config.apiModelId).toBe(model)
			expect(config.awsUseCrossRegionInference).toBe(true)
		})

		it("does NOT enable cross-region inference for a non-prefixed model", () => {
			const model = "anthropic.claude-3-5-sonnet-20241022-v2:0"
			const config = getProviderSettings("bedrock", undefined, model)
			expect(config.apiModelId).toBe(model)
			expect(config.awsUseCrossRegionInference).toBeUndefined()
		})

		it("does not set apiModelId or cross-region flag when no model is given", () => {
			const config = getProviderSettings("bedrock", undefined, undefined)
			expect(config.apiModelId).toBeUndefined()
			expect(config.awsUseCrossRegionInference).toBeUndefined()
		})
	})
})
