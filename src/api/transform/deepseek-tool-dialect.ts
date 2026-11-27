/**
 * DeepSeek tool dialect compiler (issue #547, defects 1 and 2).
 *
 * DeepSeek's function-calling gateway cannot compile strict-mode tool schemas:
 * Draft 2020-12 strict compilation rejects constraint keywords such as
 * "pattern" and "minLength" (HTTP 422 at schema compilation time), and strict
 * mode's forced all-properties-required rule makes the model emit values for
 * parameters the tool treats as optional (endless "missing required
 * parameter" retries on read_file's limit/offset).
 *
 * This compiler relaxes the schema instead of tightening it:
 * - the caller sends the tool with strict disabled, so declared optionality
 *   survives (the declared `required` array is preserved untouched at every
 *   nesting level);
 * - keywords DeepSeek gateways reject are removed and re-encoded as readable
 *   description hints, so the model still sees the constraint they carried;
 * - schema maps are compiled depth-first: properties, $defs, definitions and
 *   dependentSchemas (a constraint inside a dependent schema reaches the
 *   gateway exactly like one on a property);
 * - compilation never turns a satisfiable schema into an unsatisfiable one:
 *   removing patternProperties relaxes a retained additionalProperties: false
 *   and a retained unevaluatedProperties: false (the removed rules were what
 *   evaluated those keys), removing contains relaxes a retained
 *   unevaluatedItems: false for the same reason, a oneOf whose branches - or
 *   whose branches'
 *   reference targets - changed moves under anyOf as its own allOf conjunct
 *   (an unchanged sibling anyOf keeps applying on its own), a not whose
 *   predicate changed is dropped, and a conditional whose if predicate changed
 *   loses its then/else branches. A predicate that only references schemas
 *   ($ref) counts as changed when a referenced target itself compiles
 *   differently (each original rule stays in the hint);
 * - compilation is pure: the caller-owned schema object is never mutated;
 * - finished node compilations are memoized per document, because predicate
 *   checks recompile shared reference targets and an unmemoized chain of
 *   $ref-linked definitions costs exponential work on a small schema
 *   (issue #547 review 4719419419);
 *
 * Unlike stripUnsupportedStrictKeywords (the strict-mode sanitizer applied for
 * strict: true endpoints), this runs regardless of strictness and never
 * touches `required`. MCP tool schemas are the main source of pattern /
 * minLength keywords, which is why the DeepSeek handler applies this to every
 * function tool, MCP or not.
 *
 * See https://api-docs.deepseek.com for the function calling guide and the
 * strict-mode subset this compiler works around.
 */

const DEEPSEEK_REJECTED_SCHEMA_KEYWORDS = new Set([
	"pattern",
	"patternProperties",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"minLength",
	"maxLength",
	"minItems",
	"maxItems",
	"uniqueItems",
	"contains",
	"minContains",
	"maxContains",
	"minProperties",
	"maxProperties",
])

// Guards against pathological (deeply nested or cyclic-by-construction)
// schemas: past this depth the remaining nodes are passed through uncompiled.
const MAX_SCHEMA_DEPTH = 32

/**
 * Per-document memo of finished node compilations. The same schema object at
 * the same depth always compiles to the same output, and the predicate checks
 * (if, oneOf branches, not) recompile shared reference targets: without the
 * memo a chain of $ref-linked definitions recompiles every level once per
 * referencing predicate, which is exponential work on a small acyclic schema
 * and blocks the synchronous request path (issue #547 review 4719419419).
 */
type SchemaCompileMemo = WeakMap<object, Map<number, unknown>>

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Structural equality for compiled-vs-original schema nodes: compilation
 * rebuilds nodes in input key order and appends a description only when it
 * removed keywords, so an unchanged node serializes identically.
 */
