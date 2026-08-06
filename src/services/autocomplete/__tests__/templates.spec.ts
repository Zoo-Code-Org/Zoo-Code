import { FIM_TEMPLATES, INSTRUCT_SYSTEM_PROMPT, renderSnippetPreamble } from "../prompt/templates"
import { FimTemplateRegistry, isBaseModel, templateSupportsFim } from "../prompt/FimTemplateRegistry"
import type { AutocompleteSnippet } from "../types"

const P = "function add("
const S = ") { return a + b }"

describe("FimTemplateRegistry", () => {
	const registry = new FimTemplateRegistry()

	it("resolves by model id match (qwen)", () => {
		expect(registry.resolve("qwen2.5-coder:1.5b-base", undefined).id).toBe("qwen")
	})

	it("resolves by model id match (starcoder)", () => {
		expect(registry.resolve("starcoder2-3b", undefined).id).toBe("starcoder")
	})

	it("resolves by model id match (codestral)", () => {
		expect(registry.resolve("codestral-latest", undefined).id).toBe("codestral")
	})

	it("resolves by model id match (codellama)", () => {
		expect(registry.resolve("CodeLlama-7b", undefined).id).toBe("codellama")
	})

	it("resolves by model id match (deepseek)", () => {
		expect(registry.resolve("deepseek-coder-1.3b", undefined).id).toBe("deepseek")
	})

	it("resolves by model id match (codegemma)", () => {
		expect(registry.resolve("codegemma-1.1-7b", undefined).id).toBe("codegemma")
	})

	it("falls back to 'instruct' for unknown models", () => {
		// `none` sends a bare prefix with no instruction, which a chat model reads
		// as nothing to do — the "it ignores my code" symptom. Nearly every model a
		// user can point this at is chat-tuned, so `instruct` is the safer default.
		expect(registry.resolve("gpt-4", undefined).id).toBe("instruct")
		expect(registry.resolve("some-unreleased-model-9000", undefined).id).toBe("instruct")
	})

	it("falls back to 'instruct' for undefined model id", () => {
		expect(registry.resolve(undefined, undefined).id).toBe("instruct")
	})

	it("honours an explicit override", () => {
		expect(registry.resolve("qwen2.5-coder", "deepseek").id).toBe("deepseek")
	})

	it("ignores 'auto' override and resolves by model id", () => {
		expect(registry.resolve("qwen2.5-coder", "auto").id).toBe("qwen")
	})

	it("falls back to model-id match when override is unknown", () => {
		// An unknown override id is treated as "auto" — resolve by model id.
		expect(registry.resolve("starcoder2", "auto").id).toBe("starcoder")
	})
})

describe("FIM template golden strings", () => {
	const templates = Object.fromEntries(FIM_TEMPLATES.map((t) => [t.id, t]))

	it("qwen renders prefix/suffix with control tokens", () => {
		expect(templates.qwen.render(P, S, [])).toBe(`<|fim_prefix|>${P}<|fim_suffix|>${S}<|fim_middle|>`)
	})

	it("starcoder renders with angle-bracket tokens", () => {
		expect(templates.starcoder.render(P, S, [])).toBe(`<fim_prefix>${P}<fim_suffix>${S}<fim_middle>`)
	})

	it("codestral renders suffix before prefix", () => {
		expect(templates.codestral.render(P, S, [])).toBe(`[SUFFIX]${S}[PREFIX]${P}`)
	})

	it("codellama renders with spaced tokens", () => {
		expect(templates.codellama.render(P, S, [])).toBe(`<PRE> ${P} <SUF>${S} <MID>`)
	})

	it("deepseek renders with full-width tokens", () => {
		expect(templates.deepseek.render(P, S, [])).toBe(`<｜fim▁begin｜>${P}<｜fim▁hole｜>${S}<｜fim▁end｜>`)
	})

	it("codegemma mirrors qwen markers", () => {
		expect(templates.codegemma.render(P, S, [])).toBe(`<|fim_prefix|>${P}<|fim_suffix|>${S}<|fim_middle|>`)
	})

	it("none renders prefix only", () => {
		expect(templates.none.render(P, S, [])).toBe(P)
	})
})

