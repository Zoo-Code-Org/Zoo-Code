// npx vitest run api/transform/__tests__/strict-tool-schema.spec.ts

import { stripUnsupportedStrictKeywords } from "../strict-tool-schema"

type Schema = Record<string, unknown>

function strip(schema: Schema): Schema {
	return stripUnsupportedStrictKeywords(schema) as Schema
}

function constraintNote(removed: Schema): string {
	return `Constraints: ${JSON.stringify(removed)}`
}

/**
 * Minimal Draft 2020-12 acceptance oracle for the keyword subset these
 * fixtures use (type, pattern, enum, required/properties, oneOf/anyOf/allOf,
 * not, $ref, if/then/else). It encodes JSON Schema semantics - not the
 * stripper's rules - so a test can assert that values the declared schema
 * accepted still validate after stripping. A local $ref resolves against the
 * root document (the outermost call's schema unless a test passes the
 * document explicitly), because a reference applies its target at
 * validation time.
 */
function resolveLocalPointer(root: unknown, ref: string): unknown {
	let node: unknown = root
	for (const rawSegment of ref.slice(2).split("/")) {
		// A URI fragment percent-decodes first, then the JSON Pointer "~"
		// escapes, so the definition named "A B" matches "A%20B" exactly
		// like the production parser (review 4726391009).
		let percentDecoded = rawSegment
		try {
			percentDecoded = decodeURIComponent(rawSegment)
		} catch {
			percentDecoded = rawSegment
		}
		const segment = percentDecoded.replace(/~1/g, "/").replace(/~0/g, "~")
		if (Array.isArray(node)) {
			const index = Number(segment)
			if (!Number.isInteger(index) || index < 0 || index >= node.length) {
				return undefined
			}
			node = node[index]
			continue
		}
		if (typeof node !== "object" || node === null || !(segment in (node as Schema))) {
			return undefined
		}
		node = (node as Schema)[segment]
	}
	return node
}
function matchesType(type: string, value: unknown): boolean {
	switch (type) {
		case "string":
			return typeof value === "string"
		case "object":
			return typeof value === "object" && value !== null && !Array.isArray(value)
		case "array":
			return Array.isArray(value)
		case "null":
			return value === null
		case "number":
			return typeof value === "number"
		case "integer":
			return typeof value === "number" && Number.isInteger(value)
		case "boolean":
			return typeof value === "boolean"
		default:
			return true
	}
}

function accepts(schema: unknown, value: unknown, root?: unknown): boolean {
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
		return true
	}
	const s = schema as Schema
	const scope = root ?? schema
	// Combinators and siblings apply TOGETHER (Draft 2020-12): each result
	// combines with the remaining keyword checks instead of returning early,
	// so a schema like {type:"string", anyOf:[{}]} still rejects a number.
	let accepted = true
	if (Array.isArray(s.oneOf)) {
		accepted = accepted && s.oneOf.filter((branch) => accepts(branch, value, scope)).length === 1
	}
	if (Array.isArray(s.anyOf)) {
		accepted = accepted && s.anyOf.some((branch) => accepts(branch, value, scope))
	}
	if (Array.isArray(s.allOf)) {
		accepted = accepted && s.allOf.every((branch) => accepts(branch, value, scope))
	}
	if (s.not !== undefined) {
		accepted = accepted && !accepts(s.not, value, scope)
	}
	if (typeof s.type === "string" && !matchesType(s.type, value)) {
		accepted = false
	}
	if (typeof s.pattern === "string") {
		if (typeof value !== "string" || !new RegExp(s.pattern).test(value)) {
			accepted = false
		}
	}
	if (Array.isArray(s.enum)) {
		accepted = accepted && s.enum.some((entry) => JSON.stringify(entry) === JSON.stringify(value))
	}
	if (typeof s.$ref === "string" && s.$ref.startsWith("#/")) {
		const target = resolveLocalPointer(scope, s.$ref)
		accepted = accepted && target !== undefined && accepts(target, value, scope)
	}
	if (s.if !== undefined) {
		const selected = accepts(s.if, value, scope) ? s.then : s.else
		accepted = accepted && (selected === undefined || accepts(selected, value, scope))
	}
	if (!accepted) {
		return false
	}
	if (s.properties === undefined) {
		return true
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false
	}
	const object = value as Record<string, unknown>
	for (const required of Array.isArray(s.required) ? s.required : []) {
		if (typeof required === "string" && !(required in object)) {
			return false
		}
	}
	for (const [key, sub] of Object.entries(s.properties as Schema)) {
		if (key in object && !accepts(sub, object[key], scope)) {
			return false
		}
	}
	return true
}

