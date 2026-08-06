import type { FimTemplateId } from "@roo-code/types"

import type { AutocompleteSnippet } from "../types"

/**
 * A FIM (fill-in-the-middle) template wraps the prefix/suffix in model-specific
 * control tokens so the model knows where the "hole" is.
 *
 * Endpoints with **native** FIM (Ollama, OpenAI-compatible `/v1/completions` with
 * `suffix`) accept `prefix` and `suffix` as separate fields and apply the
 * template server-side; for those we only need {@link renderSnippets} to build a
 * preamble of cross-file context, and {@link render} is used solely for the
 * non-native fallback path.
 */
export interface FimTemplate {
	readonly id: FimTemplateId
	/** Matches a model id against this template; first match wins. */
	readonly matches: RegExp
	/** Extra stop sequences specific to this model family. */
	readonly stop: readonly string[]
	/** Renders the full prompt when the endpoint has no native FIM support. */
	render(prefix: string, suffix: string, snippets: readonly AutocompleteSnippet[]): string
	/** Renders a preamble of snippets prepended to the prefix for native-FIM endpoints. */
	renderSnippets(snippets: readonly AutocompleteSnippet[]): string
}

/** Joins snippet bodies into a compact preamble; empty when there are no snippets. */
function renderSnippetPreamble(snippets: readonly AutocompleteSnippet[]): string {
	if (snippets.length === 0) {
		return ""
	}

	const bodies = snippets.map((snippet) => snippet.content).join("\n\n")
	return `${bodies}\n\n`
}

/** A template that only emits the prefix (no suffix wrapping). */
const prefixOnly = (preamble: string) => (prefix: string) => `${preamble}${prefix}`

/**
 * Chat-turn terminators. An instruct model served over `/v1/completions` receives
 * a raw prompt, so the server applies no chat template and nothing terminates the
 * turn — these do.
 */
const INSTRUCT_STOP: readonly string[] = ["<|im_end|>", "<|eot_id|>", "<|end|>", "</s>", "<|endoftext|>", "```"]

/** Templates resolved from the model id; order matters — first match wins. */
export const FIM_TEMPLATES: readonly FimTemplate[] = [
	{
		id: "qwen",
		matches: /qwen|codeqwen/i,
		stop: ["<|endoftext|>", "<|fim_pad|>"],
		render: (prefix, suffix, snippets) =>
			`${renderSnippetPreamble(snippets)}<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`,
		renderSnippets: renderSnippetPreamble,
	},
	{
		id: "starcoder",
		matches: /starcoder|stable-?code/i,
		stop: ["<|endoftext|>"],
		render: (prefix, suffix, snippets) =>
			`${renderSnippetPreamble(snippets)}<fim_prefix>${prefix}<fim_suffix>${suffix}<fim_middle>`,
		renderSnippets: renderSnippetPreamble,
	},
	{
		id: "codestral",
		matches: /codestral|mistral/i,
		stop: ["[PREFIX]", "[SUFFIX]", "[MIDDLE]"],
		render: (prefix, suffix, snippets) => `${renderSnippetPreamble(snippets)}[SUFFIX]${suffix}[PREFIX]${prefix}`,
		renderSnippets: renderSnippetPreamble,
	},
	{
		id: "codellama",
		matches: /codellama/i,
		stop: ["<PRE>", "<SUF>", "<MID>"],
		render: (prefix, suffix, snippets) => `${renderSnippetPreamble(snippets)}<PRE> ${prefix} <SUF>${suffix} <MID>`,
		renderSnippets: renderSnippetPreamble,
	},
	{
		id: "deepseek",
		matches: /deepseek/i,
		stop: ["<｜fim▁end｜>", "<｜begin▁of▁sentence｜>", "<｜end▁of▁sentence｜>"],
		render: (prefix, suffix, snippets) =>
			`${renderSnippetPreamble(snippets)}<｜fim▁begin｜>${prefix}<｜fim▁hole｜>${suffix}<｜fim▁end｜>`,
		renderSnippets: renderSnippetPreamble,
	},
	{
		id: "codegemma",
		matches: /codegemma/i,
		stop: ["<|endoftext|>", "<|file_separator|>"],
		render: (prefix, suffix, snippets) =>
			`${renderSnippetPreamble(snippets)}<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`,
		renderSnippets: renderSnippetPreamble,
	},
	{
		id: "instruct",
		// Instruction-tuned models have no FIM control tokens. Matching them here
		// (before the `none` catch-all) keeps them off the raw-continuation path,
		// which is what produces prose, commentary and reasoning blocks instead of
		// code. Base variants are excluded by `isBaseModel` in the registry, since
		// a `-base` suffix means the model *is* FIM-capable.
		matches: /(lfm|instruct|-it\b|chat|phi-?[34]|llama-?3|gemma-?[23]|mistral-?nemo|granite|smol)/i,
		stop: INSTRUCT_STOP,
		render: (prefix, suffix, snippets) => renderInstructPrompt(prefix, suffix, snippets),
		renderSnippets: renderSnippetPreamble,
	},
	{
		id: "none",
		matches: /.*/,
		stop: [],
		render: (prefix, _suffix, snippets) => prefixOnly(renderSnippetPreamble(snippets))(prefix),
		renderSnippets: renderSnippetPreamble,
	},
]

/**
 * System instruction for the chat path.
 *
 * This must never be concatenated into a `/v1/completions` prompt. That endpoint
 * is a pure continuation API with no notion of instructions, so a model handed
 * this text simply continues *it* — echoing the rules back as if they were the
 * code. It only works as a `system` message on `/v1/chat/completions`, where the
 * server's chat template marks it as out-of-band.
 */
export const INSTRUCT_SYSTEM_PROMPT =
	"You are a code completion engine inside an editor. " +
	"The user sends code with a <CURSOR> marker. " +
	"Reply with ONLY the raw code that belongs at <CURSOR> — no explanation, no commentary, " +
	"no markdown fences, no reasoning, and no repetition of the code around the cursor. " +
	// Locality is the instruction that matters most. Without it these models answer
	// the *task* they infer from the surrounding code — emitting whole scripts,
	// re-declaring functions that already exist, and appending example usage.
	"Complete only what belongs at the cursor: usually the rest of the current line, " +
	"or the current block. Never write a whole file, never redefine something that " +
	"already exists above, and never add example usage or a main block. " +
	"Use only names that are already imported or defined in the code you were shown. " +
	"If nothing should be inserted, reply with nothing."

/**
 * Renders the user turn for the chat path: the code, marked at the cursor.
 *
 * Carries no instructions of its own — those live in {@link INSTRUCT_SYSTEM_PROMPT}
 * — so that if a model does echo its input, it echoes code rather than prose.
 */
function renderInstructPrompt(prefix: string, suffix: string, snippets: readonly AutocompleteSnippet[]): string {
	const code = `${prefix}<CURSOR>${suffix}`

	if (snippets.length === 0) {
		return code
	}

	// Context is labelled and separated from the file under edit. Without the
	// separation a chat model treats the snippets as more code to continue and
	// completes *those* instead of the cursor line.
	return `Context from the project (for reference only, do not complete this):\n${renderSnippetPreamble(snippets).trimEnd()}\n\nFile being edited — complete at <CURSOR>:\n${code}`
}

export { renderSnippetPreamble }
