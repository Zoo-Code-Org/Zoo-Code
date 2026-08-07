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
			// A known FIM family outranks an instruction-tuned marker. Publishers
			// ship FIM-trained models under `-instruct` tags — `codestral:22b-instruct`
			// and `qwen2.5-coder:7b-instruct` both retain their FIM control tokens —
			// so treating the tag as decisive routed genuinely FIM-capable models to
			// the chat path and silently discarded the suffix. Families are matched
			// first; `fimTemplate: "instruct"` is the escape hatch for the rare model
			// that carries a family name without the corresponding FIM training.
			const family = this.templates.find(
				(template) => template.id !== "none" && template.id !== "instruct" && template.matches.test(modelId),
			)

			if (family) {
				return family
			}

			// No family match. A base model genuinely wants raw continuation: it has
			// FIM training but none of our known token vocabularies, and the chat
			// prompt would only pollute the output.
			if (isBaseModel(modelId)) {
				const none = this.templates.find((template) => template.id === "none")

				if (none) {
					return none
				}
			}

			// Anything else falls through to the shared `instruct` default below.
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
 * A base model with no known family is sent down the raw-continuation path
 * rather than the chat path: it has FIM training, just not a vocabulary we
 * recognise.
 */
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
