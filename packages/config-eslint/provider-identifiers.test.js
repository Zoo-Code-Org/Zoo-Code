import { RuleTester } from "eslint"
import typescriptEslint from "typescript-eslint"

import { createProviderIdentifierConfig } from "./provider-identifiers.js"

const config = createProviderIdentifierConfig({
	providerIdentifiers: {
		anthropic: "anthropic",
		gemini: "gemini",
		openaiNative: "openai-native",
		openrouter: "openrouter",
		poe: "poe",
		vercelAiGateway: "vercel-ai-gateway",
	},
	retiredProviderIdentifiers: {
		groq: "groq",
		roo: "roo",
	},
})
const rule = config.plugins.zoo.rules["no-raw-provider-identifiers"]

const ruleTester = new RuleTester({
	languageOptions: {
		ecmaVersion: 2022,
		sourceType: "module",
		parser: typescriptEslint.parser,
	},
})

ruleTester.run("no-raw-provider-identifiers provider map keys", rule, {
	valid: [
		"const dynamicProviderExtras = { [providerIdentifiers.openrouter]: {} }",
		"const dynamicProviderExtras = { [providerName]: {} }",
		"const response = { openrouter: externalPayload }",
		'const providerIdentifiers = { openrouter: "openrouter", vercelAiGateway: "vercel-ai-gateway" }',
	],
	invalid: [
		{
			code: 'const dynamicProviderExtras = { openrouter: {}, "vercel-ai-gateway": {} }',
			errors: [
				{
					messageId: "useCanonical",
					data: { replacement: "providerIdentifiers.openrouter", value: "openrouter" },
				},
				{
					messageId: "useCanonical",
					data: { replacement: "providerIdentifiers.vercelAiGateway", value: "vercel-ai-gateway" },
				},
			],
		},
		{
			code: 'const dynamicProviderExtras = { ["openrouter"]: {}, [`vercel-ai-gateway`]: {} }',
			errors: [
				{
					messageId: "useCanonical",
					data: { replacement: "providerIdentifiers.openrouter", value: "openrouter" },
					type: "Literal",
				},
				{
					messageId: "useCanonical",
					data: { replacement: "providerIdentifiers.vercelAiGateway", value: "vercel-ai-gateway" },
					type: "TemplateLiteral",
				},
			],
		},
	],
})

ruleTester.run("no-raw-provider-identifiers provider-like values", rule, {
	valid: [
		"const apiProvider = retiredProviderIdentifiers.roo",
		"const provider = retiredProviderIdentifiers.groq",
		'const config = { apiProvider: "external-provider" }',
		"const config = { apiProvider: providerIdentifiers.poe }",
		"const provider = providerIdentifiers.openrouter",
		"const provider = configuredProvider || providerIdentifiers.openrouter",
		"const apiProvider = useGemini ? providerIdentifiers.gemini : providerIdentifiers.openrouter",
		"getProviderServiceConfig(providerIdentifiers.gemini)",
		'if (config?.protocol === "gemini") {}',
		'const response = { protocol: "anthropic", format: "openrouter" }',
	],
	invalid: [
		{
			code: 'const apiProvider = "roo"',
			errors: [
				{
					messageId: "useCanonical",
					data: { replacement: "retiredProviderIdentifiers.roo", value: "roo" },
					type: "Literal",
				},
			],
		},
		{
			code: "const persistedProvider = `groq`",
			errors: [
				{
					messageId: "useCanonical",
					data: { replacement: "retiredProviderIdentifiers.groq", value: "groq" },
					type: "TemplateLiteral",
				},
			],
		},
		{
			code: 'const config = { apiProvider: "poe", imageProvider: `openrouter` }',
			errors: [
				{ messageId: "useCanonical", data: { replacement: "providerIdentifiers.poe", value: "poe" } },
				{
					messageId: "useCanonical",
					data: { replacement: "providerIdentifiers.openrouter", value: "openrouter" },
				},
			],
		},
		{
			code: 'class Service { #apiProvider = "gemini" }',
			errors: [
				{
					messageId: "useCanonical",
					data: { replacement: "providerIdentifiers.gemini", value: "gemini" },
					type: "Literal",
				},
			],
		},
		{
			code: 'config["apiProvider"] = "poe"; if (imageProvider === "openrouter") {}',
			errors: [
				{ messageId: "useCanonical", data: { replacement: "providerIdentifiers.poe", value: "poe" } },
				{
					messageId: "useCanonical",
					data: { replacement: "providerIdentifiers.openrouter", value: "openrouter" },
				},
			],
		},
		{
			code: 'switch (config.apiProvider) { case "poe": break; case providerIdentifiers.openrouter: break }',
			errors: [{ messageId: "useCanonical", data: { replacement: "providerIdentifiers.poe", value: "poe" } }],
		},
		{
			code: 'function select(provider = "openrouter") { return provider }',
			errors: [
				{
					messageId: "useCanonical",
					data: { replacement: "providerIdentifiers.openrouter", value: "openrouter" },
				},
			],
		},
		{
			code: 'const { apiProvider: selected = "gemini" } = config',
			errors: [
				{
					messageId: "useCanonical",
					data: { replacement: "providerIdentifiers.gemini", value: "gemini" },
					type: "Literal",
				},
			],
		},
		{
			code: 'const { apiProvider = "gemini" } = config',
			errors: [
				{
					messageId: "useCanonical",
					data: { replacement: "providerIdentifiers.gemini", value: "gemini" },
					type: "Literal",
				},
			],
		},
		{
			code: 'getProviderServiceConfig("gemini")',
			errors: [
				{
					messageId: "useCanonical",
					data: { replacement: "providerIdentifiers.gemini", value: "gemini" },
				},
			],
		},
		{
			code: '(getProviderServiceConfig<string>)("gemini")',
			errors: [
				{
					messageId: "useCanonical",
					data: { replacement: "providerIdentifiers.gemini", value: "gemini" },
				},
			],
		},
		{
			code: 'if (config?.apiProvider === "gemini") {}',
			errors: [
				{
					messageId: "useCanonical",
					data: { replacement: "providerIdentifiers.gemini", value: "gemini" },
				},
			],
		},
		{
			code: 'const config = { apiProvider: configuredProvider || "openrouter" }',
			errors: [
				{
					messageId: "useCanonical",
					data: { replacement: "providerIdentifiers.openrouter", value: "openrouter" },
					type: "Literal",
				},
			],
		},
		{
			code: 'const schema = { imageGenerationProvider: z.enum(["openrouter"]) }',
			errors: [
				{
					messageId: "useCanonical",
					data: { replacement: "providerIdentifiers.openrouter", value: "openrouter" },
					type: "Literal",
				},
			],
		},
		{
			code: 'const imageProvider = useGemini ? "gemini" : "openrouter"',
			errors: [
				{
					messageId: "useCanonical",
					data: { replacement: "providerIdentifiers.gemini", value: "gemini" },
					type: "Literal",
				},
				{
					messageId: "useCanonical",
					data: { replacement: "providerIdentifiers.openrouter", value: "openrouter" },
					type: "Literal",
				},
			],
		},
		{
			code: 'const apiProvider = (useGemini ? "gemini" : configuredProvider) || "openrouter"',
			errors: [
				{
					messageId: "useCanonical",
					data: { replacement: "providerIdentifiers.gemini", value: "gemini" },
					type: "Literal",
				},
				{
					messageId: "useCanonical",
					data: { replacement: "providerIdentifiers.openrouter", value: "openrouter" },
					type: "Literal",
				},
			],
		},
	],
})
