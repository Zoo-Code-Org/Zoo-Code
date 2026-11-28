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
 *   removing patternProperties relaxes a retained additionalProperties rule
 *   and a retained unevaluatedProperties rule (a false rule becomes true; a
 *   schema-valued rule re-admits the removed pattern rules as alternatives,
 *   so the keys they evaluated stay accepted), a moved rule carries no
 *   reference that only resolves through a removed location: such a pointer
 *   is inlined with its compiled target, and a rule that references itself
 *   through the removed location relaxes the retained rule instead (issue
 *   #547 review 6089521528), a relocation that would grow past the
 *   expansion budget relaxes the retained rule instead (issue #547 review
 *   4723722021), literal values under const, enum, default and examples are
 *   never rewritten (issue #547 review 4723722038), a moved reference's
 *   sibling keywords stay on the outer schema beside the inlined target so
 *   Draft 2020-12 annotation visibility survives (issue #547 review
 *   4723722028), a surviving reference's literal-valued siblings stay
 *   verbatim while its schema-map siblings relocate (issue #547 review
 *   4725307765), removing contains relaxes a
 *   retained unevaluatedItems restriction the same way, and a retained
 *   prefixItems is no complete evaluator: only a retained items keeps the
 *   array restriction (issue #547 review 4719935091), a oneOf whose branches - or
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

// A relocation may inline an acyclic reference graph whose output grows
// exponentially (each level referenced twice doubles the copy count), and
// cycle detection cannot see that. Relocation counts the nodes it creates
// and abandons past this budget; the caller relaxes the retained rule
// instead of moving it (issue #547 review 4723722021).
const MAX_RELOCATION_NODES = 4096

// Literal-valued keywords carry instance data, not schemas: a "$ref"-shaped
// object inside them is a value a caller asserts against, never a reference
// to inline (issue #547 review 4723722038).
const LITERAL_VALUE_KEYWORDS = new Set(["const", "enum", "default", "examples"])

// A record under one of these keywords is a name-to-schema map: its keys are
// property or definition names, never schema keywords, so a name that happens
// to match a literal keyword must not suppress relocation of the schema
// beneath it (issue #547 review 4724111355). The set matches the compiler's
// own map traversal; patternProperties is rejected before relocation runs.
const SCHEMA_MAP_KEYWORDS = new Set(["properties", "$defs", "definitions", "dependentSchemas"])

/**
 * A schema-map keyword's record value holds schemas under name keys, so the
 * relocation walk descends into it in map mode.
 */
function entersSchemaMap(key: string, value: unknown): boolean {
	return SCHEMA_MAP_KEYWORDS.has(key) && isRecord(value)
}

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
 * Keys a moved rule's pointer must not traverse: compilation removes these
 * keywords outright (the rejected set) or rewrites them into another
 * structure (the retained rules the relaxations replace), so a pointer
 * through them targets a location the compiled document does not have and
 * the reference could not resolve at validation time (issue #547 review
 * 6089521528).
 */
const POINTER_KEYS_LOST_IN_COMPILATION = new Set([
	...DEEPSEEK_REJECTED_SCHEMA_KEYWORDS,
	"oneOf",
	"not",
	"if",
	"then",
	"else",
	"additionalProperties",
	"unevaluatedProperties",
	"unevaluatedItems",
])

function pointerTraversesLostKey(ref: string): boolean {
	if (!ref.startsWith("#/")) {
		// External URIs and the whole-document "#" form never depended on a
		// local document location.
		return false
	}
	return ref
		.slice(2)
		.split("/")
		.some((rawSegment) => {
			const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~")
			return POINTER_KEYS_LOST_IN_COMPILATION.has(segment)
		})
}

/**
 * Rewrites the local references inside a rule that compilation moves to
 * another document location. A pointer whose path traverses a lost key is
 * replaced with its resolved, compiled target - the same schema a retained
 * pointer would have resolved to - so the moved rule keeps the constraints
 * it declared instead of an unresolvable reference. Siblings of a rewritten
 * "$ref" stay on the outer schema beside the inlined target under one allOf
 * conjunct: Draft 2020-12 collects evaluation annotations from adjacent
 * keywords and from the schemas one object applies in place, and a sibling
 * allOf branch is not such an application, so an evaluation keyword moved
 * inside the conjunct would lose sight of the inlined target's annotations
 * and reject values the original accepted (issue #547 review 4723722028).
 * Literal values under const, enum, default and examples are instance data,
 * never schemas, and pass through untouched inside a schema object (issue
 * #547 review 4723722038) - inside a name-to-schema map (properties, $defs,
 * definitions, dependentSchemas) the keys are names, and an entry named
 * const still carries a schema that relocates (issue #547 review
 * 4724111355). Existing allOf conjuncts of the rewritten reference stay
 * conjuncts and relocate through the same walk, so a conjunct's own
 * reference through the removed location stays resolvable (issue #547
 * review 4724111350).
 * The rule's reference is kept when its pointer is external, never resolved
 * locally even in the original, or still resolves in the compiled document;
 * a surviving reference's sibling keywords still relocate through the same
 * walk while its literal-valued siblings stay verbatim, and an unresolvable
 * pointer keeps the rule exactly as the untouched pass-through would
 * (issue #547 review 4724550474, review 4725307765). An acyclic
 * reference graph can still branch, so relocation
 * counts the nodes it creates and abandons past MAX_RELOCATION_NODES - the
 * caller then relaxes instead of moving the rule (issue #547 review
 * 4723722021). abandon.hit marks both the cycle stop and the budget stop.
 * Pure: the input node is never mutated.
 */
function relocateMovedRefs(
	node: unknown,
	root: unknown,
	depth: number,
	memo: SchemaCompileMemo,
	chain: Set<unknown>,
	abandon: { hit: boolean },
	budget: { remaining: number },
	insideSchemaMap: boolean,
): unknown {
	if (abandon.hit) {
		return node
	}
	if (Array.isArray(node)) {
		budget.remaining -= 1
		if (budget.remaining <= 0) {
			abandon.hit = true
			return node
		}
		const out: unknown[] = []
		for (const entry of node) {
			out.push(relocateMovedRefs(entry, root, depth, memo, chain, abandon, budget, insideSchemaMap))
		}
		return out
	}
	if (!isRecord(node)) {
		return node
	}
	if (typeof node.$ref === "string") {
		const ref: string = node.$ref
		if (!pointerTraversesLostKey(ref)) {
			// The reference itself survives compilation, but its sibling
			// keywords can still carry references through the removed
			// location: keep the reference and relocate the siblings
			// through the same walk (issue #547 review 4724550474).
			budget.remaining -= 1
			if (budget.remaining <= 0) {
				abandon.hit = true
				return node
			}
			const out: Record<string, unknown> = {}
			for (const [key, value] of Object.entries(node)) {
				// A literal-valued sibling carries instance data, not a
				// schema: a "$ref"-shaped value under const stays verbatim
				// (issue #547 review 4723722038, review 4725307765).
				if (LITERAL_VALUE_KEYWORDS.has(key)) {
					defineOwnKey(out, key, value)
					continue
				}
				defineOwnKey(
					out,
					key,
					relocateMovedRefs(value, root, depth, memo, chain, abandon, budget, entersSchemaMap(key, value)),
				)
			}
			if (abandon.hit) {
				return node
			}
			return out
		}
		const resolved = resolveLocalRef(root, ref)
		if (!resolved.resolved) {
			// The pointer never resolved in the original document either:
			// keep it exactly as the untouched pass-through would.
			return node
		}
		if (chain.has(resolved.target)) {
			abandon.hit = true
			return node
		}
		chain.add(resolved.target)
		const inlined = relocateMovedRefs(
			compileSchemaNode(resolved.target, depth + 1, root, memo),
			root,
			depth,
			memo,
			chain,
			abandon,
			budget,
			false,
		)
		chain.delete(resolved.target)
		if (abandon.hit) {
			return node
		}
		budget.remaining -= 1
		if (budget.remaining <= 0) {
			abandon.hit = true
			return node
		}
		const conjuncts: unknown[] = [inlined]
		const rest: Record<string, unknown> = {}
		for (const [key, value] of Object.entries(node)) {
			if (key === "$ref") {
				continue
			}
			if (key === "allOf" && Array.isArray(value)) {
				// Existing conjuncts stay conjuncts; only the inlined target
				// joins them, every other keyword keeps its outer position.
				// Each conjunct relocates through the same walk first: a
				// conjunct can carry its own reference through the removed
				// location, and the pointer would dangle in the compiled
				// document (issue #547 review 4724111350).
				for (const conjunct of value) {
					conjuncts.push(relocateMovedRefs(conjunct, root, depth, memo, chain, abandon, budget, false))
				}
				continue
			}
			if (LITERAL_VALUE_KEYWORDS.has(key)) {
				defineOwnKey(rest, key, value)
				continue
			}
			defineOwnKey(
				rest,
				key,
				relocateMovedRefs(value, root, depth, memo, chain, abandon, budget, entersSchemaMap(key, value)),
			)
		}
		if (abandon.hit) {
			return node
		}
		if (Object.keys(rest).length === 0 && conjuncts.length === 1) {
			return inlined
		}
		const out: Record<string, unknown> = {}
		defineOwnKey(out, "allOf", conjuncts)
		for (const [key, value] of Object.entries(rest)) {
			defineOwnKey(out, key, value)
		}
		return out
	}
	budget.remaining -= 1
	if (budget.remaining <= 0) {
		abandon.hit = true
		return node
	}
	const out: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(node)) {
		// A map's keys are names, so the literal exclusion applies only
		// inside schema objects: an entry named const keeps relocating the
		// schema beneath it (issue #547 review 4724111355).
		if (!insideSchemaMap && LITERAL_VALUE_KEYWORDS.has(key)) {
			defineOwnKey(out, key, value)
			continue
		}
		defineOwnKey(
			out,
			key,
			relocateMovedRefs(
				value,
				root,
				depth,
				memo,
				chain,
				abandon,
				budget,
				insideSchemaMap ? false : entersSchemaMap(key, value),
			),
		)
	}
	return out
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
	// the pattern rules: a retained additionalProperties rule would leave the
	// object without any valid instance when the rule is false (issue #547
	// review 4712438380), and a retained unevaluatedProperties: false would
	// forbid a required property the original accepted (issue #547 review
	// 4716476950). A schema-valued rule keeps restricting the keys the pattern
	// rules never matched, and the removed pattern rules re-enter as its
	// alternatives, so a value the original accepted stays accepted (issue #547
	// review 4719336022). Ordinary closed objects keep their rule.
	if ("patternProperties" in removed && isRecord(removed.patternProperties)) {
		const patternRules: unknown[] = []
		let relocatable = true
		for (const rule of Object.values(removed.patternProperties)) {
			const abandon = { hit: false }
			const budget = { remaining: MAX_RELOCATION_NODES }
			const relocated = relocateMovedRefs(
				compileSchemaNode(rule, depth + 1, root, memo),
				root,
				depth,
				memo,
				new Set(),
				abandon,
				budget,
				false,
			)
			if (abandon.hit) {
				relocatable = false
				break
			}
			patternRules.push(relocated)
		}
		if (result.additionalProperties === false) {
			defineOwnKey(result, "additionalProperties", true)
		} else if (isRecord(result.additionalProperties)) {
			if (relocatable) {
				defineOwnKey(result, "additionalProperties", {
					anyOf: [result.additionalProperties, ...patternRules],
				})
			} else {
				// A pattern rule references itself through the removed
				// location, so the keys it evaluated are unknown: a retained
				// schema-valued rule could forbid a value the original
				// accepted, and the rule relaxes instead (issue #547 review
				// 6089521528).
				defineOwnKey(result, "additionalProperties", true)
			}
		}
		if (result.unevaluatedProperties === false) {
			defineOwnKey(result, "unevaluatedProperties", true)
		} else if (isRecord(result.unevaluatedProperties)) {
			if (relocatable) {
				defineOwnKey(result, "unevaluatedProperties", {
					anyOf: [result.unevaluatedProperties, ...patternRules],
				})
			} else {
				defineOwnKey(result, "unevaluatedProperties", true)
			}
		}
	}
	// The same annotation dependency on arrays: contains evaluated the items it
	// matched, so removing it strands a retained unevaluatedItems restriction
	// and forbids every item the original accepted (issue #547 review
	// 4719419428). A retained items still evaluates every remaining index, so
	// the restriction stays untouched in that position; a retained prefixItems
	// evaluates only its listed positions, so the contains-evaluated trailing
	// indices stay stranded and the restriction relaxes (issue #547 review
	// 4719935091).
	if ("contains" in removed && !("items" in result)) {
		if (result.unevaluatedItems === false) {
			defineOwnKey(result, "unevaluatedItems", true)
		} else if (isRecord(result.unevaluatedItems)) {
			// The contains rule re-enters as an alternative: the items it
			// evaluated stay accepted beside the retained restriction. A
			// boolean contains evaluates positions only, so the alternative
			// accepts any item. The same relocation applies to the moved
			// rule: the compiled document loses the contains location too
			// (issue #547 review 6089521528).
			const abandon = { hit: false }
			const budget = { remaining: MAX_RELOCATION_NODES }
			const relaxed = isRecord(removed.contains)
				? relocateMovedRefs(
						compileSchemaNode(removed.contains, depth + 1, root, memo),
						root,
						depth,
						memo,
						new Set(),
						abandon,
						budget,
						false,
					)
				: {}
			if (abandon.hit) {
				defineOwnKey(result, "unevaluatedItems", true)
			} else {
				defineOwnKey(result, "unevaluatedItems", { anyOf: [result.unevaluatedItems, relaxed] })
			}
		}
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
