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
 * fixtures use (type, pattern, required/properties, oneOf/anyOf/allOf). It
 * encodes JSON Schema semantics - not the stripper's rules - so a test can
 * assert that values the declared schema accepted still validate after
 * stripping.
 */
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

function accepts(schema: unknown, value: unknown): boolean {
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
		return true
	}
	const s = schema as Schema
	if (Array.isArray(s.oneOf)) {
		return s.oneOf.filter((branch) => accepts(branch, value)).length === 1
	}
	if (Array.isArray(s.anyOf)) {
		return s.anyOf.some((branch) => accepts(branch, value))
	}
	if (Array.isArray(s.allOf)) {
		return s.allOf.every((branch) => accepts(branch, value))
	}
	if (typeof s.type === "string" && !matchesType(s.type, value)) {
		return false
	}
	if (typeof s.pattern === "string") {
		if (typeof value !== "string" || !new RegExp(s.pattern).test(value)) {
			return false
		}
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
		if (key in object && !accepts(sub, object[key])) {
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

	it("keeps a oneOf under not in place so the negated set keeps accepting (review 4719419437)", () => {
		const stripped = strip({
			type: "object",
			properties: { v: { not: { oneOf: [{ type: "string", minLength: 1 }, { type: "string" }] } } },
			required: ["v"],
		})
		const negated = ((stripped.properties as Schema).v as Schema).not as Schema
		// The oneOf keeps its position with the hint on the branch that lost
		// a constraint: moved under anyOf, the negated predicate would match
		// every string and the negation would reject values the original
		// accepted ("a" matches both original branches, so the oneOf refuses
		// it and the not accepts it).
		expect(negated.oneOf).toStrictEqual([
			{ type: "string", description: constraintNote({ minLength: 1 }) },
			{ type: "string" },
		])
		expect(negated).not.toHaveProperty("anyOf")
		// accepts() encodes the combinator semantics, not the stripper's
		// rules: the kept exactly-one rule still refuses the overlapping
		// branch pair, so the enclosing not keeps accepting "a".
		expect(accepts(negated, "a")).toBe(false)
	})

	it("still moves a stripped oneOf beside a not-toggling double negation (review 4719419437)", () => {
		// not (not (changed oneOf)) is the oneOf's own position again: the
		// relaxation applies there, only the directly negated subtree keeps
		// the oneOf.
		const stripped = strip({ not: { not: { oneOf: [{ type: "integer", minimum: 0 }, { type: "null" }] } } })
		const inner = (stripped.not as Schema).not as Schema
		expect(inner.anyOf).toStrictEqual([
			{ type: "integer", description: constraintNote({ minimum: 0 }) },
			{ type: "null" },
		])
		expect(inner).not.toHaveProperty("oneOf")
	})

	it.each([
		"items",
		"additionalItems",
		"unevaluatedItems",
		"unevaluatedProperties",
		"propertyNames",
		"not",
		"if",
		"then",
		"else",
	])("strips the %s subschema", (keyword) => {
		expect(strip({ [keyword]: { type: "string", minLength: 1 } })).toEqual({
			[keyword]: { type: "string", description: constraintNote({ minLength: 1 }) },
		})
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
})
