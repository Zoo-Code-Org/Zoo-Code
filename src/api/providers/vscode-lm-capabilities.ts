import * as vscode from "vscode"

import {
	type ModelInfo,
	openAiModelInfoSaneDefaults,
	vscodeLlmBaselineModelInfo,
	vscodeLlmModels,
} from "@roo-code/types"

import { canCreateImageParts } from "../transform/vscode-lm-image-part"

/** The model's `capabilities` object, read by name because the stable typings do not declare it. */
function reportedCapabilities(model: vscode.LanguageModelChat): object | undefined {
	const capabilities: unknown = Reflect.get(model, "capabilities")
	return typeof capabilities === "object" && capabilities !== null ? capabilities : undefined
}

/**
 * Vision as the host reports it.
 *
 * VS Code exposes this to consumers as `capabilities.supportsImageToText` (a proposed API surface,
 * `vscode.proposed.languageModelCapabilities`) and to providers as `capabilities.imageInput`. Both are
 * read by name because the stable typings declare neither; a host that reports neither yields `undefined`
 * so the caller can tell "unsupported" apart from "unknown".
 */
export function reportedImageSupport(model: vscode.LanguageModelChat): boolean | undefined {
	const capabilities = reportedCapabilities(model)
	if (!capabilities) {
		return undefined
	}
	for (const key of ["supportsImageToText", "imageInput"]) {
		const reported: unknown = Reflect.get(capabilities, key)
		if (typeof reported === "boolean") {
			return reported
		}
	}
	return undefined
}

/**
 * Tool calling as the host reports it.
 *
 * VS Code exposes this to consumers as `capabilities.supportsToolCalling` (same proposed surface as
 * vision) and to providers as `capabilities.toolCalling`, which may be a boolean or the number of tools
 * the model accepts. A number only answers "supported?" here: positive means yes, zero means no. Zoo
 * deliberately does not surface it as a per-model tool limit. Anything else yields `undefined`, so
 * "not reported" stays distinct from "unsupported".
 */
export function reportedToolSupport(model: vscode.LanguageModelChat): boolean | undefined {
	const capabilities = reportedCapabilities(model)
	if (!capabilities) {
		return undefined
	}
	for (const key of ["supportsToolCalling", "toolCalling"]) {
		const reported: unknown = Reflect.get(capabilities, key)
		if (typeof reported === "boolean") {
			return reported
		}
		if (typeof reported === "number" && Number.isFinite(reported)) {
			return reported > 0
		}
	}
	return undefined
}

/**
 * Derives Zoo's model info from what VS Code reports for a live model. The curated catalog only fills
 * gaps in everything but vision, and anything neither source states stays unset rather than guessed.
 */
export function getVsCodeLmModelInfo(model: vscode.LanguageModelChat): ModelInfo {
	const curated = vscodeLlmModels[model.family as keyof typeof vscodeLlmModels]
	const liveInputLimit =
		Number.isFinite(model.maxInputTokens) && model.maxInputTokens > 0
			? model.maxInputTokens
			: openAiModelInfoSaneDefaults.contextWindow
	const curatedInputLimit = curated?.maxInputTokens

	return {
		...vscodeLlmBaselineModelInfo,
		...curated,
		contextWindow:
			curatedInputLimit && curatedInputLimit > 0 ? Math.min(liveInputLimit, curatedInputLimit) : liveInputLimit,
		// A live model's vision is the host's word alone; unreported stays unset rather than borrowing the catalog's.
		supportsImages: canCreateImageParts() ? reportedImageSupport(model) : false,
		// Likewise tool calling: the curated catalog's `supportsToolCalling` is not a host report.
		supportsToolCalling: reportedToolSupport(model),
		supportsPromptCache: false,
		inputPrice: 0,
		outputPrice: 0,
	}
}
