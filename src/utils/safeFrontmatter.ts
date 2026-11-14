import matter from "gray-matter"

/** Parse Markdown metadata without allowing document-selected executable engines. */
export function parseFrontmatter(content: string) {
	// gray-matter strips a leading BOM before detecting the opening delimiter.
	const normalized = content.replace(/^\uFEFF/, "")
	if (normalized.startsWith("---") && normalized[3] !== "-") {
		const { name } = matter.language(normalized)
		if (name && !["yaml", "yml", "json"].includes(name)) {
			throw new Error(`Unsupported frontmatter language: ${name}`)
		}
	}

	// Passing options also bypasses gray-matter's shared, input-only parse cache.
	return matter(content, { language: "yaml" })
}
