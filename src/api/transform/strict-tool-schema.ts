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

// Literal-valued keywords carry instance data: a "$ref"-shaped string inside
// them is a value a caller asserts against, never a document location, so
// the relocation rewrite must not touch references there.
const LITERAL_VALUE_KEYWORDS = new Set(["const", "enum", "default", "examples"])

// One recorded oneOf relocation: the relaxed branches left
// `<path>/oneOf`, so a pointer naming the old location is rewritten to
// the location the branches now occupy (review 4725679725).
type RefRelocation = { oldPrefix: string; newPrefix: string }

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
 * Rewrites every local pointer that names a relocated oneOf location to the
 * location the branches occupy after the relaxation. Pointer matching is
 * segment-boundary exact, so "#/$defs/a" does not collide with a property
 * named with the same prefix, and the longest prefix applies first. Literal
 * values under const, enum, default and examples stay verbatim.
 */
function rewriteRelocatedRefs(node: unknown, relocations: RefRelocation[]): unknown {
	if (relocations.length === 0) {
		return node
	}
	if (Array.isArray(node)) {
		return node.map((entry) => rewriteRelocatedRefs(entry, relocations))
	}
	if (!isRecord(node)) {
		return node
	}
	const result: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(node)) {
		if (LITERAL_VALUE_KEYWORDS.has(key)) {
			result[key] = value
			continue
		}
		if (key === "$ref" && typeof value === "string" && value.startsWith("#/")) {
			let ref = value
			for (const relocation of [...relocations].sort((a, b) => b.oldPrefix.length - a.oldPrefix.length)) {
				const matches = ref === relocation.oldPrefix || ref.startsWith(`${relocation.oldPrefix}/`)
				if (matches) {
					ref = `${relocation.newPrefix}${ref.slice(relocation.oldPrefix.length)}`
				}
			}
			result[key] = ref
			continue
		}
		result[key] = rewriteRelocatedRefs(value, relocations)
	}
	return result
}

/**
 * Removes constraints that Anthropic and Bedrock reject for strict tool use.
 * Removed constraints are retained in descriptions so models can still follow them.
 * An unsupported additionalProperties value becomes false, because strict mode
 * requires additionalProperties: false on every object schema. A oneOf whose
 * alternatives lost their distinguishing constraints moves under anyOf, so
 * values that matched exactly one original alternative stay accepted, and
 * every pointer that named the old oneOf location is rewritten to the new
 * one (review 4725679725). A oneOf reached through a `not` keeps its
 * position: under anyOf the negated predicate would match every value and
 * the negation would reject values the original accepted (issue #547 review
 * 4719419437). The negation context carries through the schema-map keywords
 * too, so a oneOf under properties, $defs, definitions, patternProperties or
 * dependentSchemas inside a `not` keeps its position as well (round 7
 * outside-diff comment). A nested `not` flips the context back (negation
 * parity). A `not` whose own subtree lost a keyword is dropped outside a
 * negation context: the stripped branches match values the original
 * branches did not, and a retained negation would reject a value the
 * original accepted (review 4725679664) - the removal is recorded in the
 * description. A conditional whose if predicate lost a keyword keeps the
 * stripped predicate but loses its then/else branches outside a negation
 * context: the stripped predicate selects the other branch for values the
 * original rejected, and a retained branch would reject values the original
 * schema accepted (review 4725679729); a bare if asserts nothing, so the
 * retained predicate is annotation only.
 */
export function stripUnsupportedStrictKeywords(schema: unknown, insideNot = false): unknown {
	const relocations: RefRelocation[] = []
	const result = stripNode(schema, insideNot, "#", relocations)
	// A relocated oneOf's old pointer positions are gone from the document:
	// a reference naming one would dangle, so the surviving pointers are
	// rewritten once the whole strip has recorded every relocation.
	return rewriteRelocatedRefs(result, relocations)
}

