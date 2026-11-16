// npx vitest run api/transform/__tests__/strict-tool-schema.spec.ts

import { stripUnsupportedStrictKeywords } from "../strict-tool-schema"

type Schema = Record<string, unknown>

function strip(schema: Schema): Schema {
	return stripUnsupportedStrictKeywords(schema) as Schema
}

function constraintNote(removed: Schema): string {
	return `Constraints: ${JSON.stringify(removed)}`
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

	it.each(["anyOf", "oneOf", "allOf", "prefixItems"])("strips each subschema in the %s list", (keyword) => {
		expect(strip({ [keyword]: [{ type: "integer", minimum: 0 }, { type: "null" }] })).toEqual({
			[keyword]: [{ type: "integer", description: constraintNote({ minimum: 0 }) }, { type: "null" }],
		})
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
})
