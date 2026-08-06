import { UNIVERSAL_STOP_SEQUENCES, resolveAutocompleteConfig, type AutocompleteConfig } from "@roo-code/types"

import { PromptBuilder } from "../PromptBuilder"

const build = (config: AutocompleteConfig = {}, prefix = "function add(", suffix = ") { return a + b }") =>
	new PromptBuilder().build({
		prefix,
		suffix,
		snippets: [],
		config: resolveAutocompleteConfig(config),
	})

describe("PromptBuilder stop sequences", () => {
	it("always includes the universal stop sequences", () => {
		// The bug this guards: the `none` and `instruct` templates contribute no
		// stop tokens of their own, so without the universal set the stream had no
		// terminator at all and ran to maxOutputTokens emitting prose.
		const built = build({ modelId: "lfm2.5-2.6b" })

		for (const stop of UNIVERSAL_STOP_SEQUENCES) {
			expect(built.stopSequences).toContain(stop)
		}
	})

	it("never yields an empty stop list, whatever the model", () => {
		for (const modelId of ["lfm2.5-2.6b", "some-unknown-model", "qwen2.5-coder:1.5b-base"]) {
			expect(build({ modelId }).stopSequences.length).toBeGreaterThan(0)
		}
	})

	it("puts family-specific tokens first so handlers that cap the list keep them", () => {
		// The OpenAI /v1/completions API accepts at most 4 stop sequences.
		const built = build({ modelId: "qwen2.5-coder:1.5b-base" })

		expect(built.stopSequences.slice(0, 4)).toContain("<|fim_pad|>")
	})

	it("de-duplicates across template, user and universal sets", () => {
		const built = build({ modelId: "qwen2.5-coder:1.5b-base", stopSequences: ["<|endoftext|>", "CUSTOM"] })

		expect(built.stopSequences.filter((stop) => stop === "<|endoftext|>")).toHaveLength(1)
		expect(built.stopSequences).toContain("CUSTOM")
	})
})

describe("PromptBuilder FIM routing", () => {
	it("marks a FIM base model as native", () => {
		const built = build({ modelId: "qwen2.5-coder:1.5b-base" })

		expect(built.supportsFim).toBe(true)
		expect(built.templateId).toBe("qwen")
		expect(built.prefix).toContain("function add(")
	})

	it("marks an instruct model as non-native and renders an instruction prompt", () => {
		const built = build({ modelId: "lfm2.5-2.6b" })

		expect(built.supportsFim).toBe(false)
		expect(built.templateId).toBe("instruct")
		// Both sides of the cursor must reach a non-FIM model through the rendered
		// prompt, since its `suffix` field will be omitted.
		expect(built.renderedPrompt).toContain("function add(")
		expect(built.renderedPrompt).toContain(") { return a + b }")
		expect(built.renderedPrompt).toContain("<CURSOR>")
	})

	it("honours an explicit template override", () => {
		const built = build({ modelId: "lfm2.5-2.6b", fimTemplate: "qwen" })

		expect(built.templateId).toBe("qwen")
		expect(built.supportsFim).toBe(true)
	})
})

describe("PromptBuilder chat routing", () => {
	it("routes an instruct model to the chat endpoint with a system prompt", () => {
		const built = build({ modelId: "lfm2.5-2.6b" })

		expect(built.useChatEndpoint).toBe(true)
		expect(built.systemPrompt).toMatch(/only/i)
		// The user turn carries code only — never the rules, which a raw
		// completions endpoint would happily continue as text.
		expect(built.renderedPrompt).not.toMatch(/output only/i)
		expect(built.renderedPrompt).toContain("<CURSOR>")
	})

	it("keeps FIM models off the chat endpoint", () => {
		const built = build({ modelId: "qwen2.5-coder:1.5b-base" })

		expect(built.useChatEndpoint).toBe(false)
		expect(built.systemPrompt).toBeUndefined()
	})
})
