import type { FimTemplateId } from "@roo-code/types"

import { FIM_TEMPLATES, type FimTemplate } from "./templates"

/**
 * Resolves the FIM template for a given model id, honouring an explicit override.
 *
 * Resolution order:
 * 1. An explicit override other than `"auto"` wins outright.
 * 2. Otherwise the first template whose {@link FimTemplate.matches} regexp tests
 *    the model id.
 * 3. Falls back to the `"none"` template (prefix only).
 */
export class FimTemplateRegistry {
	private readonly templates: readonly FimTemplate[]

	constructor(templates: readonly FimTemplate[] = FIM_TEMPLATES) {
		this.templates = templates
	}

	resolve(modelId: string | undefined, override: FimTemplateId | undefined): FimTemplate {
		if (override && override !== "auto") {
			const explicit = this.templates.find((template) => template.id === override)

			if (explicit) {
				return explicit
			}
		}

		if (modelId) {
			// An explicit instruction-tuned marker outranks the family name:
			// `qwen2.5-coder-1.5b-instruct` is a Qwen model, but it has no FIM
			// tokens, so routing it to the `qwen` template produces free-running
			// prose. A `-base` marker is the stronger signal in the other direction.
			if (!isBaseModel(modelId) && INSTRUCT_MARKER.test(modelId)) {
				const instruct = this.templates.find((template) => template.id === "instruct")

				if (instruct) {
					return instruct
				}
			}

			const skipInstruct = isBaseModel(modelId)

			// `none` matches /.*/ and sits last, so it would swallow every unknown
			// model here and pre-empt the deliberate `instruct` fallback below.
			const matched = this.templates.find(
				(template) =>
					template.id !== "none" &&
					(!skipInstruct || template.id !== "instruct") &&
					template.matches.test(modelId),
			)

			if (matched) {
				return matched
			}

			// A base model with no family match genuinely wants raw continuation:
			// it has FIM training but none of our known token vocabularies.
			if (skipInstruct) {
				const none = this.templates.find((template) => template.id === "none")

				if (none) {
					return none
				}
			}
		}

		// Unknown model. Default to `instruct` rather than `none`: the overwhelming
		// majority of models a user can point this at are chat/instruction-tuned,
		// and `none` sends them a bare prefix with no instruction at all — which
		// reads as the model ignoring the request entirely. `instruct` degrades
		// gracefully for a FIM model, whereas `none` fails outright for a chat one.
		return (
			this.templates.find((template) => template.id === "instruct") ?? this.templates[this.templates.length - 1]
		)
	}
}

/**
 * True when the model id advertises itself as a *base* (non-instruction-tuned)
 * model, e.g. `qwen2.5-coder:1.5b-base`.
 *
 * Base models are the FIM-capable variants, so they must never be routed to the
 * `instruct` template even when their family name also appears in an instruct
 * pattern.
 */
/**
 * An unambiguous instruction-tuned marker, which outranks any family match.
 *
 * Kept narrow on purpose: only suffixes that model publishers use to mean
 * "chat-tuned". Broader family patterns live on the `instruct` template itself
 * and are only consulted once no family template matches.
 */
const INSTRUCT_MARKER = /[-:_]?instruct\b|[-:_]it\b|[-:_]chat\b/i

export function isBaseModel(modelId: string): boolean {
	return /[-:_/]base\b|\bbase[-_]/i.test(modelId)
}

/**
 * True when the resolved template speaks fill-in-the-middle.
 *
 * `instruct` and `none` do not: for those, the endpoint must be sent the fully
 * rendered prompt rather than a `prefix`/`suffix` pair, because passing a suffix
 * to a model with no FIM tokens yields a free-running continuation.
 */
export function templateSupportsFim(template: FimTemplate): boolean {
	return template.id !== "instruct" && template.id !== "none"
}
