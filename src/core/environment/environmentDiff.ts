/**
 * Utilities for diffing environment details between turns to reduce token usage.
 *
 * On turn 1 we send everything. On turn 2+ we send only changed sections plus
 * any sections listed in ALWAYS_INCLUDE_SECTIONS.
 */

/**
 * Parses environment details string into named sections.
 * Sections start with "# SectionName" headers (single `#`, top-level only).
 * The content of each section includes any sub-headers (## ...) until the
 * next top-level `# ` header.
 */
export function parseEnvironmentSections(envDetails: string): Map<string, string> {
	const sections = new Map<string, string>()

	// Strip wrapping <environment_details> tags if present.
	const stripped = envDetails.replace(/^<environment_details>\s*/i, "").replace(/\s*<\/environment_details>$/i, "")

	// Split on lines that begin with exactly one `# ` (top-level headers).
	// We keep the delimiter via a positive lookahead so we can reconstruct content.
	const parts = stripped.split(/(?=^# )/m)

	for (const part of parts) {
		const trimmed = part.trim()
		if (!trimmed) {
			continue
		}

		// First line is the header, the rest is content.
		const newlineIdx = trimmed.indexOf("\n")
		if (newlineIdx === -1) {
			// Header with no body.
			const header = trimmed.replace(/^# /, "").trim()
			sections.set(header, "")
		} else {
			const header = trimmed.slice(0, newlineIdx).replace(/^# /, "").trim()
			const content = trimmed.slice(newlineIdx + 1)
			sections.set(header, content)
		}
	}

	return sections
}

/**
 * Sections that should ALWAYS be included even if unchanged.
 * These are cheap (few tokens) and the LLM frequently references them.
 */
export const ALWAYS_INCLUDE_SECTIONS = new Set(["Current Time", "Current Cost", "Current Mode", "REMINDERS"])

/**
 * Computes a diff between previous and current environment sections.
 *
 * Returns:
 * - `sections`: Map containing only changed sections + ALWAYS_INCLUDE_SECTIONS.
 *   On the first call (previous === null) all sections are returned.
 * - `wasFiltered`: true when at least one section was omitted.
 */
export function diffEnvironmentDetails(
	previous: Map<string, string> | null,
	current: Map<string, string>,
): { sections: Map<string, string>; wasFiltered: boolean } {
	// First turn — send everything.
	if (previous === null) {
		return { sections: new Map(current), wasFiltered: false }
	}

	const result = new Map<string, string>()
	let wasFiltered = false

	for (const [name, content] of current) {
		const alwaysInclude = ALWAYS_INCLUDE_SECTIONS.has(name)
		const changed = previous.get(name) !== content

		if (alwaysInclude || changed) {
			result.set(name, content)
		} else {
			wasFiltered = true
		}
	}

	return { sections: result, wasFiltered }
}

/**
 * Reassembles a sections map back into the `<environment_details>` string
 * format used by the agent.
 *
 * @param sections  The (possibly filtered) sections to include.
 * @param wasFiltered  When true, prepends an omission notice.
 */
export function assembleEnvironmentDetails(sections: Map<string, string>, wasFiltered: boolean): string {
	const parts: string[] = []

	if (wasFiltered) {
		parts.push(
			"(Unchanged environment sections omitted from this turn. Use tools to check current state if needed.)",
		)
	}

	for (const [name, content] of sections) {
		if (content) {
			parts.push(`# ${name}\n${content}`)
		} else {
			parts.push(`# ${name}`)
		}
	}

	return `<environment_details>\n${parts.join("\n\n")}\n</environment_details>`
}
