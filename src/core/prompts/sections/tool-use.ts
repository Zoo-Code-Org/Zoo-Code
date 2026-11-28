import type { EffectiveToolPolicy } from "../tools/effective-tool-policy"

export function getSharedToolUseSection(policy?: EffectiveToolPolicy): string {
	const completionGuidance =
		policy && !policy.tools.has("attempt_completion")
			? "A top-level task can finish with a plain-text answer when no tool is needed."
			: "A top-level task can finish with a plain-text answer when no tool is needed. Delegated tasks must use attempt_completion to return their result to the parent."
	return `====

TOOL USE

You have access to tools for actions and information gathering. Use the provider-native tool-calling mechanism. Do not include XML markup or examples. ${completionGuidance} Prefer calling as many tools as are reasonably needed in a single response to reduce back-and-forth and complete tasks faster.`
}
