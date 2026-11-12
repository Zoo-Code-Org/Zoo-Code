const UNSUPPORTED_STRICT_SCHEMA_KEYWORDS = new Set([
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"minLength",
	"maxLength",
	"maxItems",
	"uniqueItems",
	"contains",
	"minContains",
	"maxContains",
	"minProperties",
	"maxProperties",
])

const SUPPORTED_MIN_ITEMS = new Set<unknown>([0, 1])
const SUPPORTED_STRING_FORMATS = new Set<unknown>([
	"date-time",
	"time",
	"date",
	"duration",
	"email",
	"hostname",
	"uri",
	"ipv4",
	"ipv6",
	"uuid",
])

const SCHEMA_MAP_KEYWORDS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"])
const SCHEMA_LIST_KEYWORDS = new Set(["anyOf", "oneOf", "allOf", "prefixItems"])
const SCHEMA_VALUE_KEYWORDS = new Set([
	"items",
	"additionalItems",
	"unevaluatedItems",
	"unevaluatedProperties",
	"propertyNames",
	"not",
	"if",
	"then",
	"else",
])

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isUnsupportedKeyword(key: string, value: unknown): boolean {
	if (UNSUPPORTED_STRICT_SCHEMA_KEYWORDS.has(key)) {
		return true
	}
	if (key === "minItems") {
		return !SUPPORTED_MIN_ITEMS.has(value)
	}
	if (key === "format") {
		return !SUPPORTED_STRING_FORMATS.has(value)
	}
	if (key === "additionalProperties") {
		return value !== false
	}
	return false
}

/**
 * Removes constraints that Anthropic and Bedrock reject for strict tool use.
 * Removed constraints are retained in descriptions so models can still follow them.
 * An unsupported additionalProperties value becomes false, because strict mode
 * requires additionalProperties: false on every object schema.
 */
export function stripUnsupportedStrictKeywords(schema: unknown): unknown {
	if (!isRecord(schema)) {
		return schema
	}

	const result: Record<string, unknown> = {}
	const removed: Record<string, unknown> = {}

	for (const [key, originalValue] of Object.entries(schema)) {
		if (isUnsupportedKeyword(key, originalValue)) {
			removed[key] = originalValue
			if (key === "additionalProperties") {
				result[key] = false
			}
			continue
		}

		let value = originalValue
		if (SCHEMA_MAP_KEYWORDS.has(key) && isRecord(value)) {
			value = Object.fromEntries(
				Object.entries(value).map(([name, subSchema]) => [name, stripUnsupportedStrictKeywords(subSchema)]),
			)
		} else if (SCHEMA_LIST_KEYWORDS.has(key) && Array.isArray(value)) {
			value = value.map(stripUnsupportedStrictKeywords)
		} else if (SCHEMA_VALUE_KEYWORDS.has(key)) {
			value = Array.isArray(value)
				? value.map(stripUnsupportedStrictKeywords)
				: stripUnsupportedStrictKeywords(value)
		}
		result[key] = value
	}

	if (Object.keys(removed).length > 0) {
		const constraintNote = `Constraints: ${JSON.stringify(removed)}`
		result.description =
			typeof result.description === "string" && result.description.length > 0
				? `${result.description}\n\n${constraintNote}`
				: constraintNote
	}

	return result
}
