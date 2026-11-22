/**
 * Quote untrusted text for one terminal line. JSON escapes C0 controls, backslash and quote.
 * The regex also escapes C1, format, default-ignorable, line-break and space-lookalike characters (Zs and U+2800), as UTF-16 units.
 * Sinks: every AskDispatcher handler, PromptManager timeout line, and the exitOnError stderr line.
 * Model: docs/architecture/tla/CommandApprovalDisplay.tla.
 */
export function toDisplayText(text: string): string {
	return JSON.stringify(text).replace(
		/[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2028\u2029\u2800]|(?! )\p{Zs}/gu,
		(character) =>
			character
				.split("")
				.map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
				.join(""),
	)
}
