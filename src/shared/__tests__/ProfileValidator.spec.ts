// npx vitest run src/shared/__tests__/ProfileValidator.spec.ts

import { providerIdentifiers, type ProviderSettings, type OrganizationAllowList } from "@roo-code/types"

import { ProfileValidator } from "../ProfileValidator"

describe("ProfileValidator", () => {
	describe("isProfileAllowed", () => {
		it.each([
			["openai", { openAiModelId: "model" }],
			["anthropic", { apiModelId: "model" }],
			["openaiNative", { apiModelId: "model" }],
			["bedrock", { apiModelId: "model" }],
			["vertex", { apiModelId: "model" }],
			["gemini", { apiModelId: "model" }],
			["mistral", { apiModelId: "model" }],
			["deepseek", { apiModelId: "model" }],
			["xai", { apiModelId: "model" }],
			["sambanova", { apiModelId: "model" }],
			["fireworks", { apiModelId: "model" }],
			["friendli", { apiModelId: "model" }],
			["litellm", { litellmModelId: "model" }],
			["lmstudio", { lmStudioModelId: "model" }],
			["vscodeLm", { vsCodeLmModelSelector: { id: "model" } }],
			["openrouter", { openRouterModelId: "model" }],
			["ollama", { ollamaModelId: "model" }],
			["requesty", { requestyModelId: "model" }],
			["unbound", { unboundModelId: "model" }],
		])("resolves %s model fields through canonical identifiers", (identifierKey, profileSettings) => {
			const canonicalIdentifier = providerIdentifiers[identifierKey as keyof typeof providerIdentifiers]
			const modelId = "model"

			const profile = {
				apiProvider: canonicalIdentifier,
				...profileSettings,
			} as ProviderSettings
			const allowList: OrganizationAllowList = {
				allowAll: false,
				providers: {
					[canonicalIdentifier]: { allowAll: false, models: [modelId] },
				},
			}

			expect(ProfileValidator.isProfileAllowed(profile, allowList)).toBe(true)

			const negativeAllowList: OrganizationAllowList = {
				allowAll: false,
				providers: {
					[canonicalIdentifier]: { allowAll: false, models: ["other-model"] },
				},
			}

			expect(ProfileValidator.isProfileAllowed(profile, negativeAllowList)).toBe(false)
		})

		it.each([
			{ providerAllowAll: false, expected: false },
			{ providerAllowAll: true, expected: true },
		])(
			"preserves missing-model fallback behavior when provider allowAll is $providerAllowAll",
			({ providerAllowAll, expected }) => {
				const profile: ProviderSettings = {
					apiProvider: providerIdentifiers.openai,
				}
				const allowList: OrganizationAllowList = {
					allowAll: false,
					providers: {
						[providerIdentifiers.openai]: { allowAll: providerAllowAll },
					},
				}

				expect(ProfileValidator.isProfileAllowed(profile, allowList)).toBe(expected)
			},
		)

		it("should allow any profile when allowAll is true", () => {
			const allowList: OrganizationAllowList = {
				allowAll: true,
				providers: {},
			}
			const profile: ProviderSettings = {
				apiProvider: providerIdentifiers.openai,
				openAiModelId: "gpt-4",
			}

			expect(ProfileValidator.isProfileAllowed(profile, allowList)).toBe(true)
		})

		it("should reject profiles without an apiProvider", () => {
			const allowList: OrganizationAllowList = {
				allowAll: false,
				providers: {
					openai: { allowAll: true },
				},
			}
			const profile: Partial<ProviderSettings> = {}

			expect(ProfileValidator.isProfileAllowed(profile as ProviderSettings, allowList)).toBe(false)
		})

		it("should reject profiles with provider not in allow list", () => {
			const allowList: OrganizationAllowList = {
				allowAll: false,
				providers: {
					anthropic: { allowAll: true },
					gemini: { allowAll: false, models: ["gemini-pro"] },
				},
			}
			const profile: ProviderSettings = {
				apiProvider: providerIdentifiers.openai,
				openAiModelId: "gpt-4",
			}

			expect(ProfileValidator.isProfileAllowed(profile, allowList)).toBe(false)
		})

		it("should allow providers with allowAll=true regardless of model", () => {
			const allowList: OrganizationAllowList = {
				allowAll: false,
				providers: {
					openai: { allowAll: true },
				},
			}
			const profile: ProviderSettings = {
				apiProvider: providerIdentifiers.openai,
				openAiModelId: "any-model-id",
			}

			expect(ProfileValidator.isProfileAllowed(profile, allowList)).toBe(true)
		})

		it("should reject if provider exists but model ID is missing", () => {
			const allowList: OrganizationAllowList = {
				allowAll: false,
				providers: {
					openai: { allowAll: false, models: ["gpt-4"] },
				},
			}
			const profile: ProviderSettings = {
				apiProvider: providerIdentifiers.openai,
			}

			expect(ProfileValidator.isProfileAllowed(profile, allowList)).toBe(false)
		})

		it("should allow if model is in the allowed models list", () => {
			const allowList: OrganizationAllowList = {
				allowAll: false,
				providers: {
					openai: { allowAll: false, models: ["gpt-3.5-turbo", "gpt-4"] },
				},
			}
			const profile: ProviderSettings = {
				apiProvider: providerIdentifiers.openai,
				openAiModelId: "gpt-4",
			}

			expect(ProfileValidator.isProfileAllowed(profile, allowList)).toBe(true)
		})

		it("should reject if model is not in the allowed models list", () => {
			const allowList: OrganizationAllowList = {
				allowAll: false,
				providers: {
					openai: { allowAll: false, models: ["gpt-3.5-turbo"] },
				},
			}
			const profile: ProviderSettings = {
				apiProvider: providerIdentifiers.openai,
				openAiModelId: "gpt-4",
			}

			expect(ProfileValidator.isProfileAllowed(profile, allowList)).toBe(false)
		})

		it("should handle undefined models array in provider config", () => {
			const allowList: OrganizationAllowList = {
				allowAll: false,
				providers: {
					openai: { allowAll: false },
				},
			}
			const profile: ProviderSettings = {
				apiProvider: providerIdentifiers.openai,
				openAiModelId: "gpt-4",
			}

			expect(ProfileValidator.isProfileAllowed(profile, allowList)).toBe(false)
		})

		it("should extract openAiModelId for openai provider", () => {
			const allowList: OrganizationAllowList = {
				allowAll: false,
				providers: {
					openai: { allowAll: false, models: ["gpt-4"] },
				},
			}
			const profile: ProviderSettings = {
				apiProvider: providerIdentifiers.openai,
				openAiModelId: "gpt-4",
			}

			expect(ProfileValidator.isProfileAllowed(profile, allowList)).toBe(true)
		})

		it("should extract apiModelId for anthropic provider", () => {
			const allowList: OrganizationAllowList = {
				allowAll: false,
				providers: {
					anthropic: { allowAll: false, models: ["claude-3-opus"] },
				},
			}
			const profile: ProviderSettings = {
				apiProvider: providerIdentifiers.anthropic,
				apiModelId: "claude-3-opus",
			}

			expect(ProfileValidator.isProfileAllowed(profile, allowList)).toBe(true)
		})

		it("should extract ollamaModelId for ollama provider", () => {
			const allowList: OrganizationAllowList = {
				allowAll: false,
				providers: {
					ollama: { allowAll: false, models: ["llama3"] },
				},
			}
			const profile: ProviderSettings = {
				apiProvider: providerIdentifiers.ollama,
				ollamaModelId: "llama3",
			}

			expect(ProfileValidator.isProfileAllowed(profile, allowList)).toBe(true)
		})

		// Test specific providers that use apiModelId
		const apiModelProviders = [
			providerIdentifiers.anthropic,
			providerIdentifiers.openaiNative,
			providerIdentifiers.bedrock,
			providerIdentifiers.vertex,
			providerIdentifiers.gemini,
			providerIdentifiers.mistral,
			providerIdentifiers.deepseek,
			providerIdentifiers.xai,
			providerIdentifiers.sambanova,
			providerIdentifiers.fireworks,
			providerIdentifiers.friendli,
		]

		apiModelProviders.forEach((provider) => {
			it(`should extract apiModelId for ${provider} provider`, () => {
				const allowList: OrganizationAllowList = {
					allowAll: false,
					providers: {
						[provider]: { allowAll: false, models: ["test-model"] },
					},
				}
				const profile: ProviderSettings = {
					apiProvider: provider,
					apiModelId: "test-model",
				}

				expect(ProfileValidator.isProfileAllowed(profile, allowList)).toBe(true)
			})
		})

		// Test for litellm provider which uses litellmModelId
		it(`should extract litellmModelId for litellm provider`, () => {
			const allowList: OrganizationAllowList = {
				allowAll: false,
				providers: {
					[providerIdentifiers.litellm]: { allowAll: false, models: ["test-model"] },
				},
			}
			const profile: ProviderSettings = {
				apiProvider: providerIdentifiers.litellm,
				litellmModelId: "test-model",
			}

			expect(ProfileValidator.isProfileAllowed(profile, allowList)).toBe(true)
		})

		it("should extract vsCodeLmModelSelector.id for vscode-lm provider", () => {
			const allowList: OrganizationAllowList = {
				allowAll: false,
				providers: {
					[providerIdentifiers.vscodeLm]: { allowAll: false, models: ["copilot-gpt-3.5"] },
				},
			}
			const profile: ProviderSettings = {
				apiProvider: providerIdentifiers.vscodeLm,
				vsCodeLmModelSelector: { id: "copilot-gpt-3.5" },
			}

			expect(ProfileValidator.isProfileAllowed(profile, allowList)).toBe(true)
		})

		it("should extract lmStudioModelId for lmstudio provider", () => {
			const allowList: OrganizationAllowList = {
				allowAll: false,
				providers: {
					lmstudio: { allowAll: false, models: ["lmstudio-model"] },
				},
			}
			const profile: ProviderSettings = {
				apiProvider: providerIdentifiers.lmstudio,
				lmStudioModelId: "lmstudio-model",
			}

			expect(ProfileValidator.isProfileAllowed(profile, allowList)).toBe(true)
		})

		it("should extract openRouterModelId for openrouter provider", () => {
			const allowList: OrganizationAllowList = {
				allowAll: false,
				providers: {
					openrouter: { allowAll: false, models: ["openrouter-model"] },
				},
			}
			const profile: ProviderSettings = {
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "openrouter-model",
			}

			expect(ProfileValidator.isProfileAllowed(profile, allowList)).toBe(true)
		})

		it("should extract requestyModelId for requesty provider", () => {
			const allowList: OrganizationAllowList = {
				allowAll: false,
				providers: {
					requesty: { allowAll: false, models: ["requesty-model"] },
				},
			}
			const profile: ProviderSettings = {
				apiProvider: providerIdentifiers.requesty,
				requestyModelId: "requesty-model",
			}

			expect(ProfileValidator.isProfileAllowed(profile, allowList)).toBe(true)
		})

		it("should handle providers with undefined models list gracefully", () => {
			const allowList: OrganizationAllowList = {
				allowAll: false,
				providers: {
					[providerIdentifiers.fakeAi]: { allowAll: false },
				},
			}
			const profile: ProviderSettings = {
				apiProvider: providerIdentifiers.fakeAi,
			}

			expect(ProfileValidator.isProfileAllowed(profile, allowList)).toBe(false)
		})

		it("should handle empty providers object", () => {
			const allowList: OrganizationAllowList = {
				allowAll: false,
				providers: {},
			}
			const profile: ProviderSettings = {
				apiProvider: providerIdentifiers.openai,
				openAiModelId: "gpt-4",
			}

			expect(ProfileValidator.isProfileAllowed(profile, allowList)).toBe(false)
		})
	})
})
