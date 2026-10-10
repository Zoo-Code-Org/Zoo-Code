/** Numeric constraints shared by runtime validation and the native tool schema. */
export const READ_FILE_NUMERIC_CONSTRAINTS = {
	offset: { type: "integer", minimum: 1 },
	limit: { type: "integer", minimum: 1 },
	anchor_line: { type: "integer", minimum: 1 },
	max_levels: { type: "integer", minimum: 0 },
	max_lines: { type: "integer", minimum: 1 },
} as const

export function validateReadFileNumber(
	name: keyof typeof READ_FILE_NUMERIC_CONSTRAINTS,
	value: unknown,
	minimum: number = READ_FILE_NUMERIC_CONSTRAINTS[name].minimum,
	allowUnset = true,
): string | undefined {
	// Strict provider schemas use null for omitted optional values.
	if (allowUnset && (value === undefined || value === null)) return undefined
	if (typeof value === "number" && Number.isInteger(value) && value >= minimum) return undefined
	if (minimum === 1 && (name === "offset" || name === "anchor_line")) {
		return `${name} must be a 1-indexed line number (got ${String(value)}). Line numbers start at 1 and must be positive integers.`
	}
	return `${name} must be a ${minimum === 0 ? "nonnegative" : "positive"} integer (got ${String(value)}).`
}

export function validateReadFileNumbers(params: {
	offset?: unknown
	limit?: unknown
	indentation?: { anchor_line?: unknown; max_levels?: unknown; max_lines?: unknown } | null
}): string | undefined {
	return (
		validateReadFileNumber("offset", params.offset, READ_FILE_NUMERIC_CONSTRAINTS.offset.minimum) ??
		validateReadFileNumber("limit", params.limit, READ_FILE_NUMERIC_CONSTRAINTS.limit.minimum) ??
		validateReadFileNumber(
			"anchor_line",
			params.indentation?.anchor_line,
			READ_FILE_NUMERIC_CONSTRAINTS.anchor_line.minimum,
		) ??
		validateReadFileNumber(
			"max_levels",
			params.indentation?.max_levels,
			READ_FILE_NUMERIC_CONSTRAINTS.max_levels.minimum,
		) ??
		validateReadFileNumber(
			"max_lines",
			params.indentation?.max_lines,
			READ_FILE_NUMERIC_CONSTRAINTS.max_lines.minimum,
		)
	)
}