function stripNode(schema: unknown, insideNot: boolean, path: string, relocations: RefRelocation[]): unknown {
	if (!isRecord(schema)) {
		return schema
	}

	const result: Record<string, unknown> = {}
	const removed: Record<string, unknown> = {}
	let relaxedOneOf: unknown[] | undefined
	const oneOfRelocated: { path: string }[] = []

	// The conditional decision is computed before the key loop so it cannot
	// depend on key order (the same single-compile rule the dialect
	// compiler applies, issue #547 review 4713747391).
	const compiledIf = isRecord(schema.if) ? stripNode(schema.if, insideNot, `${path}/if`, relocations) : undefined
	const conditionalStripped = compiledIf !== undefined && !deepEqualJson(compiledIf, schema.if)

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
				Object.entries(value).map(([name, subSchema]) => [
					name,
					stripNode(subSchema, insideNot, `${path}/${key}/${name}`, relocations),
				]),
			)
		} else if (key === "not" && isRecord(value)) {
			const childContext = !insideNot
			const strippedNot = stripNode(value, childContext, `${path}/not`, relocations)
			if (!insideNot && !deepEqualJson(strippedNot, value)) {
				// The negated subtree lost a keyword: the stripped branches
				// can match values the original branches did not, and the
				// retained negation would reject a value the original
				// accepted (review 4725679664). Dropping the negation is
				// the strictly relaxing direction; the whole original
				// subtree stays visible as the hint. Inside a negation
				// context the stripped subtree only widens, which relaxes
				// the enclosing negation - keep it.
				removed[key] = originalValue
				continue
			}
			value = strippedNot
		} else if (key === "if" && isRecord(value)) {
			if (conditionalStripped && !insideNot) {
				// The original predicate travels into the hint beside its
				// dropped branches (review 4725679729); the bare stripped
				// predicate stays below - it asserts nothing.
				removed[key] = originalValue
			}
			// value is schema.if; reuse the pre-computed strip instead of
			// stripping the predicate a second time.
			value = compiledIf
		} else if ((key === "then" || key === "else") && conditionalStripped && !insideNot) {
			// The stripped predicate selects the other branch for values
			// the original rejected: a retained branch would reject values
			// the original schema accepted (review 4725679729). The branch
			// travels into the hint beside the original predicate; the
			// bare predicate stays in place, because a bare if applies no
			// assertion. Inside a negation context the stripped branches
			// only widen the negated subtree, which relaxes the enclosing
			// negation - keep them.
			removed[key] = originalValue
			continue
		} else if (SCHEMA_LIST_KEYWORDS.has(key) && Array.isArray(value)) {
			const branches: unknown[] = value
			const childPath = `${path}/${key}`
			const stripped = branches.map((branch, index) =>
				stripNode(branch, insideNot, `${childPath}/${index}`, relocations),
			)
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
				// (issue #547 review 4716476955). The relocation is recorded
				// once the install below knows the new position.
				relaxedOneOf = stripped
				oneOfRelocated.push({ path })
				continue
			}
			value = stripped
		} else if (SCHEMA_VALUE_KEYWORDS.has(key)) {
			// Only `not` is a negative context: its subtree keeps a changed oneOf
			// in place, and a nested `not` flips the parity back (issue #547
			// review 4719419437).
			const childContext = insideNot
			value = Array.isArray(value)
				? value.map((entry, index) => stripNode(entry, childContext, `${path}/${key}/${index}`, relocations))
				: stripNode(value, childContext, `${path}/${key}`, relocations)
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
			// The branches now live one level deeper than the old oneOf
			// position: every pointer that named `<path>/oneOf` is
			// rewritten to the conjunct's anyOf (review 4725679725).
			const conjunctIndex = existing.length
			for (const relocation of oneOfRelocated) {
				relocations.push({
					oldPrefix: `${relocation.path}/oneOf`,
					newPrefix: `${relocation.path}/allOf/${conjunctIndex}/anyOf`,
				})
			}
		} else {
			result.anyOf = relaxedOneOf
			for (const relocation of oneOfRelocated) {
				relocations.push({
					oldPrefix: `${relocation.path}/oneOf`,
					newPrefix: `${relocation.path}/anyOf`,
				})
			}
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