describe("stripUnsupportedStrictKeywords", () => {
	it.each([
		["minimum", 1],
		["maximum", 9],
		["exclusiveMinimum", 0],
		["exclusiveMaximum", 10],
		["multipleOf", 2],
		["minLength", 1],
		["maxLength", 5],
		["maxItems", 4],
		["uniqueItems", true],
		["contains", { type: "string" }],
		["minContains", 1],
		["maxContains", 3],
		["minProperties", 1],
		["maxProperties", 2],
		["pattern", "[a-zA-Z0-9_]+$"],
	])("removes %s and records it in the description", (keyword, value) => {
		expect(strip({ type: "string", [keyword]: value })).toEqual({
			type: "string",
			description: constraintNote({ [keyword]: value }),
		})
	})

	it.each([0, 1])("keeps minItems %s", (minItems) => {
		expect(strip({ type: "array", minItems })).toEqual({ type: "array", minItems })
	})

	it.each([2, "1", null])("removes unsupported minItems %j", (minItems) => {
		expect(strip({ type: "array", minItems })).toEqual({
			type: "array",
			description: constraintNote({ minItems }),
		})
	})

	it.each(["date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"])(
		"keeps supported format %s",
		(format) => {
			expect(strip({ type: "string", format })).toEqual({ type: "string", format })
		},
	)

	it.each(["phone", 1, null])("removes unsupported format %j", (format) => {
		expect(strip({ type: "string", format })).toEqual({
			type: "string",
			description: constraintNote({ format }),
		})
	})

	it("keeps additionalProperties false", () => {
		const schema = { type: "object", properties: {}, additionalProperties: false }

		expect(strip(schema)).toEqual(schema)
	})

	it.each([true, { type: "string" }])(
		"replaces additionalProperties %j with false and records the original value",
		(additionalProperties) => {
			expect(strip({ type: "object", properties: {}, additionalProperties })).toEqual({
				type: "object",
				properties: {},
				additionalProperties: false,
				description: constraintNote({ additionalProperties }),
			})
		},
	)

	it("replaces additionalProperties with false in objects inside anyOf", () => {
		const result = strip({
			anyOf: [
				{ type: "object", properties: {}, additionalProperties: true },
				{ type: "object", properties: {}, additionalProperties: { type: "string" } },
			],
		})

		expect(result.anyOf).toEqual([
			{
				type: "object",
				properties: {},
				additionalProperties: false,
				description: constraintNote({ additionalProperties: true }),
			},
			{
				type: "object",
				properties: {},
				additionalProperties: false,
				description: constraintNote({ additionalProperties: { type: "string" } }),
			},
		])
	})

	it.each(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"])(
		"strips each subschema in the %s map",
		(keyword) => {
			expect(strip({ [keyword]: { value: { type: "string", maxLength: 5 } } })).toEqual({
				[keyword]: { value: { type: "string", description: constraintNote({ maxLength: 5 }) } },
			})
		},
	)

	it.each(["anyOf", "allOf", "prefixItems"])("strips each subschema in the %s list", (keyword) => {
		expect(strip({ [keyword]: [{ type: "integer", minimum: 0 }, { type: "null" }] })).toEqual({
			[keyword]: [{ type: "integer", description: constraintNote({ minimum: 0 }) }, { type: "null" }],
		})
	})

	it("moves a stripped oneOf list under anyOf (review 4716476955)", () => {
		// The stripped branches lose their distinguishing constraints, so
		// exactly-one semantics would accept nothing; the stripped branches
		// arrive in the anyOf position instead.
		expect(strip({ oneOf: [{ type: "integer", minimum: 0 }, { type: "null" }] })).toEqual({
			anyOf: [{ type: "integer", description: constraintNote({ minimum: 0 }) }, { type: "null" }],
		})
	})

	it("drops a changed negation whose stripped oneOf branches tightened it (review 4725679664)", () => {
		const schema: Schema = { not: { oneOf: [{ type: "string", pattern: "^a$" }, { type: "number" }] } }
		// Ground truth on the declared schema: "b" matches NEITHER original
		// branch, the exactly-one rule fails, and the negation accepts it.
		expect(accepts(schema, "b")).toBe(true)
		const stripped = strip(schema)
		// Stripping the pattern makes branch zero match every string, so a
		// retained negation would reject "b" (a value the original
		// accepted). The negation drops and the whole subtree stays in the
		// hint - the strictly relaxing direction.
		expect(stripped).not.toHaveProperty("not")
		expect(stripped).toEqual({ description: constraintNote({ not: schema.not }) })
		expect(accepts(stripped, "b")).toBe(true)
	})

	it("keeps an unchanged negation and its oneOf in place (review 4719419437)", () => {
		const not = { oneOf: [{ type: "string" }, { type: "number" }] }
		const stripped = strip({ not })
		// Nothing was stripped, so the negation did not change and keeps
		// its oneOf at its own position.
		expect(stripped).toEqual({ not })
	})

	it("still moves a stripped oneOf beside a not-toggling double negation (review 4719419437)", () => {
		// The inner negation sits in a negation context, so it stays (its
		// stripped subtree only widens the negated set, which relaxes the
		// enclosing negation); the OUTER negation's subtree lost keywords,
		// and a retained outer negation would reject values the original
		// accepted (review 4725679664) - it drops.
		const schema: Schema = { not: { not: { oneOf: [{ type: "integer", minimum: 0 }, { type: "null" }] } } }
		const stripped = strip(schema)
		expect(stripped).not.toHaveProperty("not")
		expect(stripped).toEqual({ description: constraintNote({ not: schema.not }) })
	})

	it("drops a negation reached through a schema map when its subtree changed (round 7 context, review 4725679664)", () => {
		// The negation context survives the schema-map keywords for the
		// oneOf position; the negation's own subtree still lost a keyword
		// (the branch's pattern), so the retained negation would reject a
		// value the original accepted and the negation drops.
		const schema: Schema = {
			type: "object",
			properties: {
				v: { not: { oneOf: [{ type: "string", pattern: "^a$" }, { type: "number" }] } },
			},
			required: ["v"],
		}
		// Ground truth: "b" matches zero original branches, the negation
		// accepts it.
		const vOriginal = (schema.properties as Schema).v as Schema
		expect(accepts(vOriginal, "b")).toBe(true)
		const stripped = strip(schema)
		const v = (stripped.properties as Schema).v as Schema
		expect(v).not.toHaveProperty("not")
		expect(v.description).toBe(
			constraintNote({ not: { oneOf: [{ type: "string", pattern: "^a$" }, { type: "number" }] } }),
		)
		expect(accepts(v, "b")).toBe(true)
	})

	it("still relaxes a stripped oneOf under properties outside a not (map-context control)", () => {
		// Control for the schema-map context: without the enclosing
		// negation the relaxation under properties applies exactly as
		// before.
		const schema: Schema = {
			type: "object",
			properties: { v: { oneOf: [{ type: "string", minLength: 1 }, { type: "string" }] } },
			required: ["v"],
		}
		const compiled = strip(schema)
		const v = (compiled.properties as Schema).v as Schema
		expect(v).not.toHaveProperty("oneOf")
		expect(v.anyOf).toStrictEqual([
			{ type: "string", description: constraintNote({ minLength: 1 }) },
			{ type: "string" },
		])
	})

	it.each(["items", "additionalItems", "unevaluatedItems", "unevaluatedProperties", "propertyNames", "then", "else"])(
		"strips the %s subschema",
		(keyword) => {
			expect(strip({ [keyword]: { type: "string", minLength: 1 } })).toEqual({
				[keyword]: { type: "string", description: constraintNote({ minLength: 1 }) },
			})
		},
	)

	it("strips the if subschema and keeps the bare predicate in place", () => {
		// A bare if asserts nothing, so the stripped predicate stays; the
		// original predicate is recorded in the hint (review 4725679729).
		expect(strip({ if: { type: "string", minLength: 1 } })).toEqual({
			if: { type: "string", description: constraintNote({ minLength: 1 }) },
			description: constraintNote({ if: { type: "string", minLength: 1 } }),
		})
	})

	it("drops the not subschema when stripping changed it", () => {
		// A retained negation over stripped branches would reject values
		// the original accepted (review 4725679664), so the negation drops
		// into the hint.
		expect(strip({ not: { type: "string", minLength: 1 } })).toEqual({
			description: constraintNote({ not: { type: "string", minLength: 1 } }),
		})
	})

	it("keeps the branches of a conditional whose predicate strips unchanged", () => {
		const conditional = { if: { type: "string" }, then: { type: "string" } }
		expect(strip(conditional)).toEqual(conditional)
	})

	it("drops the branches of a conditional whose stripped predicate flips branch selection (review 4725679729)", () => {
		const schema: Schema = {
			type: "string",
			if: { pattern: "^a$" },
			then: { enum: ["a"] },
			else: { enum: ["b"] },
		}
		// Ground truth on the declared schema: "a" selects then and passes,
		// "b" selects else and passes, and "c" selects else too - the enum
		// rejects it, so the assertions below verify branch selection.
		expect(accepts(schema, "a")).toBe(true)
		expect(accepts(schema, "b")).toBe(true)
		expect(accepts(schema, "c")).toBe(false)
		const stripped = strip(schema)
		// The stripped predicate matches every string, so "b" would select
		// then and fail its enum. The branches travel into the hint beside
		// the original predicate; the bare predicate stays - it asserts
		// nothing, so both values stay accepted.
		expect(stripped.if).toStrictEqual({ description: constraintNote({ pattern: "^a$" }) })
		expect(stripped).not.toHaveProperty("then")
		expect(stripped).not.toHaveProperty("else")
		expect(stripped.description).toBe(
			constraintNote({ if: { pattern: "^a$" }, then: { enum: ["a"] }, else: { enum: ["b"] } }),
		)
		expect(accepts(stripped, "a")).toBe(true)
		expect(accepts(stripped, "b")).toBe(true)
	})

	it("strips each subschema in tuple-form items", () => {
		expect(strip({ items: [{ type: "string", maxLength: 2 }, { type: "integer" }] })).toEqual({
			items: [{ type: "string", description: constraintNote({ maxLength: 2 }) }, { type: "integer" }],
		})
	})

	it.each([
		["default", { minimum: 1 }],
		["const", { maxLength: 2 }],
		["examples", [{ maxItems: 3 }]],
		["enum", [{ minimum: 0 }]],
		["anyOf", { maxLength: 1 }],
		["properties", [{ maxLength: 1 }]],
	])("does not treat the %s value %j as a schema", (keyword, value) => {
		const schema = { [keyword]: value }

		expect(strip(schema)).toEqual(schema)
	})

	it("keeps properties whose names match unsupported keywords", () => {
		expect(strip({ properties: { maxItems: { type: "integer" }, minimum: { type: "number" } } })).toEqual({
			properties: { maxItems: { type: "integer" }, minimum: { type: "number" } },
		})
	})

	it.each([
		["a missing", undefined],
		["an empty", ""],
		["a non-string", 42],
	])("uses only the constraint note for %s description", (_label, description) => {
		expect(strip({ type: "integer", description, minimum: 1 }).description).toBe(constraintNote({ minimum: 1 }))
	})

	it("appends the constraint note to an existing description", () => {
		expect(strip({ type: "integer", description: "Count.", minimum: 1 }).description).toBe(
			`Count.\n\n${constraintNote({ minimum: 1 })}`,
		)
	})

	it("records all removed constraints of one schema in one note", () => {
		expect(strip({ type: "number", minimum: 1, maximum: 9 })).toEqual({
			type: "number",
			description: constraintNote({ minimum: 1, maximum: 9 }),
		})
	})

	it("does not add a description when nothing is removed", () => {
		expect(strip({ type: "string" })).toEqual({ type: "string" })
	})

	it.each([
		["null", null],
		["a string", "text"],
		["a boolean", true],
		["an array", [{ maxLength: 1 }]],
	])("returns %s unchanged", (_label, value) => {
		expect(stripUnsupportedStrictKeywords(value)).toBe(value)
	})

	it("does not mutate the input schema", () => {
		const schema = {
			type: "object",
			properties: { name: { type: "string", maxLength: 5 } },
			additionalProperties: true,
		}
		const snapshot = structuredClone(schema)

		strip(schema)

		expect(schema).toEqual(snapshot)
	})

	it("moves a stripped oneOf under anyOf so single-alternative values stay accepted (review 4716476955)", () => {
		const schema: Schema = {
			type: "object",
			properties: { str: { oneOf: [{ pattern: "^a$" }, { pattern: "^b$" }] } },
			required: ["str"],
		}
		// Ground truth on the declared schema: "a" and "b" each match exactly
		// one alternative, "ab" matches none.
		expect(accepts(schema, { str: "a" })).toBe(true)
		expect(accepts(schema, { str: "b" })).toBe(true)
		expect(accepts(schema, { str: "ab" })).toBe(false)

		const compiled = strip(schema)
		const str = (compiled.properties as Schema).str as Schema & {
			anyOf?: Array<Record<string, unknown>>
			oneOf?: unknown
			allOf?: Array<Record<string, unknown> & { anyOf?: unknown[] }>
		}

		// The stripped alternatives are no longer exactly-one alternatives:
		// kept under oneOf every string would match both branches and the
		// property would reject every value, so the branches relax under
		// anyOf instead.
		expect(str).not.toHaveProperty("oneOf")
		expect(str.anyOf).toHaveLength(2)
		expect(str.anyOf?.[0]).not.toHaveProperty("pattern")
		expect(str.anyOf?.[1]).not.toHaveProperty("pattern")
		expect(String(str.anyOf?.[0]?.description)).toContain("^a$")
		expect(String(str.anyOf?.[1]?.description)).toContain("^b$")

		// The acceptance oracle proves the emitted schema still VALIDATES the
		// values the original accepted, not just that it changed shape.
		expect(accepts(compiled, { str: "a" })).toBe(true)
		expect(accepts(compiled, { str: "b" })).toBe(true)
	})

	it("keeps an unchanged oneOf exactly where it was (review 4716476955)", () => {
		const schema: Schema = {
			type: "object",
			properties: { str: { oneOf: [{ type: "string" }, { type: "integer" }] } },
			required: ["str"],
		}

		const compiled = strip(schema)
		const str = (compiled.properties as Schema).str as Schema

		// Nothing was stripped from the branches, so exactly-one semantics
		// still hold and the combinator must not move.
		expect(str.oneOf).toStrictEqual([{ type: "string" }, { type: "integer" }])
		expect(str).not.toHaveProperty("anyOf")
	})

	it("moves a stripped oneOf beside an unchanged allOf sibling without absorbing it (review 4716476955)", () => {
		const schema: Schema = {
			type: "object",
			properties: {
				str: {
					allOf: [{ type: "string" }],
					oneOf: [{ pattern: "^a$" }, { pattern: "^b$" }],
				},
			},
			required: ["str"],
		}

		const compiled = strip(schema)
		const str = (compiled.properties as Schema).str as Schema & {
			anyOf?: Array<Record<string, unknown>>
			oneOf?: unknown
			allOf?: Array<Record<string, unknown> & { anyOf?: unknown[] }>
		}

		// The unchanged allOf stays its own conjunct; the relaxed branches
		// arrive as one additional allOf member.
		expect(str).not.toHaveProperty("oneOf")
		expect(str.allOf).toHaveLength(2)
		expect(str.allOf?.[0]).toStrictEqual({ type: "string" })
		expect(str.allOf?.[1]?.anyOf).toHaveLength(2)
	})

	it("rewrites references that name a relocated oneOf (review 4725679725)", () => {
		const schema: Schema = {
			type: "object",
			properties: { choice: { $ref: "#/$defs/Choice/oneOf/0" } },
			required: ["choice"],
			$defs: { Choice: { oneOf: [{ type: "string", pattern: "^a$" }, { type: "integer" }] } },
		}
		const stripped = strip(schema)
		// The pattern leaves branch zero, the branches relax under anyOf,
		// and the reference must name the branch's new location - the old
		// oneOf position no longer exists in the emitted document.
		const choice = (stripped.properties as Schema).choice as Schema
		expect(choice.$ref).toBe("#/$defs/Choice/anyOf/0")
	})

	it("rewrites references when the relocated oneOf joins an allOf conjunct (review 4725679725)", () => {
		const schema: Schema = {
			type: "object",
			properties: { choice: { $ref: "#/$defs/Choice/oneOf/1" } },
			required: ["choice"],
			$defs: {
				Choice: {
					allOf: [{ type: "string" }],
					oneOf: [
						{ type: "string", pattern: "^a$" },
						{ type: "integer", minimum: 1 },
					],
				},
			},
		}
		const stripped = strip(schema)
		// With an allOf sibling the relaxed branches become the second
		// conjunct's anyOf; the reference follows that path and keeps the
		// branch index.
		const choice = (stripped.properties as Schema).choice as Schema
		expect(choice.$ref).toBe("#/$defs/Choice/allOf/1/anyOf/1")
	})

	it("rewrites a nested reference while keeping unrelated pointers untouched (review 4725679725)", () => {
		const schema: Schema = {
			type: "object",
			properties: {
				choice: {
					allOf: [{ $ref: "#/$defs/Choice/oneOf/0/properties/inner" }],
				},
				other: { $ref: "#/$defs/Plain" },
			},
			required: ["choice", "other"],
			$defs: {
				Choice: { oneOf: [{ type: "string", pattern: "^a$" }, { type: "integer" }] },
				Plain: { type: "string" },
			},
		}
		const stripped = strip(schema)
		const choice = (stripped.properties as Schema).choice as Schema
		const inner = (choice.allOf as Schema[])[0] as Schema
		// The pointer's suffix below the relocated position survives; a
		// pointer naming an unrelocated position stays verbatim.
		expect(inner.$ref).toBe("#/$defs/Choice/anyOf/0/properties/inner")
		const other = (stripped.properties as Schema).other as Schema
		expect(other.$ref).toBe("#/$defs/Plain")
	})

	it("relocates a reference inside a property named const (review 4726104168)", () => {
		const schema: Schema = {
			type: "object",
			properties: {
				const: { $ref: "#/$defs/Choice/oneOf/0" },
				ordinary: { $ref: "#/$defs/Choice/oneOf/0" },
			},
			required: ["const", "ordinary"],
			$defs: { Choice: { oneOf: [{ type: "string", pattern: "^a$" }, { type: "integer" }] } },
		}
		const stripped = strip(schema)
		const props = stripped.properties as Schema
		// Entries under properties are schemas, whatever their names: the
		// property named "const" carries a reference that must relocate
		// exactly like the sibling's.
		expect((props.const as Schema).$ref).toBe("#/$defs/Choice/anyOf/0")
		expect((props.ordinary as Schema).$ref).toBe("#/$defs/Choice/anyOf/0")
	})

	it("keeps a $ref-shaped literal object inside a const keyword verbatim (review 4726104168)", () => {
		const schema: Schema = {
			type: "object",
			properties: { pick: { const: { $ref: "#/$defs/Choice/oneOf/0" } } },
			required: ["pick"],
			$defs: { Choice: { oneOf: [{ type: "string", pattern: "^a$" }, { type: "integer" }] } },
		}
		const stripped = strip(schema)
		const pick = (stripped.properties as Schema).pick as Schema
		// A const value is asserted data, not a document location: the
		// whole literal object survives byte for byte even though the
		// location moved. The object shape is what exercises the literal
		// guard - a bare string would come back unchanged even with the
		// guard removed, because the walker never rewrites strings
		// (review 4726390993).
		expect(pick.const).toStrictEqual({ $ref: "#/$defs/Choice/oneOf/0" })
	})

	it("escapes a map name when recording the relocation prefix (review 4726104169)", () => {
		const schema: Schema = {
			type: "object",
			properties: { choice: { $ref: "#/$defs/A~1B~0Slash/oneOf/0" } },
			required: ["choice"],
			$defs: {
				"A/B~Slash": { oneOf: [{ type: "string", pattern: "^a$" }, { type: "integer" }] },
			},
		}
		const stripped = strip(schema)
		const choice = (stripped.properties as Schema).choice as Schema
		// The recorded relocation prefix must carry the RFC 6901 escapes the
		// reference uses, or the pointer would keep naming the removed oneOf.
		expect(choice.$ref).toBe("#/$defs/A~1B~0Slash/anyOf/0")
	})

	it("drops a negation whose predicate is a reference to a changed target (review 4726104174)", () => {
		const schema: Schema = {
			type: "object",
			properties: { v: { not: { $ref: "#/$defs/P" } } },
			required: ["v"],
			$defs: { P: { type: "string", pattern: "^a$" } },
		}
		// Ground truth on the declared schema: P rejects "b", so the
		// negation accepts it - and P matches "a", so the negation
		// rejects it. The rejection half needs the document root in the
		// recursive oracle call, or the reference could not resolve
		// (review 4726390991).
		expect(accepts((schema.properties as Schema).v, "b", schema)).toBe(true)
		expect(accepts((schema.properties as Schema).v, "a", schema)).toBe(false)
		const stripped = strip(schema)
		const v = (stripped.properties as Schema).v as Schema
		// The pattern leaves P where it is declared; the retained negation
		// would apply the widened P and reject "b", which the original
		// accepted. The negation drops into the hint.
		expect(v).not.toHaveProperty("not")
		expect(v.description).toBe(constraintNote({ not: { $ref: "#/$defs/P" } }))
		expect(accepts(v, "b", stripped)).toBe(true)
	})

	it("keeps a negation whose referenced target strips unchanged (review 4726104174 control)", () => {
		const schema: Schema = {
			type: "object",
			properties: { v: { not: { $ref: "#/$defs/P" } } },
			required: ["v"],
			$defs: { P: { type: "string" } },
		}
		const stripped = strip(schema)
		const v = (stripped.properties as Schema).v as Schema
		// The target compiles unchanged, so the negation stays exactly as
		// declared - the passing control.
		expect(v).toStrictEqual({ not: { $ref: "#/$defs/P" } })
	})

	it("drops the branches of a conditional whose predicate references a changed target (review 4726104174)", () => {
		const schema: Schema = {
			type: "string",
			if: { $ref: "#/$defs/P" },
			then: { enum: ["a"] },
			else: { enum: ["b"] },
			$defs: { P: { pattern: "^a$" } },
		}
		// Ground truth: "a" selects then and passes, "b" selects else and
		// passes, "c" selects else and fails the enum.
		expect(accepts(schema, "a")).toBe(true)
		expect(accepts(schema, "b")).toBe(true)
		expect(accepts(schema, "c")).toBe(false)
		const stripped = strip(schema)
		// The predicate object itself is only a $ref, so it strips
		// unchanged - the change is visible only through the target. The
		// branch selection flips anyway, so the branches travel into the
		// hint and both values stay accepted.
		expect(stripped).not.toHaveProperty("then")
		expect(stripped).not.toHaveProperty("else")
		expect(stripped.description).toBe(
			constraintNote({ if: { $ref: "#/$defs/P" }, then: { enum: ["a"] }, else: { enum: ["b"] } }),
		)
		expect(accepts(stripped, "a")).toBe(true)
		expect(accepts(stripped, "b")).toBe(true)
	})

	it("relaxes a oneOf whose branch references a changed target (review 4726104174)", () => {
		const schema: Schema = {
			type: "object",
			properties: { v: { oneOf: [{ $ref: "#/$defs/P" }, { type: "string" }] } },
			required: ["v"],
			$defs: { P: { type: "string", pattern: "^a$" } },
		}
		// Ground truth: "bb" matches exactly one declared branch (the plain
		// string; the pattern keeps it out of P).
		expect(accepts((schema.properties as Schema).v, "bb", schema)).toBe(true)
		const stripped = strip(schema)
		const v = (stripped.properties as Schema).v as Schema
		// P's pattern leaves: every string now matches both branches and the
		// retained exactly-one rule would accept nothing, so the branches
		// relax under anyOf.
		expect(v).not.toHaveProperty("oneOf")
		expect(v.anyOf).toBeDefined()
		expect(accepts(v, "bb", stripped)).toBe(true)
	})

	it("repairs a reference into a removed negation (review 4726104178)", () => {
		const schema: Schema = {
			type: "object",
			properties: {
				v: { not: { type: "string", minLength: 1 } },
				w: { $ref: "#/properties/v/not" },
			},
			required: ["v", "w"],
		}
		const stripped = strip(schema)
		const props = stripped.properties as Schema
		// The negation drops into the hint (its subtree changed), so the
		// pointer into it would dangle. The repair drops the pointer and
		// records the fix; the property stays maximally permissive.
		expect(props.v).not.toHaveProperty("not")
		const w = props.w as Schema
		expect(w).not.toHaveProperty("$ref")
		expect(w.description).toBe("Unresolvable reference #/properties/v/not removed (its target was stripped)")
		expect(accepts(w, "anything")).toBe(true)
	})

	it("repairs a reference into a removed conditional branch (review 4726104178)", () => {
		const schema: Schema = {
			type: "object",
			properties: {
				gate: { if: { pattern: "^a$" }, then: { enum: ["a"] } },
				w: { $ref: "#/properties/gate/then" },
			},
			required: ["gate", "w"],
		}
		const stripped = strip(schema)
		const props = stripped.properties as Schema
		// The stripped predicate flips branch selection, the branch travels
		// into the hint, and the reference into the removed location is
		// repaired the same way.
		const w = props.w as Schema
		expect(w).not.toHaveProperty("$ref")
		expect(w.description).toBe("Unresolvable reference #/properties/gate/then removed (its target was stripped)")
	})

	it("leaves a pointer that never resolved in the declared schema untouched (review 4726104178)", () => {
		const schema: Schema = {
			type: "object",
			properties: { w: { $ref: "#/nowhere" }, guarded: { type: "string", pattern: "^a$" } },
			required: ["w"],
		}
		const stripped = strip(schema)
		const props = stripped.properties as Schema
		// The sibling pattern is what makes the repair pass run at all:
		// with no strip change the pass never starts, and the test would
		// stay green even if repair deleted every unresolved pointer
		// (review 4726390997). The pattern leaves; the pointer was already
		// broken before the strip, so repairing it is out of scope and the
		// verbatim pointer stays.
		expect(props.guarded).not.toHaveProperty("pattern")
		const w = props.w as Schema
		expect(w.$ref).toBe("#/nowhere")
		expect(w).not.toHaveProperty("description")
	})

	it("relaxes unevaluatedProperties when a dropped branch evaluated the extra key (review 4726391005)", () => {
		const schema: Schema = {
			type: "object",
			if: { properties: { kind: { pattern: "^a$" } } },
			then: { properties: { x: { type: "string" } } },
			unevaluatedProperties: false,
		}
		const stripped = strip(schema)
		// The predicate strips (its pattern leaves), so the branch travels
		// into the hint - and with it the evaluation of x, which no
		// retained keyword performs. The closed rule would forbid every
		// object carrying x, which the original accepted; it relaxes
		// instead.
		expect(stripped).not.toHaveProperty("then")
		expect(stripped.unevaluatedProperties).toBe(true)
		expect(String(stripped.description)).toContain("then")
	})

	it("keeps unevaluatedProperties when no dropped branch evaluated keys (review 4726391005 control)", () => {
		const schema: Schema = {
			type: "object",
			if: { properties: { kind: { pattern: "^a$" } } },
			then: { const: "a" },
			unevaluatedProperties: false,
		}
		const stripped = strip(schema)
		// The branch dropped, but a const evaluates no keys: the closed
		// rule is an ordinary one and stays.
		expect(stripped).not.toHaveProperty("then")
		expect(stripped.unevaluatedProperties).toBe(false)
	})

	it("relocates a percent-encoded reference to a moved rule (review 4726391009)", () => {
		const schema: Schema = {
			type: "object",
			properties: { pick: { $ref: "#/$defs/A%20B/oneOf/0" } },
			required: ["pick"],
			// The definition name is "A B": the relocation prefix records
			// the raw name, while the pointer writes it percent-encoded.
			$defs: { "A B": { oneOf: [{ type: "string", pattern: "^a$" }, { type: "integer" }] } },
		}
		const stripped = strip(schema)
		const pick = (stripped.properties as Schema).pick as Schema
		// The pointer follows the branches to their anyOf position and
		// stays percent-encoded, so it still names the branch that
		// applies the string type (RFC 6901 section 6).
		expect(pick.$ref).toBe("#/$defs/A%20B/anyOf/0")
		expect(accepts(pick, "bb", stripped)).toBe(true)
		expect(accepts(pick, 5, stripped)).toBe(false)
	})

	it("keeps a property named __proto__ across a strip that repairs pointers (review 4726391002)", () => {
		// The computed key makes "__proto__" an OWN data property, the way
		// a caller's JSON.parse'd tool schema arrives - a plain literal
		// key would set the prototype instead.
		const schema: Schema = {
			type: "object",
			properties: {
				["__proto__"]: { type: "string", title: "legacy" },
				guarded: { type: "string", pattern: "^a$" },
				move: {
					oneOf: [{ type: "string", pattern: "^m$" }, { type: "integer" }],
				},
			},
			required: ["guarded", "move"],
		}
		const stripped = strip(schema)
		const props = stripped.properties as Schema
		// The repair and relocation walks rebuild every node: a plain
		// assignment would invoke the inherited setter and silently drop
		// the entry, so the emitted schema loses the property map. Both
		// walks create own properties instead.
		expect(Object.prototype.hasOwnProperty.call(props, "__proto__")).toBe(true)
		expect(props.__proto__).toStrictEqual({ type: "string", title: "legacy" })
		expect(props.guarded).not.toHaveProperty("pattern")
		expect((props.move as Schema).anyOf).toBeDefined()
	})

	it("applies every ancestor relocation to a nested moved reference (review 4728045843)", () => {
		const schema: Schema = {
			type: "object",
			properties: { pick: { $ref: "#/$defs/Choice/oneOf/0/oneOf/0" } },
			required: ["pick"],
			$defs: {
				Choice: {
					// The inner branch loses its pattern, so the inner
					// oneOf relaxes under anyOf; the changed branch
					// object then also strips the outer oneOf under
					// anyOf. Both relocations must compose.
					oneOf: [{ oneOf: [{ type: "string", pattern: "^a" }, { type: "number" }] }, { type: "boolean" }],
				},
			},
		}
		const stripped = strip(schema)
		const pick = (stripped.properties as Schema).pick as Schema
		// The inner move applies first, then the enclosing move applies
		// to the updated segments: a loop that stopped at the first
		// match emits the inner rewrite alone, and the pointer dangles
		// on the outer oneOf location the emitted schema no longer has.
		expect(pick.$ref).toBe("#/$defs/Choice/anyOf/0/anyOf/0")
		expect(accepts(pick, "aa", stripped)).toBe(true)
	})

	it("relaxes unevaluatedItems when a dropped conditional branch evaluated items (review 4728045848)", () => {
		const schema: Schema = {
			type: "array",
			if: { minItems: 2 },
			then: { prefixItems: [true, true] },
			else: { prefixItems: [true] },
			unevaluatedItems: false,
		}
		const stripped = strip(schema)
		// minItems leaves the predicate, both branches drop, and the
		// prefixItems rules were what evaluated the leading items: the
		// retained unevaluatedItems: false would reject an item no
		// remaining keyword evaluates, so it relaxes.
		expect(stripped.unevaluatedItems).toBe(true)
		expect(stripped.then).toBeUndefined()
		expect(stripped.else).toBeUndefined()
	})

	it("keeps unevaluatedItems when the conditional's predicate strips unchanged (review 4728045848 control)", () => {
		const schema: Schema = {
			type: "array",
			if: { minItems: 1 },
			then: { prefixItems: [true] },
			else: { prefixItems: [true, true] },
			unevaluatedItems: false,
		}
		const stripped = strip(schema)
		// minItems: 1 is a supported value: nothing is removed, the
		// branches stay, and the closed-array rule is an ordinary one.
		expect(stripped.unevaluatedItems).toBe(false)
		expect(stripped.then).toStrictEqual({ prefixItems: [true] })
	})

	it("propagates conditional evaluation loss to an enclosing allOf closure (review 4728045852)", () => {
		const schema: Schema = {
			type: "object",
			allOf: [
				{
					if: { properties: { kind: { pattern: "^a$" } } },
					then: { properties: { x: { type: "string" } } },
				},
			],
			unevaluatedProperties: false,
		}
		const stripped = strip(schema)
		// The conjunct applies at the root instance location, so the x
		// evaluations its dropped then branch performed leave the root:
		// a closure relaxation on the conditional's own node alone
		// leaves the root rule stranded, and it would reject a value
		// the original accepted. The root closure relaxes through the
		// same-instance allOf hop.
		expect(stripped.unevaluatedProperties).toBe(true)
	})

	it("keeps an allOf closure when the conjunct's conditional strips unchanged (review 4728045852 control)", () => {
		const schema: Schema = {
			type: "object",
			allOf: [
				{
					if: { properties: { kind: { type: "string" } } },
					then: { properties: { x: { type: "string" } } },
				},
			],
			unevaluatedProperties: false,
		}
		const stripped = strip(schema)
		// Nothing is removed anywhere: the branches stay and the closed
		// root rule is an ordinary one.
		expect(stripped.unevaluatedProperties).toBe(false)
	})

	it.each([
		["anyOf with a failing sibling type", { type: "string", anyOf: [{}] }, 1, false],
		["anyOf with a passing sibling type", { type: "string", anyOf: [{}] }, "ok", true],
		["oneOf with a failing sibling pattern", { oneOf: [{}], pattern: "^a$" }, "bb", false],
		["oneOf with a passing sibling pattern", { oneOf: [{}], pattern: "^a$" }, "a", true],
		["allOf with a failing sibling type", { allOf: [{}], type: "number" }, "x", false],
		["allOf with a passing sibling type", { allOf: [{}], type: "number" }, 3, true],
		["an empty negation rejects every value", { not: {}, type: "number" }, 5, false],
		["not combines with a passing sibling type", { not: { type: "string" }, type: "number" }, 5, true],
		["enum accepts a listed value", { enum: ["a", "b"] }, "a", true],
		["enum rejects an unlisted value", { enum: ["a", "b"] }, "c", false],
		["if selects then", { if: { pattern: "^a$" }, then: { enum: ["a"] } }, "a", true],
		["if selects else", { if: { pattern: "^a$" }, else: { enum: ["b"] } }, "b", true],
		[
			"the selected branch rejects",
			{ if: { pattern: "^a$" }, then: { enum: ["a"] }, else: { enum: ["b"] } },
			"c",
			false,
		],
		["a bare if asserts nothing", { if: { pattern: "^a$" } }, "zz", true],
	])("accepts: %s", (_name, schema, value, expected) => {
		// Sibling constraints apply together with the combinator result
		// (Draft 2020-12): the acceptance oracle must never let a
		// combinator's early verdict skip the sibling keywords.
		expect(accepts(schema, value)).toBe(expected)
	})
})