describe("renderSnippetPreamble", () => {
	it("returns empty string for no snippets", () => {
		expect(renderSnippetPreamble([])).toBe("")
	})

	it("joins snippet bodies with double newlines and a trailing pair", () => {
		const snippets: AutocompleteSnippet[] = [
			{ filePath: "a.ts", languageId: "typescript", line: 3, content: "const x = 1" },
			{ filePath: "b.ts", languageId: "typescript", line: 7, content: "const y = 2" },
		]

		expect(renderSnippetPreamble(snippets)).toBe("const x = 1\n\nconst y = 2\n\n")
	})

	it("prepends the preamble to the prefix in a native-FIM render", () => {
		const snippets: AutocompleteSnippet[] = [
			{ filePath: "a.ts", languageId: "typescript", line: 3, content: "const x = 1" },
		]

		const preamble = renderSnippetPreamble(snippets)

		expect(preamble + P).toBe("const x = 1\n\n" + P)
	})
})

describe("template stop sequences", () => {
	it("qwen includes fim_pad", () => {
		expect(FIM_TEMPLATES.find((t) => t.id === "qwen")!.stop).toContain("<|fim_pad|>")
	})

	it("deepseek includes fim end token", () => {
		expect(FIM_TEMPLATES.find((t) => t.id === "deepseek")!.stop).toContain("<｜fim▁end｜>")
	})

	it("none has no stop sequences", () => {
		expect(FIM_TEMPLATES.find((t) => t.id === "none")!.stop).toEqual([])
	})
})
describe("instruct template routing", () => {
	const registry = new FimTemplateRegistry()

	it.each([
		["lfm2.5-2.6b", "instruct"],
		["qwen2.5-coder-1.5b-instruct", "instruct"],
		["gemma-2-9b-it", "instruct"],
		["phi-4", "instruct"],
		["granite-3b-code", "instruct"],
	])("routes %s to the %s template", (modelId, expected) => {
		expect(registry.resolve(modelId, undefined).id).toBe(expected)
	})

	it("keeps base models on their FIM family template even when the family also matches instruct", () => {
		// `codegemma` would match the instruct `gemma-2` pattern; the -base guard
		// must keep it on its FIM template, or a FIM-capable model gets a prose prompt.
		expect(registry.resolve("codegemma:2b-base", undefined).id).toBe("codegemma")
		expect(registry.resolve("qwen2.5-coder:1.5b-base", undefined).id).toBe("qwen")
	})

	it("identifies base models", () => {
		expect(isBaseModel("qwen2.5-coder:1.5b-base")).toBe(true)
		expect(isBaseModel("starcoder2-3b-base")).toBe(true)
		expect(isBaseModel("lfm2.5-2.6b")).toBe(false)
	})

	it("reports which templates speak FIM", () => {
		const byId = (id: string) => FIM_TEMPLATES.find((t) => t.id === id)!

		expect(templateSupportsFim(byId("qwen"))).toBe(true)
		expect(templateSupportsFim(byId("codestral"))).toBe(true)
		expect(templateSupportsFim(byId("instruct"))).toBe(false)
		expect(templateSupportsFim(byId("none"))).toBe(false)
	})

	it("renders only the marked code, with no instruction text", () => {
		// The instruction lives in INSTRUCT_SYSTEM_PROMPT and is delivered as a
		// chat `system` message. Embedding it in the prompt string made the model
		// continue the *rules* — it echoed "Output ONLY the raw code..." as output.
		const rendered = FIM_TEMPLATES.find((t) => t.id === "instruct")!.render(P, S, [])

		expect(rendered).toBe(`${P}<CURSOR>${S}`)
		expect(rendered).not.toMatch(/output only/i)
		expect(rendered).not.toMatch(/do not/i)
	})

	it("keeps the instruction in a system prompt that forbids prose, fences and reasoning", () => {
		expect(INSTRUCT_SYSTEM_PROMPT).toMatch(/only/i)
		expect(INSTRUCT_SYSTEM_PROMPT).toMatch(/markdown fences/i)
		expect(INSTRUCT_SYSTEM_PROMPT).toMatch(/reasoning/i)
	})

	it("terminates the instruct turn", () => {
		const stop = FIM_TEMPLATES.find((t) => t.id === "instruct")!.stop

		expect(stop).toContain("<|im_end|>")
		expect(stop).toContain("```")
	})
})
