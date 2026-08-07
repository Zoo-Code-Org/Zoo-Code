import { UNIVERSAL_STOP_SEQUENCES, type ResolvedAutocompleteConfig } from "@roo-code/types"

import type { AutocompleteSnippet } from "../types"
import { FimTemplateRegistry, templateSupportsFim } from "./FimTemplateRegistry"
import { INSTRUCT_SYSTEM_PROMPT, type FimTemplate } from "./templates"
import { pruneSnippets, trimToTokenBudget } from "./tokenBudget"

export interface BuildPromptInput {
	readonly prefix: string
	readonly suffix: string
	readonly snippets: readonly AutocompleteSnippet[]
	readonly config: ResolvedAutocompleteConfig
}

export interface BuiltPrompt {
	/** The prefix sent to the endpoint (snippet preamble already prepended for native FIM). */
	readonly prefix: string
	readonly suffix: string
	/** The fully-rendered prompt used when the endpoint has no native FIM. */
	readonly renderedPrompt: string
	/** Stop sequences from the resolved template merged with the user's overrides. */
	readonly stopSequences: readonly string[]
	readonly promptChars: number
	/**
	 * False when the resolved template has no FIM control tokens (`instruct`/`none`).
	 * Handlers must send {@link BuiltPrompt.renderedPrompt} and omit `suffix` in that
	 * case — a suffix sent to a non-FIM model produces a free-running continuation.
	 */
	readonly supportsFim: boolean
	/** True when the model must be driven through the chat endpoint (instruction-tuned). */
	readonly useChatEndpoint: boolean
	/** System instruction for the chat path. */
	readonly systemPrompt?: string
	/** The resolved template id, for debug logging and telemetry. */
	readonly templateId: string
}

/**
 * Builds the FIM prompt for a single keystroke.
 *
 * Phase 2 is same-file only: the snippets array is always empty, so the prefix
 * and suffix are the windowed text around the cursor. The {@link FimTemplate}
 * decides whether the snippet preamble is prepended to the prefix (native FIM)
 * or folded into the rendered prompt (non-native fallback).
 */
export class PromptBuilder {
	private readonly registry: FimTemplateRegistry

	constructor(registry?: FimTemplateRegistry) {
		this.registry = registry ?? new FimTemplateRegistry()
	}

	build(input: BuildPromptInput): BuiltPrompt {
		const template = this.registry.resolve(input.config.modelId, input.config.fimTemplate)

		const prefix = trimToTokenBudget(input.prefix, input.config.maxPrefixTokens, "tail")
		const suffix = trimToTokenBudget(input.suffix, input.config.maxSuffixTokens, "head")
		const { snippets } = pruneSnippets(input.snippets, input.config.maxSnippetTokens)

		const stopSequences = mergeStopSequences(template, input.config.stopSequences)

		// Native-FIM endpoints take prefix+suffix as separate fields; the snippet
		// preamble is prepended to the prefix so it travels with the prompt context.
		// The preamble is newline-terminated so the last snippet line can never run
		// into the first prefix line — concatenated flush, the model reads foreign
		// code as contiguous with the cursor line and completes that instead.
		const preamble = template.renderSnippets(snippets)
		const nativePrefix = preamble && !preamble.endsWith("\n") ? `${preamble}\n${prefix}` : preamble + prefix
		const renderedPrompt = template.render(prefix, suffix, snippets)

		return {
			prefix: nativePrefix,
			suffix,
			renderedPrompt,
			stopSequences,
			promptChars: renderedPrompt.length,
			supportsFim: templateSupportsFim(template),
			useChatEndpoint: template.id === "instruct",
			systemPrompt: template.id === "instruct" ? INSTRUCT_SYSTEM_PROMPT : undefined,
			templateId: template.id,
		}
	}
}

/**
 * Merges template, universal and user stop sequences, de-duplicated.
 *
 * The universal set is non-negotiable: without it the `none` and `instruct`
 * templates contribute no terminator at all, so nothing ever stops the stream and
 * the model runs to `maxOutputTokens` emitting prose and reasoning blocks.
 *
 * Template stops come first because handlers that cap the list (the OpenAI
 * `/v1/completions` API accepts at most 4) must keep the family-specific tokens.
 */
function mergeStopSequences(template: FimTemplate, userStops: string[] | undefined): readonly string[] {
	const seen = new Set<string>()
	const merged: string[] = []

	for (const stop of [...template.stop, ...(userStops ?? []), ...UNIVERSAL_STOP_SEQUENCES]) {
		if (stop && !seen.has(stop)) {
			seen.add(stop)
			merged.push(stop)
		}
	}

	return merged
}

export { FimTemplateRegistry }
