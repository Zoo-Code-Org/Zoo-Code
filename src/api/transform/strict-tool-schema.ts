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
// the relocation rewrite must not touch references there. The rule applies
// at SCHEMA positions only: inside properties, $defs and the other
// name-to-schema maps the keys are names, so a property named "const" is a
// schema and its references are relocated like any other (review
// 4726104168).
const LITERAL_VALUE_KEYWORDS = new Set(["const", "enum", "default", "examples"])

// One recorded oneOf relocation: the relaxed branches left
// `<path>/oneOf`, so a pointer naming the old location is rewritten to
// the location the branches now occupy (review 4725679725).
type RefRelocation = { oldPrefix: string; newPrefix: string }

// Facts the strip pass accumulates across the whole document: the recorded
// oneOf relocations and the decoded pointer paths of every node whose
// stripped form differs from its input. A "$ref" applies its target schema
// at validation time, so a predicate whose own object is unchanged can
// still tighten when a reached target changed (review 4726104174). The
// measuring pass runs first with every reference-aware decision kept, and
// the deciding pass consults its complete sets - document order makes the
// running set incomplete for decisions (a predicate under properties can
// reach a target under $defs that strips later in the same walk).
type StripFacts = {
	relocations: RefRelocation[]
	changedPaths: string[][]
	measuredChangedPaths?: string[][]
	measuredRelocations?: RefRelocation[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

// JSON Pointer (RFC 6901) escapes "~" as "~0" and "/" as "~1": a recorded
// relocation prefix must be written the same way a reference in the
// document names the location, or the prefix never matches (review
// 4726104169).
function escapePointerToken(token: string): string {
	return token.replace(/~/g, "~0").replace(/\//g, "~1")
}

// Splits a "#/..." pointer into decoded segments. Percent-escapes decode
// first, then the "~" escapes, so a definition named "A/B" matches the
// reference "#/$defs/A~1B" and a name with a space matches "A%20B". A
// malformed percent-escape keeps the raw segment.
function decodePointerSegments(ref: string): string[] | undefined {
	if (!ref.startsWith("#/")) {
		return undefined
	}
	const segments: string[] = []
	for (const rawSegment of ref.slice(2).split("/")) {
		let decoded = rawSegment
		try {
			decoded = decodeURIComponent(rawSegment)
		} catch {
			decoded = rawSegment
		}
		segments.push(decoded.replace(/~1/g, "/").replace(/~0/g, "~"))
	}
	return segments
}

// The strip pass builds document paths from the same escaped tokens, so a
// recorded path decodes with the same rule; the root path is "#".
function decodePathSegments(path: string): string[] {
	if (path === "#") {
		return []
	}
	return decodePointerSegments(path) ?? []
}

// The inverse of decodePointerSegments for one segment: JSON Pointer "~"
// escapes apply to the decoded name, percent-encoding applies to the wire
// form, so encoding un-escapes in the opposite order (RFC 6901 section 6).
// Characters that are legal in a URI fragment stay raw (A-Za-z0-9 and the
// RFC 3986 sub-delims plus ":@"), so plain names emit unchanged; "%",
// whitespace, "#", quotes and non-ASCII are percent-encoded so the
// decoder's decodeURIComponent round-trips the original name
// (review 4726391009).
function encodePointerSegment(segment: string): string {
	const escaped = segment.replace(/~/g, "~0").replace(/\//g, "~1")
	return escaped.replace(/[^A-Za-z0-9\-._~!$&'()*+,;=:@]/gu, (ch) => {
		try {
			return encodeURIComponent(ch)
		} catch {
			// A lone surrogate cannot be percent-encoded; it stays raw and
			// the decoder's malformed-escape fallback keeps it verbatim.
			return ch
		}
	})
}

// True when refSegments names relocation's old location or a position under
// it: both sides arrive decoded, so a reference written percent-encoded
// ("#/$defs/A%20B/oneOf/0") matches a recorded prefix that carries the raw
// name (review 4726391009).
function relocationMatches(refSegments: string[], oldSegments: string[]): boolean {
	if (refSegments.length < oldSegments.length) {
		return false
	}
	return oldSegments.every((segment, index) => refSegments[index] === segment)
}

/**
 * Explicit own-property creation: a schema key like "__proto__" (legal in
 * JSON and produced by JSON.parse as an own property) must become an own
 * data property of the rebuilt copy, never a prototype change - a plain
 * assignment invokes the inherited setter and silently drops the entry
 * (review 4726391002).
 */
function defineOwnKey(target: Record<string, unknown>, key: string, value: unknown): void {
	Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}

// Whether a subtree evaluates object keys through properties or
// patternProperties rules: a dropped conditional branch that did takes
// those evaluations with it, so a retained unevaluatedProperties rule at
// the conditional's level would forbid a value the original accepted
// (review 4726391005).
function carriesPropertyEvaluation(value: unknown, seen: Set<unknown> = new Set()): boolean {
	if (Array.isArray(value)) {
		return value.some((entry) => carriesPropertyEvaluation(entry, seen))
	}
	if (!isRecord(value) || seen.has(value)) {
		return false
	}
	seen.add(value)
	if ("properties" in value || "patternProperties" in value) {
		return true
	}
	return Object.values(value).some((entry) => carriesPropertyEvaluation(entry, seen))
}

// True when one decoded path equals the other or sits inside it: a
// reference is affected by a change at its own location or at any
// ancestor or descendant of it.
function segmentsOverlap(a: string[], b: string[]): boolean {
	const shared = Math.min(a.length, b.length)
	for (let index = 0; index < shared; index++) {
		if (a[index] !== b[index]) {
			return false
		}
	}
	return true
}

function entersSchemaMap(key: string, value: unknown): boolean {
	return SCHEMA_MAP_KEYWORDS.has(key) && isRecord(value)
}

// Collects every local "$ref" pointer mentioned anywhere inside a subtree,
// visiting schema positions only: a "$ref" inside a literal-valued keyword
// is the asserted value, not a reference, and an entry named after a
// literal keyword inside a name-to-schema map still carries a schema
// (review 4726104168).
function collectLocalRefs(value: unknown, insideSchemaMap: boolean, out: string[]): void {
	if (Array.isArray(value)) {
		for (const entry of value) {
			collectLocalRefs(entry, insideSchemaMap, out)
		}
		return
	}
	if (!isRecord(value)) {
		return
	}
	if (typeof value.$ref === "string") {
		out.push(value.$ref)
	}
	for (const [key, entry] of Object.entries(value)) {
		if (!insideSchemaMap && LITERAL_VALUE_KEYWORDS.has(key)) {
			continue
		}
		collectLocalRefs(entry, insideSchemaMap ? false : entersSchemaMap(key, entry), out)
	}
}

// True when the reference points at a changed location: its target moved
// under a recorded relocation or a changed node sits at, above or below
// the target (review 4726104174).
function refReachesChangedTarget(ref: string, facts: StripFacts): boolean {
	const segments = decodePointerSegments(ref)
	if (segments === undefined) {
		return false
	}
	const changedPaths = facts.measuredChangedPaths ?? facts.changedPaths
	const relocations = facts.measuredRelocations ?? facts.relocations
	for (const changed of changedPaths) {
		if (segmentsOverlap(segments, changed)) {
			return true
		}
	}
	for (const relocation of relocations) {
		if (segmentsOverlap(segments, decodePathSegments(relocation.oldPrefix))) {
			return true
		}
	}
	return false
}

function subtreeReachesChangedTarget(value: unknown, facts: StripFacts): boolean {
	const refs: string[] = []
	collectLocalRefs(value, false, refs)
	return refs.some((ref) => refReachesChangedTarget(ref, facts))
}

// Resolves decoded pointer segments against a document root.
function resolvePointerSegments(root: unknown, segments: string[]): boolean {
	let node: unknown = root
	for (const segment of segments) {
		if (Array.isArray(node)) {
			if (!/^(0|[1-9][0-9]*)$/.test(segment) || Number(segment) >= node.length) {
				return false
			}
			node = node[Number(segment)]
			continue
		}
		if (!isRecord(node) || !Object.prototype.hasOwnProperty.call(node, segment)) {
			return false
		}
		node = node[segment]
	}
	return true
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
 * location the branches occupy after the relaxation. Matching compares
 * DECODED pointer segments, so a reference written percent-encoded matches
 * the same location a raw name records, and the rewritten pointer is
 * re-encoded per segment (review 4726391009). Matching is segment-boundary
 * exact, so "#/$defs/a" does not collide with a property named with the
 * same prefix, and the longest prefix applies first - relocations arrive
 * pre-sorted once per strip. Literal values under const, enum, default and
 * examples stay verbatim at schema positions; entries of a name-to-schema
 * map are schemas and their references relocate with everything else
 * (review 4726104168).
 */
function rewriteRelocatedRefs(node: unknown, relocations: RefRelocation[], insideSchemaMap = false): unknown {
	if (relocations.length === 0) {
		return node
	}
	if (Array.isArray(node)) {
		return node.map((entry) => rewriteRelocatedRefs(entry, relocations, insideSchemaMap))
	}
	if (!isRecord(node)) {
		return node
	}
	const result: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(node)) {
		if (!insideSchemaMap && LITERAL_VALUE_KEYWORDS.has(key)) {
			defineOwnKey(result, key, value)
			continue
		}
		if (key === "$ref" && typeof value === "string" && value.startsWith("#/")) {
			let ref = value
			const refSegments = decodePointerSegments(ref)
			if (refSegments !== undefined) {
				for (const relocation of relocations) {
					const oldSegments = decodePathSegments(relocation.oldPrefix)
					if (!relocationMatches(refSegments, oldSegments)) {
						continue
					}
					// The new location's decoded segments plus the
					// untouched decoded tail, re-encoded as a fragment:
					// the pointer keeps naming the same target constraint
					// after the move (review 4726391009).
					const newSegments = [
						...decodePathSegments(relocation.newPrefix),
						...refSegments.slice(oldSegments.length),
					]
					ref = `#/${newSegments.map(encodePointerSegment).join("/")}`
					break
				}
			}
			defineOwnKey(result, key, ref)
			continue
		}
		defineOwnKey(
			result,
			key,
			rewriteRelocatedRefs(value, relocations, insideSchemaMap ? false : entersSchemaMap(key, value)),
		)
	}
	return result
}

/**
 * Every surviving local pointer must name a location the emitted schema
 * still has. Stripping removes whole subtrees (a changed `not`, the
 * branches of a changed conditional, an unsupported `contains`), and a
 * pointer naming a removed location would dangle - the oneOf relocation
 * rewrite cannot repair a deletion (review 4726104178). A pointer that
 * resolved in the declared schema but resolves nowhere in the stripped
 * document is dropped: the node keeps its remaining keywords and records
 * the repair in its description. Inlining the removed target is not an
 * option - its stripped form does not exist (the branch was never
 * stripped) or would re-tighten the referencing position - and keeping its
 * original form would ship the forbidden keyword the strict endpoint
 * rejects, so the maximally permissive empty schema is the only
 * relaxation-only repair. A pointer that never resolved in the declared
 * schema was already broken and stays untouched.
 */
function inlineUnresolvableRefs(
	node: unknown,
	strippedRoot: unknown,
	declaredRoot: unknown,
	insideSchemaMap = false,
): unknown {
	if (Array.isArray(node)) {
		return node.map((entry) => inlineUnresolvableRefs(entry, strippedRoot, declaredRoot, insideSchemaMap))
	}
	if (!isRecord(node)) {
		return node
	}
	const result: Record<string, unknown> = {}
	let droppedRef: string | undefined
	for (const [key, value] of Object.entries(node)) {
		if (!insideSchemaMap && LITERAL_VALUE_KEYWORDS.has(key)) {
			result[key] = value
			continue
		}
		if (!insideSchemaMap && key === "$ref" && typeof value === "string" && value.startsWith("#/")) {
			const segments = decodePointerSegments(value)
			const brokenByStrip =
				segments !== undefined &&
				!resolvePointerSegments(strippedRoot, segments) &&
				resolvePointerSegments(declaredRoot, segments)
			if (brokenByStrip) {
				droppedRef = value
				continue
			}
			result[key] = value
			continue
		}
		// Own-property creation: a schema key like "__proto__" must stay an
		// own data property of the rebuilt copy - a plain assignment
		// invokes the inherited setter and silently drops the entry
		// (review 4726391002).
		defineOwnKey(
			result,
			key,
			inlineUnresolvableRefs(
				value,
				strippedRoot,
				declaredRoot,
				insideSchemaMap ? false : entersSchemaMap(key, value),
			),
		)
	}
	if (droppedRef !== undefined) {
		const note = `Unresolvable reference ${droppedRef} removed (its target was stripped)`
		result.description =
			typeof result.description === "string" && result.description.length > 0
				? `${result.description}\n\n${note}`
				: note
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
 * retained predicate is annotation only. A dropped branch that evaluated
 * keys through its properties or patternProperties rules relaxes a
 * retained unevaluatedProperties rule, which would otherwise forbid a
 * value the original accepted (review 4726391005).
 */
export function stripUnsupportedStrictKeywords(schema: unknown, insideNot = false): unknown {
	// Pass one measures: the same strip with every reference-aware decision
	// kept, so the changed-path set is complete before any decision is made.
	const measured: StripFacts = { relocations: [], changedPaths: [] }
	stripNode(schema, insideNot, "#", measured)
	const facts: StripFacts = {
		relocations: [],
		changedPaths: [],
		measuredChangedPaths: measured.changedPaths,
		measuredRelocations: measured.relocations,
	}
	const result = stripNode(schema, insideNot, "#", facts)
	// A relocated oneOf's old pointer positions are gone from the document:
	// a reference naming one would dangle, so the surviving pointers are
	// rewritten once the whole strip has recorded every relocation.
	const rewritten = rewriteRelocatedRefs(
		result,
		// The rewrite matches decoded segments with the longest decoded
		// prefix first: one sort per strip, not per reference
		// (reviews 4726391009, 4726390984).
		[...facts.relocations]
			.map((relocation, index) => ({ relocation, depth: decodePathSegments(relocation.oldPrefix).length, index }))
			.sort((a, b) => b.depth - a.depth || a.index - b.index)
			.map((entry) => entry.relocation),
	)
	// The relocation rewrite repairs pointers into moved rules; pointers
	// into REMOVED subtrees need their own repair pass (review 4726104178).
	// Nothing was removed when no node changed, so an unchanged document
	// returns untouched.
	return facts.changedPaths.length === 0 ? rewritten : inlineUnresolvableRefs(rewritten, rewritten, schema)
}

function stripNode(schema: unknown, insideNot: boolean, path: string, facts: StripFacts): unknown {
	if (!isRecord(schema)) {
		return schema
	}
	// The measuring pass (no measured sets attached) keeps every
	// reference-aware form; the deciding pass consults the measured sets.
	const deciding = facts.measuredChangedPaths !== undefined

	const result: Record<string, unknown> = {}
	const removed: Record<string, unknown> = {}
	let relaxedOneOf: unknown[] | undefined
	const oneOfRelocated: { path: string }[] = []

	// The conditional decision is computed before the key loop so it cannot
	// depend on key order (the same single-compile rule the dialect
	// compiler applies, issue #547 review 4713747391). A predicate that
	// only references schemas applies its targets at validation time, so a
	// changed target behind its $refs selects the other branch exactly like
	// a directly stripped predicate does (review 4726104174).
	const compiledIf = isRecord(schema.if) ? stripNode(schema.if, insideNot, `${path}/if`, facts) : undefined
	// Drop decisions that can depend on a $ref-reached change are made AFTER
	// the key loop: a predicate under properties can reach a target under
	// $defs that strips later in the same loop, and the changed-path set is
	// only complete once every key has been visited (review 4726104174).
	const pendingNotDrops: { key: string; original: unknown; stripped: unknown }[] = []
	const conditionalBranches: { key: string; original: unknown }[] = []
	let ifOriginal: unknown
	let hasIf = false
	let pendingOneOf: { original: unknown[]; stripped: unknown[] } | undefined

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
					stripNode(subSchema, insideNot, `${path}/${key}/${escapePointerToken(name)}`, facts),
				]),
			)
		} else if (key === "not" && isRecord(value)) {
			const childContext = !insideNot
			const strippedNot = stripNode(value, childContext, `${path}/not`, facts)
			if (insideNot) {
				// Inside a negation context the stripped subtree only
				// widens, which relaxes the enclosing negation - keep it.
				value = strippedNot
			} else {
				// The drop decision is made after the key loop: a predicate
				// that only references schemas can reach a target stripping
				// later in the same loop (review 4726104174). The
				// placeholder keeps the key order stable for the
				// changed-path recording.
				result[key] = originalValue
				pendingNotDrops.push({ key, original: originalValue, stripped: strippedNot })
				continue
			}
		} else if (key === "if" && isRecord(value)) {
			// value is schema.if; reuse the pre-computed strip instead of
			// stripping the predicate a second time. The hint decision is
			// made after the key loop, when the changed-path set is
			// complete (review 4726104174).
			value = compiledIf
			ifOriginal = originalValue
			hasIf = true
		} else if (SCHEMA_LIST_KEYWORDS.has(key) && Array.isArray(value)) {
			const branches: unknown[] = value
			const childPath = `${path}/${key}`
			const stripped = branches.map((branch, index) =>
				stripNode(branch, insideNot, `${childPath}/${index}`, facts),
			)
			const branchesStripped = stripped.some((branch, index) => !deepEqualJson(branch, branches[index]))
			if (key === "oneOf" && !insideNot) {
				if (branchesStripped) {
					// oneOf accepts exactly one alternative: stripping the
					// distinguishing constraints makes every value match
					// several branches and oneOf would accept nothing. The
					// branches relax under the overlap-safe anyOf position
					// instead; each branch keeps its removed constraints as
					// the description hint (issue #547 review 4716476955).
					// The relocation is recorded once the install below
					// knows the new position.
					relaxedOneOf = stripped
					oneOfRelocated.push({ path })
					continue
				}
				// The branch objects are unchanged, but a branch that only
				// references schemas applies its targets at validation
				// time: whether a reached target changed is decided after
				// the key loop, when the changed-path set is complete
				// (review 4726104174).
				pendingOneOf = { original: branches, stripped }
				result[key] = value
				continue
			}
			value = stripped
		} else if (SCHEMA_VALUE_KEYWORDS.has(key)) {
			// Only `not` is a negative context: its subtree keeps a changed oneOf
			// in place, and a nested `not` flips the parity back (issue #547
			// review 4719419437).
			const childContext = insideNot
			value = Array.isArray(value)
				? value.map((entry, index) => stripNode(entry, childContext, `${path}/${key}/${index}`, facts))
				: stripNode(value, childContext, `${path}/${key}`, facts)
		}
		if (key === "then" || key === "else") {
			// A branch of a conditional: whether it drops is decided
			// after the key loop, from the complete changed-path set
			// (reviews 4725679729, 4726104174).
			conditionalBranches.push({ key, original: originalValue })
		}
		result[key] = value
	}

	// The changed-path set is complete: make the reference-aware retention
	// decisions now (review 4726104174).
	const conditionalStripped =
		compiledIf !== undefined &&
		(!deepEqualJson(compiledIf, schema.if) || (deciding && subtreeReachesChangedTarget(schema.if, facts)))
	if (hasIf && conditionalStripped && !insideNot) {
		// The original predicate travels into the hint beside its dropped
		// branches (review 4725679729); the bare stripped predicate stays
		// below - it asserts nothing.
		removed.if = ifOriginal
	}
	let conditionalEvaluationLost = false
	for (const branch of conditionalBranches) {
		if (conditionalStripped && !insideNot) {
			// The stripped predicate selects the other branch for values
			// the original rejected: a retained branch would reject values
			// the original schema accepted (review 4725679729). The branch
			// travels into the hint beside the original predicate; the
			// bare predicate stays in place, because a bare if applies no
			// assertion. Inside a negation context the stripped branches
			// only widen the negated subtree, which relaxes the enclosing
			// negation - keep them.
			// A dropped branch that evaluated keys (its properties or
			// patternProperties rules) takes those evaluations with it: a
			// retained unevaluatedProperties rule at this level would then
			// forbid a value the original accepted, so it relaxes below
			// (review 4726391005).
			conditionalEvaluationLost = conditionalEvaluationLost || carriesPropertyEvaluation(branch.original)
			delete result[branch.key]
			removed[branch.key] = branch.original
		}
	}
	if (conditionalEvaluationLost) {
		if (result.unevaluatedProperties === false) {
			result.unevaluatedProperties = true
		} else if (isRecord(result.unevaluatedProperties)) {
			result.unevaluatedProperties = true
		}
	}
	for (const pending of pendingNotDrops) {
		const directChanged = !deepEqualJson(pending.stripped, pending.original)
		if (directChanged || (deciding && subtreeReachesChangedTarget(pending.original, facts))) {
			// The negated subtree lost a keyword, or the negation only
			// references a target that changed: the stripped or
			// re-referenced predicate can match values the original did
			// not, and the retained negation would reject a value the
			// original accepted (reviews 4725679664, 4726104174). Dropping
			// the negation is the strictly relaxing direction; the whole
			// original subtree stays visible as the hint.
			delete result[pending.key]
			removed[pending.key] = pending.original
		} else {
			result[pending.key] = pending.stripped
		}
	}
	if (pendingOneOf && deciding && subtreeReachesChangedTarget(pendingOneOf.original, facts)) {
		// Every value now matches several branches through the changed
		// target and oneOf would accept nothing: the branches relax under
		// the overlap-safe anyOf position (review 4726104174).
		relaxedOneOf = pendingOneOf.stripped
		oneOfRelocated.push({ path })
		delete result.oneOf
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
				facts.relocations.push({
					oldPrefix: `${relocation.path}/oneOf`,
					newPrefix: `${relocation.path}/allOf/${conjunctIndex}/anyOf`,
				})
			}
		} else {
			result.anyOf = relaxedOneOf
			for (const relocation of oneOfRelocated) {
				facts.relocations.push({
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

	// A node whose stripped form differs from its input marks a change a
	// "$ref" elsewhere can reach: the changed path feeds the
	// ref-aware retention decisions above (review 4726104174).
	if (!deepEqualJson(result, schema)) {
		facts.changedPaths.push(decodePathSegments(path))
	}

	return result
}
