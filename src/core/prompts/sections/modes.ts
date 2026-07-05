import * as vscode from "vscode"

import type { ModeConfig } from "@roo-code/types"

import { getAllModesWithPrompts, type Mode } from "../../../shared/modes"
import { ensureSettingsDirectoryExists } from "../../../utils/globalContext"

export async function getModesSection(context: vscode.ExtensionContext, activeMode?: Mode): Promise<string> {
	// Make sure path gets created
	await ensureSettingsDirectoryExists(context)

	// Get all modes with their overrides from extension state
	const allModes = await getAllModesWithPrompts(context)

	const modesContent = `====

MODES

- These are the currently available modes:
${allModes
	.map((mode: ModeConfig) => {
		let description: string
		if (mode.whenToUse && mode.whenToUse.trim() !== "") {
			// Use whenToUse as the primary description, indenting subsequent lines for readability
			description = mode.whenToUse.replace(/\n/g, "\n    ")
		} else {
			// Fallback to the first sentence of roleDefinition if whenToUse is not available
			description = mode.roleDefinition.split(".")[0]
		}
		return `  * "${mode.name}" mode (${mode.slug}) - ${description}`
	})
	.join("\n")}`

	// The concierge (collaborate mode) delegates to other modes as sub-agents. It needs each
	// candidate agent's `inputs` spec to compose a well-formed handoff brief — other modes don't
	// delegate this way, so they don't need the extra noise in their prompt.
	if (activeMode === "collaborate") {
		const delegatable = allModes.filter(
			(m: ModeConfig) => m.slug !== "collaborate" && m.inputs && m.inputs.trim() !== "",
		)

		if (delegatable.length > 0) {
			const handoffSpecs = delegatable
				.map(
					(m: ModeConfig) => `  * "${m.name}" (${m.slug}):\n    ${m.inputs!.trim().replace(/\n/g, "\n    ")}`,
				)
				.join("\n")

			return `${modesContent}

- Sub-agent handoff briefs: when you delegate to one of the agents above via \`new_task\`, compose the \`message\` following that agent's spec below. Always surface the brief conversationally before or while delegating — never delegate silently. Do not attempt the specialized task yourself when a matching agent exists.
${handoffSpecs}`
		}
	}

	return modesContent
}