function deepEqualJson(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Collects every local "$ref" JSON pointer mentioned anywhere inside a
 * predicate subtree. A reference applies its target schema at validation
 * time, so a predicate whose own object is unchanged can still behave
 * differently when one of its targets compiles differently.
 */
function collectRefPointers(value: unknown, seen: Set<unknown>, out: string[]): void {
	if (Array.isArray(value)) {
		for (const entry of value) {
			collectRefPointers(entry, seen, out)
		}
		return
	}
	if (!isRecord(value) || seen.has(value)) {
		return
	}
	seen.add(value)
	if (typeof value.$ref === "string") {
		out.push(value.$ref)
	}
	for (const entry of Object.values(value)) {
		collectRefPointers(entry, seen, out)
	}
}

/**
 * Resolves a "#/..." JSON pointer against the original root schema. Anything
 * else (external URIs, the whole-document "#" form, dangling pointers) is
 * reported unresolved.
 */
function resolveLocalRef(root: unknown, ref: string): { resolved: boolean; target: unknown } {
	if (!ref.startsWith("#/")) {
		return { resolved: false, target: undefined }
	}
	let node: unknown = root
	for (const rawSegment of ref.slice(2).split("/")) {
		const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~")
		if (!isRecord(node) || !Object.prototype.hasOwnProperty.call(node, segment)) {
			return { resolved: false, target: undefined }
		}
		node = node[segment]
	}
	return { resolved: true, target: node }
}

/**
 * A predicate is reference-stable when every schema its "$ref"s resolve in
 * the original root and compiles unchanged: the compiled document keeps the
 * pointer path, so the retained predicate then behaves exactly as declared.
 * An unresolvable or relaxed target means a retained predicate would apply
 * constraints the original did not have - a tightening (issue #547 review
 * 4716476940).
 */
function referencesUnchangedTargets(refs: string[], root: unknown, depth: number, memo: SchemaCompileMemo): boolean {
	for (const ref of refs) {
		const resolved = resolveLocalRef(root, ref)
		if (!resolved.resolved) {
			return false
		}
		if (!deepEqualJson(compileSchemaNode(resolved.target, depth + 1, root, memo), resolved.target)) {
			return false
		}
	}
	return true
}

/**
 * Explicit own-property creation: a schema key like "__proto__" (legal in
 * JSON and produced by JSON.parse as an own property) must become an own data
 * property of the compiled copy, never a prototype change (issue #547 review
 * 4712438384).
 */
function defineOwnKey(target: Record<string, unknown>, key: string, value: unknown): void {
	Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}

/**
 * Renders removed constraints as readable description text so the model keeps
 * seeing the constraint the schema carried (the endpoint ignores them, the
 * caller side still benefits).
 */
function describeRemovedConstraints(removed: Record<string, unknown>): string {
	const parts = Object.entries(removed).map(([key, value]) => {
		if (key === "pattern" && typeof value === "string") {
			return `value must match /${value}/`
		}
		return `${key}: ${JSON.stringify(value)}`
	})
	return `DeepSeek compatibility (constraint kept for the caller): ${parts.join("; ")}`
}

/**
 * Recursively compiles one schema node. Returns a new object; the input is
 * never mutated. Container positions (properties, items, combinators and the
 * keyword-driven schema values) are compiled depth-first.
 */
function compileSchemaNode(schema: unknown, depth: number, root: unknown, memo: SchemaCompileMemo): unknown {
	if (!isRecord(schema) || depth > MAX_SCHEMA_DEPTH) {
		return schema
	}

	// Compilation is a pure function of (schema, depth, root): a finished
	// (node, depth) pair can be reused by every later predicate that walks
	// the same target at the same depth (issue #547 review 4719419419).
	const memoized = memo.get(schema)?.get(depth)
	if (memoized !== undefined) {
		return memoized
	}

	const result: Record<string, unknown> = {}
	const removed: Record<string, unknown> = {}
	let relaxedOneOf: unknown[] | undefined

	// A conditional whose `if` predicate compilation changes cannot keep its
	// branches: the compiled predicate selects then/else for values the
	// original rejected, and a retained then would reject them all. Detect
	// the change before the key loop so the decision cannot depend on key
	// order (issue #547 review 4713747391). The predicate compiles exactly
	// once per level and the key loop reuses this copy, so a chain of
	// unchanged conditionals costs linear work, not exponential
	// (issue #547 review 4714821172); the memo below also deduplicates the
	// reference-target compilations (issue #547 review 4719419419).
	const compiledIf = isRecord(schema.if) ? compileSchemaNode(schema.if, depth + 1, root, memo) : undefined
	let conditionalRelaxed = compiledIf !== undefined && !deepEqualJson(compiledIf, schema.if)
	if (!conditionalRelaxed && compiledIf !== undefined) {
		// The predicate object compiled unchanged, but predicates that only
		// reference schemas ($ref) apply their targets at validation time: a
		// relaxed target turns the retained predicate into a different rule
		// (issue #547 review 4716476940).
		const refs: string[] = []
		collectRefPointers(schema.if, new Set(), refs)
		if (refs.length > 0 && !referencesUnchangedTargets(refs, root, depth, memo)) {
			conditionalRelaxed = true
		}
	}

	for (const [key, value] of Object.entries(schema)) {
		if (DEEPSEEK_REJECTED_SCHEMA_KEYWORDS.has(key)) {
			defineOwnKey(removed, key, value)
			continue
		}

		if (key === "properties" || key === "$defs" || key === "definitions" || key === "dependentSchemas") {
			if (isRecord(value)) {
				const compiled: Record<string, unknown> = {}
				for (const [name, subSchema] of Object.entries(value)) {
					defineOwnKey(compiled, name, compileSchemaNode(subSchema, depth + 1, root, memo))
				}
				defineOwnKey(result, key, compiled)
				continue
			}
		} else if (key === "items") {
			defineOwnKey(
				result,
				key,
				Array.isArray(value)
					? value.map((entry) => compileSchemaNode(entry, depth + 1, root, memo))
					: compileSchemaNode(value, depth + 1, root, memo),
			)
			continue
		} else if (key === "anyOf" || key === "oneOf" || key === "allOf" || key === "prefixItems") {
			if (Array.isArray(value)) {
				const compiledBranches = value.map((entry) => compileSchemaNode(entry, depth + 1, root, memo))
				const branchesChanged = compiledBranches.some((branch, index) => !deepEqualJson(branch, value[index]))
				let relaxed = key === "oneOf" && branchesChanged
				if (!relaxed && key === "oneOf") {
					// Branch objects unchanged, but branches that only
					// reference schemas ($ref) apply their targets at
					// validation time: a relaxed target makes every value
					// match several branches (issue #547 review 4716476940).
					const refs: string[] = []
					collectRefPointers(value, new Set(), refs)
					relaxed = refs.length > 0 && !referencesUnchangedTargets(refs, root, depth, memo)
				}
				if (relaxed) {
					// oneOf accepts exactly one alternative: compilation that
					// relaxed branch constraints (removed distinguishing
					// patterns) can make every value match several branches,
					// and oneOf would then accept nothing. The branches move
					// under the overlap-safe anyOf instead.
					relaxedOneOf = compiledBranches
				} else {
					defineOwnKey(result, key, compiledBranches)
				}
				continue
			}
		} else if (key === "not") {
			if (isRecord(value)) {
				const compiledChild = compileSchemaNode(value, depth + 1, root, memo)
				const childUnchanged = deepEqualJson(compiledChild, value)
				let targetsUnchanged = true
				if (childUnchanged) {
					// The child object compiled unchanged, but a child that
					// only references schemas ($ref) applies its targets at
					// validation time: the reference object being identical
					// does not make the negation behave identically (issue
					// #547 review 4716476940).
					const refs: string[] = []
					collectRefPointers(value, new Set(), refs)
					if (refs.length > 0) {
						targetsUnchanged = referencesUnchangedTargets(refs, root, depth, memo)
					}
				}
				if (childUnchanged && targetsUnchanged) {
					defineOwnKey(result, key, compiledChild)
				} else {
					// The negated predicate carried a rejected keyword: the
					// compiled child accepts every value, so a retained not
					// would reject every value (a tightening). Drop the
					// negation and keep the original rule as a hint.
					defineOwnKey(removed, "not", value)
				}
				continue
			}
		} else if (key === "if") {
			if (isRecord(value)) {
				if (conditionalRelaxed) {
					// The compiled predicate changed: the whole original
					// conditional moves into the hint, so then/else cannot
					// fire on values the original schema accepted.
					defineOwnKey(removed, key, value)
				} else {
					// value is schema.if and compiled unchanged above; reuse
					// the already-compiled copy instead of compiling again.
					defineOwnKey(result, key, compiledIf)
				}
				continue
			}
		} else if (key === "then" || key === "else") {
			if (conditionalRelaxed) {
				// The branches belong to a relaxed conditional; they travel
				// into the hint with their if predicate.
				defineOwnKey(removed, key, value)
				continue
			}
			if (isRecord(value)) {
				defineOwnKey(result, key, compileSchemaNode(value, depth + 1, root, memo))
				continue
			}
		} else if (key === "additionalProperties" || key === "propertyNames") {
			if (isRecord(value)) {
				defineOwnKey(result, key, compileSchemaNode(value, depth + 1, root, memo))
				continue
			}
		}

		defineOwnKey(result, key, value)
	}

	if (relaxedOneOf) {
		// Sibling constraints apply together, never as alternatives: the
		// original anyOf stays untouched and the relaxed oneOf branches
		// become one separate allOf conjunct (issue #547 review
		// 4713747398). With no sibling combinator the branches keep the
		// anyOf position unchanged.
		const alternatives = { anyOf: relaxedOneOf }
		if (Array.isArray(result.anyOf) || Array.isArray(result.allOf)) {
			const existing = Array.isArray(result.allOf) ? (result.allOf as unknown[]) : []
			defineOwnKey(result, "allOf", [...existing, alternatives])
		} else {
			defineOwnKey(result, "anyOf", relaxedOneOf)
		}
	}

	// Removing patternProperties can strand keys that were legal only through
	// the pattern rules: a retained additionalProperties: false would leave
	// the object without any valid instance (issue #547 review 4712438380).
	// Relax exactly that case; ordinary closed objects keep their rule.
	if ("patternProperties" in removed && result.additionalProperties === false) {
		defineOwnKey(result, "additionalProperties", true)
	}
	if ("patternProperties" in removed && result.unevaluatedProperties === false) {
		// patternProperties evaluated the keys it matched; with the rules gone
		// those keys are unevaluated, so a retained unevaluatedProperties: false
		// would forbid a required property the original accepted (issue #547
		// review 4716476950). An object-schema value is an ordinary restriction
		// and stays untouched.
		defineOwnKey(result, "unevaluatedProperties", true)
	}
	// The same annotation dependency on arrays: contains evaluated the items
	// it matched, so removing it strands a retained unevaluatedItems: false
	// and forbids every item the original accepted (issue #547 review
	// 4719419428). A retained items or prefixItems still evaluates the
	// array, so that restriction stays untouched.
	if (
		"contains" in removed &&
		result.unevaluatedItems === false &&
		!("items" in result) &&
		!("prefixItems" in result)
	) {
		defineOwnKey(result, "unevaluatedItems", true)
	}

	if (Object.keys(removed).length > 0) {
		const hint = describeRemovedConstraints(removed)
		const existing = result.description
		defineOwnKey(
			result,
			"description",
			typeof existing === "string" && existing.length > 0 ? `${existing}\n${hint}` : hint,
		)
	}

	let depthResults = memo.get(schema)
	if (!depthResults) {
		depthResults = new Map()
		memo.set(schema, depthResults)
	}
	depthResults.set(depth, result)
	return result
}

/**
 * Compiles a tool's `parameters` schema into the dialect DeepSeek accepts:
 * gateway-rejected keywords are removed and re-encoded into descriptions, the
 * declared `required` arrays are preserved untouched (optionality stays
 * optional), and no satisfiable schema compiles into an unsatisfiable one.
 * Pure: the input schema is left untouched.
 */
export function compileToolParametersForDeepSeek(schema: unknown): unknown {
	return compileSchemaNode(schema, 0, schema, new WeakMap())
}
