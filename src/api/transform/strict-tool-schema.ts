const UNSUPPORTED_STRICT_SCHEMA_KEYWORDS = new Set([
	"pattern",
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

/**
 * Structural equality for stripped-vs-original schema nodes: stripping
 * rebuilds nodes in input key order and appends a description only when it
 * removed keywords, so an unchanged node serializes identically.
 */
function deepEqualJson(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b)
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
 * requires additionalProperties: false on every object schema. A oneOf whose
 * alternatives lost their distinguishing constraints moves under anyOf, so
 * values that matched exactly one original alternative stay accepted. A oneOf
 * reached through a `not` keeps its position: under anyOf the negated
 * predicate would match every value and the negation would reject values the
 * original accepted (issue #547 review 4719419437). A nested `not` flips the
 * context back (negation parity).
 */
export function stripUnsupportedStrictKeywords(schema: unknown, insideNot = false): unknown {
	if (!isRecord(schema)) {
		return schema
	}

	const result: Record<string, unknown> = {}
	const removed: Record<string, unknown> = {}
	let relaxedOneOf: unknown[] | undefined

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
			const branches: unknown[] = value
			const stripped = branches.map((branch) => stripUnsupportedStrictKeywords(branch, insideNot))
			if (
				key === "oneOf" &&
				!insideNot &&
				stripped.some((branch, index) => !deepEqualJson(branch, branches[index]))
			) {
				// oneOf accepts exactly one alternative: stripping the
				// distinguishing constraints makes every value match several
				// branches and oneOf would accept nothing. The branches relax
				// under the overlap-safe anyOf position instead; each branch
				// keeps its removed constraints as the description hint
				// (issue #547 review 4716476955).
				relaxedOneOf = stripped
				continue
			}
			value = stripped
		} else if (SCHEMA_VALUE_KEYWORDS.has(key)) {
			// Only `not` is a negative context: its subtree keeps a changed oneOf
			// in place, and a nested `not` flips the parity back (issue #547
			// review 4719419437).
			const childContext = key === "not" ? !insideNot : insideNot
			value = Array.isArray(value)
				? value.map((entry) => stripUnsupportedStrictKeywords(entry, childContext))
				: stripUnsupportedStrictKeywords(value, childContext)
		}
		result[key] = value
	}

	if (relaxedOneOf) {
		// Sibling constraints apply together, never as alternatives: an
		// unchanged anyOf or allOf sibling stays where it is and the relaxed
		// branches become one separate allOf conjunct; with no sibling the
		// branches keep the anyOf position unchanged.
		const alternatives = { anyOf: relaxedOneOf }
		if (Array.isArray(result.anyOf) || Array.isArray(result.allOf)) {
			const existing = Array.isArray(result.allOf) ? (result.allOf as unknown[]) : []
			result.allOf = [...existing, alternatives]
		} else {
			result.anyOf = relaxedOneOf
		}
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
