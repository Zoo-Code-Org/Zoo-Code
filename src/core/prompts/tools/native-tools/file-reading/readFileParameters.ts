import { DEFAULT_LINE_LIMIT } from "../../../../tools/file-reading/readFileConstants"

export interface ReadFileParameterSchema {
	type: string | string[]
	properties?: Record<string, ReadFileParameterSchema>
	required?: string[]
	enum?: Array<string | null>
	[key: string]: unknown
}

function requireNullableOptionalFields(schema: ReadFileParameterSchema): ReadFileParameterSchema {
	const required = new Set(schema.required ?? [])
	const properties = Object.fromEntries(
		Object.entries(schema.properties ?? {}).map(([name, property]) => {
			const nested = property.type === "object" ? requireNullableOptionalFields(property) : { ...property }
			if (required.has(name)) return [name, nested]
			return [
				name,
				{
					...nested,
					type: [...(Array.isArray(property.type) ? property.type : [property.type]), "null"],
					...(nested.enum ? { enum: [...nested.enum, null] } : {}),
				},
			]
		}),
	)
	return { ...schema, properties, required: Object.keys(properties), additionalProperties: false }
}

/** Fresh per-file parameter schema, independent of either tool's name or description. */
export function createReadFileParameters({ strictOptionalFields = false } = {}): ReadFileParameterSchema {
	const indentationProperties: Record<string, ReadFileParameterSchema> = {
		anchor_line: {
			type: "integer",
			description:
				"1-based line number to anchor the extraction. REQUIRED for meaningful indentation mode results. The extractor finds the semantic block (function, method, class) containing this line and returns it completely. Without anchor_line, indentation mode defaults to line 1 and returns only imports/header content. Obtain anchor_line from: search results, error stack traces, definition lookups, codebase_search results, or condensed file summaries (e.g., '14--28 | export class UserService' means anchor_line=14).",
		},
		max_levels: {
			type: "integer",
			description:
				"Maximum indentation levels to include above the anchor (indentation mode, 0 = unlimited (default)). Higher values include more parent context.",
		},
		include_siblings: {
			type: "boolean",
			description:
				"Include sibling blocks at the same indentation level as the anchor block (indentation mode, default: false). Useful for seeing related methods in a class.",
		},
		include_header: {
			type: "boolean",
			description:
				"Include file header content (imports, module-level comments) at the top of output (indentation mode, default: true).",
		},
		max_lines: {
			type: "integer",
			description:
				"Hard cap on lines returned for indentation mode. Acts as a separate limit from the top-level 'limit' parameter.",
		},
	}
	const schema: ReadFileParameterSchema = {
		type: "object",
		properties: {
			path: { type: "string", description: "Path to the file to read, relative to the workspace" },
			mode: {
				type: "string",
				enum: ["slice", "indentation"],
				description:
					"Reading mode. 'slice' (default): read lines sequentially with offset/limit - use for general file exploration or when you don't have a target line number (may truncate code mid-function). 'indentation': extract complete semantic code blocks containing anchor_line - PREFERRED when you have a line number because it guarantees complete, valid code blocks. WARNING: Do not use indentation mode without specifying indentation.anchor_line, or you will only get header content.",
			},
			offset: {
				type: "integer",
				description: "1-based line offset to start reading from (slice mode, default: 1)",
			},
			limit: {
				type: "integer",
				description: `Maximum number of lines to return (slice mode, default: ${DEFAULT_LINE_LIMIT})`,
			},
			indentation: {
				type: "object",
				description:
					"Indentation mode options. Only used when mode='indentation'. You MUST specify anchor_line for useful results - it determines which code block to extract.",
				properties: indentationProperties,
				required: [],
				additionalProperties: false,
			},
		},
		required: ["path"],
		additionalProperties: false,
	}
	return strictOptionalFields ? requireNullableOptionalFields(schema) : schema
}
