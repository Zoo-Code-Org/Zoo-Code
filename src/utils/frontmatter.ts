import matter from "gray-matter"

/** Parse untrusted metadata without allowing document-selected executable engines. */
export function parseFrontmatter(content: string) {
	// Match gray-matter's BOM normalization before inspecting its language marker.
	const normalized = content.replace(/^\uFEFF/, "")
	if (normalized.startsWith("---") && normalized[3] !== "-") {
		const { name } = matter.language(normalized.slice(3))
		if (name && !["yaml", "yml", "json"].includes(name)) {
			throw new Error(`Unsupported frontmatter language: ${name}`)
		}
	}

	// Passing options also bypasses gray-matter's cache of unrestricted parses.
	return matter(normalized, { language: "yaml" })
}
