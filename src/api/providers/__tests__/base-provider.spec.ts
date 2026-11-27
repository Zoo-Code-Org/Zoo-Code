import { Anthropic } from "@anthropic-ai/sdk"

import type { ModelInfo } from "@roo-code/types"

import { BaseProvider } from "../base-provider"
import type { ApiStream } from "../../transform/stream"
import { expectNoLoneSurrogates } from "../../../test-utils/surrogates"
import { flushMacrotasks } from "../../../test-utils/timers"

// A minimal JSON Schema acceptance oracle for the constructs the strict
// conversion emits (type, enum, anyOf/oneOf). It answers "does this property
// schema accept the value", the same question a Draft 2020-12 validator asks.
// Mock evidence only: no live API request.
const isSchemaNode = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

// The JSON Schema type of a value: an array is "array", not the typeof
// "object" (#2653 review 4680624688), an integer is distinct from other
// numbers, and null is its own type.
const schemaTypeOf = (value: unknown): string => {
	if (value === null) {
		return "null"
	}
	if (Array.isArray(value)) {
		return "array"
	}
	if (typeof value === "number") {
		return Number.isInteger(value) ? "integer" : "number"
	}
	return typeof value
}

const acceptsValue = (schema: unknown, value: unknown): boolean => {
	if (schema === true) {
		return true
	}
	if (!isSchemaNode(schema)) {
		return false
	}
	// Draft 2020-12: sibling constraints apply together, and oneOf requires
	// exactly one matching alternative (#547 review). Evaluate every
	// applicable keyword instead of returning early on the first.
	let accepts = true
	if (Array.isArray(schema.anyOf)) {
		accepts = accepts && schema.anyOf.some((alternative) => acceptsValue(alternative, value))
	}
	if (accepts && Array.isArray(schema.oneOf)) {
		const matching = schema.oneOf.filter((alternative) => acceptsValue(alternative, value))
		accepts = accepts && matching.length === 1
	}
	if (accepts && schema.type !== undefined) {
		const types: unknown[] = Array.isArray(schema.type) ? schema.type : [schema.type]
		const jsType = schemaTypeOf(value)
		// Draft 2020-12: an integer is also a number (#2653 review
		// 4682419243), so a "number" constraint accepts integer values too.
		const matches = types.includes(jsType) || (jsType === "integer" && types.includes("number"))
		if (!matches) {
			accepts = false
		}
	}
	if (accepts && Array.isArray(schema.enum) && !schema.enum.includes(value)) {
		accepts = false
	}
	return accepts
}

// Create a concrete implementation for testing
class TestProvider extends BaseProvider {
	createMessage(_systemPrompt: string, _messages: Anthropic.Messages.MessageParam[]): ApiStream {
		throw new Error("Not implemented")
	}

	getModel(): { id: string; info: ModelInfo } {
		return {
			id: "test-model",
			info: {
				maxTokens: 4096,
				contextWindow: 128000,
				supportsPromptCache: false,
			},
		}
	}

	// Expose protected method for testing
	public testConvertToolSchemaForOpenAI(schema: any): any {
		return this.convertToolSchemaForOpenAI(schema)
	}

	// Expose protected method for testing
	public testConvertToolsForOpenAI(tools: any[] | undefined, strict?: boolean): any[] | undefined {
		return this.convertToolsForOpenAI(tools, strict)
	}

	// Expose protected method for testing
	public testEnsureCatalogLoaded(load: () => Promise<boolean | void>, signal?: AbortSignal): Promise<void> {
		return this.ensureCatalogLoaded(load, signal)
	}
}

describe("BaseProvider", () => {
	let provider: TestProvider

	beforeEach(() => {
		provider = new TestProvider()
	})

	describe("convertToolSchemaForOpenAI", () => {
		it("should add additionalProperties: false to object schemas", () => {
			const schema = {
				type: "object",
				properties: {
					name: { type: "string" },
				},
			}

			const result = provider.testConvertToolSchemaForOpenAI(schema)

			expect(result.additionalProperties).toBe(false)
		})

		it("should add required array with all properties for strict mode", () => {
			const schema = {
				type: "object",
				properties: {
					name: { type: "string" },
					age: { type: "number" },
				},
			}

			const result = provider.testConvertToolSchemaForOpenAI(schema)

			expect(result.required).toEqual(["name", "age"])
		})

		it("should recursively add additionalProperties: false to nested objects", () => {
			const schema = {
				type: "object",
				properties: {
					user: {
						type: "object",
						properties: {
							name: { type: "string" },
						},
					},
				},
			}

			const result = provider.testConvertToolSchemaForOpenAI(schema)

			expect(result.additionalProperties).toBe(false)
			expect(result.properties.user.additionalProperties).toBe(false)
		})

		it("should recursively add additionalProperties: false to array item objects", () => {
			const schema = {
				type: "object",
				properties: {
					users: {
						type: "array",
						items: {
							type: "object",
							properties: {
								name: { type: "string" },
							},
						},
					},
				},
			}

			const result = provider.testConvertToolSchemaForOpenAI(schema)

			expect(result.additionalProperties).toBe(false)
			expect(result.properties.users.items.additionalProperties).toBe(false)
		})

		it("should handle deeply nested objects", () => {
			const schema = {
				type: "object",
				properties: {
					level1: {
						type: "object",
						properties: {
							level2: {
								type: "object",
								properties: {
									level3: {
										type: "object",
										properties: {
											value: { type: "string" },
										},
									},
								},
							},
						},
					},
				},
			}

			const result = provider.testConvertToolSchemaForOpenAI(schema)

			expect(result.additionalProperties).toBe(false)
			expect(result.properties.level1.additionalProperties).toBe(false)
			expect(result.properties.level1.properties.level2.additionalProperties).toBe(false)
			expect(result.properties.level1.properties.level2.properties.level3.additionalProperties).toBe(false)
		})

		it("should convert nullable types to non-nullable", () => {
			const schema = {
				type: "object",
				required: ["name"],
				properties: {
					name: { type: ["string", "null"] },
				},
			}

			const result = provider.testConvertToolSchemaForOpenAI(schema)

			expect(result.properties.name.type).toBe("string")
		})

		it("should return non-object schemas unchanged", () => {
			const schema = { type: "string" }
			const result = provider.testConvertToolSchemaForOpenAI(schema)

			expect(result).toEqual(schema)
		})

		it("should return null/undefined unchanged", () => {
			expect(provider.testConvertToolSchemaForOpenAI(null)).toBeNull()
			expect(provider.testConvertToolSchemaForOpenAI(undefined)).toBeUndefined()
		})

		it("should handle empty properties object", () => {
			const schema = {
				type: "object",
				properties: {},
			}

			const result = provider.testConvertToolSchemaForOpenAI(schema)

			expect(result.additionalProperties).toBe(false)
			expect(result.required).toEqual([])
		})
	})

	it("leaves property entries that are not objects unchanged", () => {
		const schema = {
			type: "object",
			properties: {
				broken: null,
				list: ["string", "null"],
				note: "plain",
			},
		}

		const result = provider.testConvertToolSchemaForOpenAI(schema)

		// The clone guard only normalises object entries, so a null entry, an
		// array-valued entry and a plain string entry are passed through as declared.
		expect(result.properties.broken).toBe(null)
		expect(result.properties.list).toEqual(["string", "null"])
		expect(result.properties.note).toBe("plain")
	})

	it("keeps a nullable type with more than one non-null type as an array", () => {
		const schema = {
			type: "object",
			required: ["value"],
			properties: {
				value: { type: ["string", "null", "number"] },
			},
		}

		const result = provider.testConvertToolSchemaForOpenAI(schema)

		expect(result.properties.value.type).toEqual(["string", "number"])
	})

	it("does not treat a plain property as an array of objects", () => {
		const schema = {
			type: "object",
			properties: {
				path: { type: "string" },
			},
		}

		const result = provider.testConvertToolSchemaForOpenAI(schema)

		// Only array properties get an items conversion, so a plain property
		// keeps exactly the keys it declared.
		expect(Object.keys(result.properties.path)).toEqual(["type"])
	})

	it("does not convert items on a non-array property that carries object items", () => {
		const schema = {
			type: "object",
			properties: {
				weird: {
					type: "string",
					items: { type: "object", properties: { a: { type: "string" } } },
				},
			},
		}

		const result = provider.testConvertToolSchemaForOpenAI(schema)

		expect(result.properties.weird.items.additionalProperties).toBeUndefined()
	})

	it("leaves an array property without items unchanged", () => {
		const schema = {
			type: "object",
			properties: {
				tags: { type: "array" },
			},
		}

		const result = provider.testConvertToolSchemaForOpenAI(schema)

		expect(Object.keys(result.properties.tags)).toEqual(["type"])
	})

	it("leaves a property whose type is only null unchanged", () => {
		const schema = {
			type: "object",
			properties: {
				only: { type: "null" },
			},
		}

		const result = provider.testConvertToolSchemaForOpenAI(schema)

		// The nullable branch only handles array types; a bare null type is not a
		// list to filter.
		expect(result.properties.only.type).toBe("null")
	})

	describe("strict optional parameters (#547)", () => {
		it("recurses into nested combinator wrappers before appending a null alternative (#2653 review 4674816413)", () => {
			// The outer alternative is a bare nested-anyOf wrapper: it has no
			// type or enum of its own, so only recursion can see that neither
			// inner alternative accepts null.
			const schema = {
				type: "object",
				properties: {
					format: { anyOf: [{ anyOf: [{ type: "string" }, { type: "integer" }] }] },
				},
			}

			const result = provider.testConvertToolSchemaForOpenAI(schema)

			const prop = result.properties.format
			// The nested wrapper rejected null, so the outer anyOf gains a
			// null alternative — the only null match under exactly-one.
			expect(prop.anyOf).toEqual([{ anyOf: [{ type: "string" }, { type: "integer" }] }, { type: "null" }])
			expect(acceptsValue(prop, null)).toBe(true)
			expect(acceptsValue(prop, "docx")).toBe(true)
			expect(acceptsValue(prop, 7)).toBe(true)
		})

		it("does not add a null alternative when a nested combinator already accepts null (#2653 review 4674816413)", () => {
			const schema = {
				type: "object",
				properties: {
					format: { anyOf: [{ anyOf: [{ type: "string" }, { type: "null" }] }] },
				},
			}

			const result = provider.testConvertToolSchemaForOpenAI(schema)

			const prop = result.properties.format
			// The inner alternative accepts null, so the outer wrapper does
			// too — appending would make null match twice under exactly-one.
			expect(prop.anyOf).toEqual([{ anyOf: [{ type: "string" }, { type: "null" }] }])
			expect(acceptsValue(prop, null)).toBe(true)
			expect(acceptsValue(prop, "docx")).toBe(true)
		})

		it("appends a null alternative when a nested oneOf matches null twice (#2653 review 4675120035)", () => {
			// The nested oneOf rejects null under exactly-one semantics (both
			// inner alternatives match), so the wrapper must NOT report
			// acceptance and the outer anyOf must gain a null alternative.
			const schema = {
				type: "object",
				properties: {
					format: { anyOf: [{ oneOf: [{ type: ["string", "null"] }, { type: ["integer", "null"] }] }] },
				},
			}

			const result = provider.testConvertToolSchemaForOpenAI(schema)

			const prop = result.properties.format
			expect(prop.anyOf).toEqual([
				{ oneOf: [{ type: ["string", "null"] }, { type: ["integer", "null"] }] },
				{ type: "null" },
			])
			expect(acceptsValue(prop, null)).toBe(true)
			// Valid non-null values are unchanged.
			expect(acceptsValue(prop, "docx")).toBe(true)
			expect(acceptsValue(prop, 7)).toBe(true)
		})

		it("normalizes the original object before wrapping a multi-match oneOf (#2653 review 4675158952)", () => {
			// A wrapped object-typed original leaves no effective type for the
			// recursion below, so its inner object must be normalized before
			// the wrap.
			const schema = {
				type: "object",
				properties: {
					value: {
						type: "object",
						properties: { limit: { type: "integer" } },
						oneOf: [{ type: ["object", "null"] }, { type: ["string", "null"] }],
					},
				},
			}

			const result = provider.testConvertToolSchemaForOpenAI(schema)

			const prop = result.properties.value
			expect(prop.anyOf).toHaveLength(2)
			const original = prop.anyOf[0]
			// The original carries the strict object constraints.
			expect(original.additionalProperties).toBe(false)
			expect(original.required).toEqual(["limit"])
			// Its inner optional property is nullable.
			expect(original.properties.limit.type).toEqual(["integer", "null"])
			// The original keeps its declared (nullable) type; null is
			// accepted through the outer alternative.
			expect(original.type).toEqual(["object", "null"])
			expect(prop.anyOf[1]).toEqual({ type: "null" })
			expect(acceptsValue(prop, null)).toBe(true)
		})

		it("normalizes array-item objects before wrapping a multi-match oneOf (#2653 review 4675584064)", () => {
			// The wrapper leaves no effective type, so the recursion below
			// never reaches the items object — it must be normalized before
			// the wrap, while the declared (nullable) array type and the
			// outer null alternative are preserved.
			const schema = {
				type: "object",
				properties: {
					value: {
						type: "array",
						items: { type: "object", properties: { limit: { type: "integer" } } },
						oneOf: [{ type: ["array", "null"] }, { type: ["string", "null"] }],
					},
				},
			}

			const result = provider.testConvertToolSchemaForOpenAI(schema)

			const prop = result.properties.value
			expect(prop.anyOf).toHaveLength(2)
			const original = prop.anyOf[0]
			// The array original keeps its declared (nullable) type.
			expect(original.type).toEqual(["array", "null"])
			// Its items object carries the strict constraints.
			expect(original.items.additionalProperties).toBe(false)
			expect(original.items.required).toEqual(["limit"])
			expect(original.items.properties.limit.type).toEqual(["integer", "null"])
			// Null stays accepted through the outer alternative only.
			expect(prop.anyOf[1]).toEqual({ type: "null" })
			expect(acceptsValue(prop, null)).toBe(true)
			// Non-null arrays still validate against the wrapped original:
			// its array type and inner oneOf admit them (#2653 review
			// 4680624688). The array-aware oracle classifies [] as
			// "array", not "object".
			expect(acceptsValue(prop, [])).toBe(true)
			expect(acceptsValue(prop, [{ limit: 1 }])).toBe(true)
			// A non-array, non-null value matches only the inner string
			// alternative, and the original's array type rejects it.
			expect(acceptsValue(prop, "read")).toBe(false)
		})

		it.each([
			{
				// The boolean `true` schema accepts every value, null
				// included (JSON Schema core, appendix A).
				name: "a boolean true alternative accepts null",
				prop: { oneOf: [true, { type: "string" }] },
				expected: { oneOf: [true, { type: "string" }] },
			},
			{
				// The boolean `false` schema accepts nothing, so only the
				// string alternative matches null.
				name: "a boolean false alternative rejects null",
				prop: { oneOf: [false, { type: ["string", "null"] }] },
				expected: { oneOf: [false, { type: ["string", "null"] }] },
			},
			{
				// A null entry is not a schema: it must not be counted as
				// a null-accepting alternative, and it must not crash the
				// converter.
				name: "a null alternative entry rejects null",
				prop: { oneOf: [null, { type: ["string", "null"] }] },
				expected: { oneOf: [null, { type: ["string", "null"] }] },
			},
		])(
			"$name: exactly one alternative accepts null, so the combinator stays untouched (#2653 mutation round)",
			({ prop, expected }) => {
				const schema = { type: "object", properties: { value: prop } }
				const result = provider.testConvertToolSchemaForOpenAI(schema)
				const converted = result.properties.value
				// Neither an appended null alternative nor an anyOf wrap.
				expect(converted).toStrictEqual(expected)
				expect(acceptsValue(converted, null)).toBe(true)
			},
		)

		it.each([
			{
				// Nested anyOf: both inner alternatives accept null and
				// anyOf needs only one match, so the wrapper accepts null
				// and the outer combinator is left alone.
				name: "nested anyOf accepts null through any inner match",
				prop: { anyOf: [{ anyOf: [{ type: ["string", "null"] }, { type: ["integer", "null"] }] }] },
				outerLength: 1,
			},
			{
				// Nested oneOf: both inner alternatives match null, so the
				// exactly-one rule rejects the wrapper and the outer
				// combinator gains a null alternative.
				name: "nested oneOf rejects null when two inner alternatives match",
				prop: { anyOf: [{ oneOf: [{ type: ["string", "null"] }, { type: ["integer", "null"] }] }] },
				outerLength: 2,
			},
		])("$name (#2653 mutation round)", ({ prop, outerLength }) => {
			const schema = { type: "object", properties: { value: prop } }
			const result = provider.testConvertToolSchemaForOpenAI(schema)
			const converted = result.properties.value
			expect(converted.anyOf).toHaveLength(outerLength)
			if (outerLength === 1) {
				expect(converted.anyOf).toStrictEqual(prop.anyOf)
			} else {
				expect(converted.anyOf[1]).toStrictEqual({ type: "null" })
			}
		})

		it("classifies every property as optional when the schema declares no required list (#2653 mutation round)", () => {
			// The property name is the ArrayDeclaration mutant's
			// replacement literal: a mutated declared-required fallback
			// would treat THIS key as declared required and strip the
			// null-accepting type optional keys must gain.
			const schema = {
				type: "object",
				properties: {
					"Stryker was here": { type: "integer" },
				},
			}

			const result = provider.testConvertToolSchemaForOpenAI(schema)

			expect(result.properties["Stryker was here"].type).toStrictEqual(["integer", "null"])
		})

		it.each([
			{
				name: "an optional type list without null gains null",
				type: ["integer"],
				expected: ["integer", "null"],
			},
			{
				name: "an optional type list of only null stays unchanged",
				type: ["null"],
				expected: ["null"],
			},
			{
				name: "an empty optional type list stays empty",
				type: [],
				expected: [],
			},
		])("normalizes optional type lists: $name (#2653 mutation round)", ({ type, expected }) => {
			const schema = { type: "object", properties: { value: { type } } }
			const result = provider.testConvertToolSchemaForOpenAI(schema)
			expect(result.properties.value.type).toStrictEqual(expected)
		})

		it.each([
			{
				// One null match under anyOf semantics: nothing to do.
				name: "a single null-accepting anyOf alternative",
				prop: { anyOf: [{ type: ["string", "null"] }] },
			},
			{
				// One null match under exactly-one semantics: appending a
				// second null alternative would make null match twice.
				name: "a single null-accepting oneOf alternative",
				prop: { oneOf: [{ type: ["string", "null"] }, { type: "integer" }] },
			},
		])("leaves $name untouched: no append, no wrap (#2653 mutation round)", ({ prop }) => {
			const schema = { type: "object", properties: { value: prop } }
			const result = provider.testConvertToolSchemaForOpenAI(schema)
			expect(result.properties.value).toStrictEqual(prop)
		})

		it("normalizes an object-typed original without properties before wrapping (review 6084531532)", () => {
			// No properties: the wrapper's object branch must still fire. Strict
			// mode requires additionalProperties: false on every object schema,
			// so the wrapped original carries it even with no declared properties
			// (the round-6 correction applied to the property-less shape).
			const prop = {
				type: "object",
				oneOf: [{ type: ["object", "null"] }, { type: ["string", "null"] }],
			}
			const schema = { type: "object", properties: { value: prop } }

			const result = provider.testConvertToolSchemaForOpenAI(schema)

			expect(result.properties.value.anyOf).toStrictEqual([
				{
					type: ["object", "null"],
					oneOf: prop.oneOf,
					additionalProperties: false,
				},
				{ type: "null" },
			])
		})

		it("wraps an array-typed original without items unchanged (#2653 mutation round)", () => {
			const prop = {
				type: "array",
				oneOf: [{ type: ["array", "null"] }, { type: ["string", "null"] }],
			}
			const schema = { type: "object", properties: { value: prop } }

			const result = provider.testConvertToolSchemaForOpenAI(schema)

			// No items: the wrapper's array branch must not fire.
			// toStrictEqual also rejects an `items: undefined` key that a
			// mutated branch would add.
			expect(result.properties.value.anyOf).toStrictEqual([
				{ type: ["array", "null"], oneOf: prop.oneOf },
				{ type: "null" },
			])
		})

		it("converts items only for array-typed originals (#2653 mutation round)", () => {
			// Object-typed items on an original with NO array type: the
			// wrap keeps the original as declared instead of converting
			// its items.
			const prop = {
				items: { type: "object", properties: { limit: { type: "integer" } } },
				oneOf: [{ type: ["string", "null"] }, { type: ["integer", "null"] }],
			}
			const schema = { type: "object", properties: { value: prop } }

			const result = provider.testConvertToolSchemaForOpenAI(schema)

			const original = result.properties.value.anyOf[0]
			expect(original.items).toStrictEqual(prop.items)
		})

		it("keeps a single-element non-null type list of a declared required property as a list (#2653 mutation round)", () => {
			const schema = {
				type: "object",
				required: ["value"],
				properties: {
					value: { type: ["integer"] },
				},
			}

			const result = provider.testConvertToolSchemaForOpenAI(schema)

			// Declared required with a type list that holds no "null":
			// the nullable-strip branch must not fire, and the list is not
			// collapsed to a bare type.
			expect(result.properties.value.type).toStrictEqual(["integer"])
		})

		it("normalizes the nested schema of a declared required object property (#2653 mutation round)", () => {
			const schema = {
				type: "object",
				required: ["value"],
				properties: {
					value: { type: "object", properties: { limit: { type: "integer" } } },
				},
			}

			const result = provider.testConvertToolSchemaForOpenAI(schema)

			const value = result.properties.value
			// The declared type is kept while the object recursion adds
			// the strict constraints and nullable inner properties.
			expect(value.type).toBe("object")
			expect(value.additionalProperties).toBe(false)
			expect(value.required).toStrictEqual(["limit"])
			expect(value.properties.limit.type).toStrictEqual(["integer", "null"])
		})

		it("wraps an optional oneOf whose alternatives all accept null in an outer anyOf (#2653 review 4674816421)", () => {
			// null matches TWO inner alternatives; appending nothing leaves
			// oneOf rejecting null (exactly-one), so the property must be
			// wrapped instead.
			const schema = {
				type: "object",
				properties: {
					value: { oneOf: [{ type: ["string", "null"] }, { type: ["integer", "null"] }] },
				},
			}

			const result = provider.testConvertToolSchemaForOpenAI(schema)

			const prop = result.properties.value
			expect(prop.anyOf).toEqual([
				{ oneOf: [{ type: ["string", "null"] }, { type: ["integer", "null"] }] },
				{ type: "null" },
			])
			// null matches only the outer alternative; non-null values match
			// only the original — exactly-one holds for every value.
			expect(acceptsValue(prop, null)).toBe(true)
			expect(acceptsValue(prop, "docx")).toBe(true)
			expect(acceptsValue(prop, 7)).toBe(true)
		})

		it("keeps an optional parameter nullable while a required one stays a value", () => {
			const schema = {
				type: "object",
				required: ["path"],
				properties: {
					path: { type: "string" },
					offset: { type: "integer" },
					limit: { type: "integer" },
				},
			}

			const result = provider.testConvertToolSchemaForOpenAI(schema)

			// Strict mode lists every key in required. A key the schema did not
			// declare required must then accept null, or the model cannot omit
			// it and the call fails with "Missing required parameter".
			expect(result.required).toEqual(["path", "offset", "limit"])
			expect(result.properties.path.type).toBe("string")
			expect(result.properties.offset.type).toEqual(["integer", "null"])
			expect(result.properties.limit.type).toEqual(["integer", "null"])
		})

		it("keeps a declared nullable optional parameter nullable", () => {
			const schema = {
				type: "object",
				required: ["path"],
				properties: {
					path: { type: "string" },
					limit: { type: ["integer", "null"] },
				},
			}

			const result = provider.testConvertToolSchemaForOpenAI(schema)

			expect(result.properties.limit.type).toEqual(["integer", "null"])
		})

		it("keeps a declared required parameter non-nullable", () => {
			const schema = {
				type: "object",
				required: ["regex"],
				properties: {
					regex: { type: ["string", "null"] },
				},
			}

			const result = provider.testConvertToolSchemaForOpenAI(schema)

			expect(result.properties.regex.type).toBe("string")
		})

		it("marks every parameter nullable when the schema declares no required", () => {
			const schema = {
				type: "object",
				properties: {
					query: { type: "string" },
				},
			}

			const result = provider.testConvertToolSchemaForOpenAI(schema)

			// No declared required means every key is optional in JSON Schema,
			// so every key must accept null under strict mode.
			expect(result.properties.query.type).toEqual(["string", "null"])
		})

		it("normalizes the nested schema of a nullable optional object", () => {
			const schema = {
				type: "object",
				required: ["path"],
				properties: {
					path: { type: "string" },
					indentation: {
						type: ["object", "null"],
						properties: { anchor_line: { type: "integer" } },
						required: [],
					},
				},
			}

			const result = provider.testConvertToolSchemaForOpenAI(schema)
			const indentation = result.properties.indentation

			expect(indentation.type).toEqual(["object", "null"])
			expect(indentation.additionalProperties).toBe(false)
			expect(indentation.required).toEqual(["anchor_line"])
			expect(indentation.properties.anchor_line.type).toEqual(["integer", "null"])
		})

		it("emits a strict schema a Draft 2020-12 endpoint accepts (mock, #547)", () => {
			// Mock evidence only: no live DeepSeek request. The parameters copy
			// the read_file shape from the issue report.
			const tools = [
				{
					type: "function",
					function: {
						name: "read_file",
						description: "Read a file",
						parameters: {
							type: "object",
							required: ["path"],
							properties: {
								path: { type: "string" },
								file_pattern: { type: "string", pattern: "[a-zA-Z0-9_]+$" },
								limit: { type: "integer" },
							},
						},
					},
				},
			]

			const result = provider.testConvertToolsForOpenAI(tools)
			const parameters = result?.[0].function.parameters

			expect(result?.[0].function.strict).toBe(true)
			expect(parameters.properties.path.type).toBe("string")
			expect(parameters.properties.limit.type).toEqual(["integer", "null"])
			expect(parameters.properties.file_pattern.type).toEqual(["string", "null"])
			expect(parameters.properties.file_pattern.pattern).toBeUndefined()
			expect(parameters.properties.file_pattern.description).toContain("pattern")
		})

		it("adds a null alternative to an optional composed schema without a top-level type (mock, #547)", () => {
			// Mock evidence only: no live API request. Neither type branch
			// applies to a composed schema, so the property must gain a
			// null alternative or the model cannot omit it.
			const schema = {
				type: "object",
				required: ["path"],
				properties: {
					path: { type: "string" },
					target: { anyOf: [{ type: "string" }, { type: "integer" }] },
					mode: { oneOf: [{ type: "string" }] },
				},
			}

			const result = provider.testConvertToolSchemaForOpenAI(schema)
			const target = result.properties.target
			const mode = result.properties.mode

			expect(result.required).toEqual(["path", "target", "mode"])
			// Every declared alternative survives; only a null one is added.
			expect(target.anyOf).toEqual([{ type: "string" }, { type: "integer" }, { type: "null" }])
			expect(mode.oneOf).toEqual([{ type: "string" }, { type: "null" }])
			expect(acceptsValue(target, null)).toBe(true)
			expect(acceptsValue(target, "docs")).toBe(true)
			expect(acceptsValue(target, 7)).toBe(true)
			expect(acceptsValue(target, true)).toBe(false)
			expect(acceptsValue(mode, null)).toBe(true)
			expect(acceptsValue(mode, "read")).toBe(true)
		})

		it("applies sibling constraints together when making composed optional properties nullable (mock, #547 review)", () => {
			// Mock evidence only: no live API request. A combinator applies
			// alongside a top-level type (Draft 2020-12 sibling constraints),
			// and null acceptance is decided by evaluating null against each
			// alternative, never by inspecting an alternative's type alone.
			const schema = {
				type: "object",
				required: ["path"],
				properties: {
					path: { type: "string" },
					// Sibling constraints: the anyOf must also admit null.
					label: { type: "string", anyOf: [{ type: "string" }] },
					// The alternative's type admits null but its enum does
					// not: null acceptance must not be inferred from the type.
					access: { anyOf: [{ type: ["string", "null"], enum: ["read"] }] },
					// Already null-accepting through the enum: no second null
					// alternative may be appended (oneOf is exactly-one).
					channel: { oneOf: [{ enum: ["read", null] }] },
					// Both combinators present: each must accept null on its
					// own, so both gain a null alternative. The fixture stays
					// satisfiable — a value must satisfy both siblings.
					format: { anyOf: [{ type: "string" }], oneOf: [{ type: "string" }, { type: "integer" }] },
				},
			}

			const result = provider.testConvertToolSchemaForOpenAI(schema)
			const label = result.properties.label
			const access = result.properties.access
			const channel = result.properties.channel
			const format = result.properties.format

			// label: the type widened AND the anyOf gained a null alternative,
			// so both siblings accept null and string values still validate.
			expect(label.type).toEqual(["string", "null"])
			expect(label.anyOf).toEqual([{ type: "string" }, { type: "null" }])
			expect(acceptsValue(label, null)).toBe(true)
			expect(acceptsValue(label, "main")).toBe(true)

			// access: the enum-rejecting alternative does not count as
			// null-accepting, so exactly one null alternative is appended.
			expect(access.anyOf).toEqual([{ type: ["string", "null"], enum: ["read"] }, { type: "null" }])
			expect(acceptsValue(access, null)).toBe(true)
			expect(acceptsValue(access, "read")).toBe(true)

			// channel: the enum alternative already accepts null; appending
			// another null alternative would make null match twice under oneOf.
			expect(channel.oneOf).toEqual([{ enum: ["read", null] }])
			expect(acceptsValue(channel, null)).toBe(true)
			expect(acceptsValue(channel, "read")).toBe(true)

			// format: both combinators gain a null alternative — normalizing
			// only anyOf would leave oneOf rejecting null (sibling AND). The
			// fixture is satisfiable: strings satisfy both siblings.
			expect(format.anyOf).toEqual([{ type: "string" }, { type: "null" }])
			expect(format.oneOf).toEqual([{ type: "string" }, { type: "integer" }, { type: "null" }])
			expect(acceptsValue(format, null)).toBe(true)
			expect(acceptsValue(format, "docx")).toBe(true)
			// Sibling rejection: no anyOf alternative accepts a number, so the
			// string-or-null union rejects 7 even though the oneOf sibling
			// accepts it (#2653 review 4682419243).
			expect(acceptsValue(format, 7)).toBe(false)
		})

		it("treats integers as numbers in the oracle while keeping oneOf exclusive (mock, #547)", () => {
			// Mock evidence only: the oracle mirrors Draft 2020-12 numeric
			// types (#2653 review 4682419243). An integer is also a number; a
			// fractional value is not an integer.
			expect(acceptsValue({ type: "number" }, 7)).toBe(true)
			expect(acceptsValue({ type: "number" }, 1.5)).toBe(true)
			expect(acceptsValue({ type: "integer" }, 7)).toBe(true)
			expect(acceptsValue({ type: "integer" }, 1.5)).toBe(false)
			// The integer now matches both alternatives, so the exactly-one
			// rule of oneOf rejects it.
			expect(acceptsValue({ oneOf: [{ type: "integer" }, { type: "number" }] }, 7)).toBe(false)
			// A value neither alternative accepts stays rejected.
			expect(acceptsValue({ oneOf: [{ type: "integer" }, { type: "number" }] }, "read")).toBe(false)
		})

		it("makes an optional enum property accept null while a declared required enum stays unchanged (mock, #547)", () => {
			// Mock evidence only: no live API request. The enum rejects
			// every value outside its list, so an optional enum property
			// needs null in the enum as well as in the type.
			const schema = {
				type: "object",
				required: ["speed"],
				properties: {
					speed: { type: "string", enum: ["fast", "safe"] },
					mode: { type: "string", enum: ["read", "write"] },
				},
			}

			const result = provider.testConvertToolSchemaForOpenAI(schema)
			const speed = result.properties.speed
			const mode = result.properties.mode

			// The complete converted property, per the review thread.
			expect(result.required).toEqual(["speed", "mode"])
			expect(speed).toEqual({ type: "string", enum: ["fast", "safe"] })
			expect(mode).toEqual({ type: ["string", "null"], enum: ["read", "write", null] })
			expect(acceptsValue(mode, null)).toBe(true)
			expect(acceptsValue(mode, "read")).toBe(true)
			expect(acceptsValue(mode, "bogus")).toBe(false)
			expect(acceptsValue(speed, null)).toBe(false)
		})

		it("replays the enum-constrained optional property through the converter and a validator (mock, #547)", () => {
			// Mock evidence only: no live API request. Replay of the
			// review case: a type-only oracle passes the emitted schema,
			// but only a validator that also checks enum membership
			// accepts null for an enum-constrained optional property.
			// The unconstrained optional string is the passing control.
			const tools = [
				{
					type: "function" as const,
					function: {
						name: "search",
						description: "Search files",
						parameters: {
							type: "object",
							required: ["path"],
							properties: {
								path: { type: "string" },
								style: { type: "string", enum: ["fast", "safe"] },
								query: { type: "string" },
							},
						},
					},
				},
			]

			const result = provider.testConvertToolsForOpenAI(tools)
			const parameters = result?.[0].function.parameters

			// The schema-acceptance oracle answers the question a Draft
			// 2020-12 validator asks about the emitted property.
			expect(acceptsValue(parameters.properties.style, null)).toBe(true)
			expect(acceptsValue(parameters.properties.style, "fast")).toBe(true)
			expect(acceptsValue(parameters.properties.style, "other")).toBe(false)
			// Passing control: the unconstrained optional string.
			expect(acceptsValue(parameters.properties.query, null)).toBe(true)
			expect(acceptsValue(parameters.properties.query, "text")).toBe(true)
			// The declared required property stays a value property.
			expect(acceptsValue(parameters.properties.path, null)).toBe(false)
		})
	})

	describe("convertToolsForOpenAI", () => {
		it("should return undefined for undefined input", () => {
			const result = provider.testConvertToolsForOpenAI(undefined)
			expect(result).toBeUndefined()
		})

		it("should set strict: true for non-MCP tools", () => {
			const tools = [
				{
					type: "function",
					function: {
						name: "read_file",
						description: "Read a file",
						parameters: { type: "object", properties: {} },
					},
				},
			]

			const result = provider.testConvertToolsForOpenAI(tools)

			expect(result?.[0].function.strict).toBe(true)
		})

		it("should set strict: false for MCP tools (mcp-- prefix)", () => {
			const tools = [
				{
					type: "function",
					function: {
						name: "mcp--github--get_me",
						description: "Get current user",
						parameters: { type: "object", properties: {} },
					},
				},
			]

			const result = provider.testConvertToolsForOpenAI(tools)

			expect(result?.[0].function.strict).toBe(false)
		})

		it("should apply schema conversion to non-MCP tools", () => {
			const tools = [
				{
					type: "function",
					function: {
						name: "read_file",
						description: "Read a file",
						parameters: {
							type: "object",
							properties: {
								path: { type: "string" },
							},
						},
					},
				},
			]

			const result = provider.testConvertToolsForOpenAI(tools)

			expect(result?.[0].function.parameters.additionalProperties).toBe(false)
			expect(result?.[0].function.parameters.required).toEqual(["path"])
		})

		it("removes unsupported constraints from the reported follow-up schema", () => {
			const tools = [
				{
					type: "function",
					function: {
						name: "ask_followup_question",
						description: "Ask a question",
						parameters: {
							type: "object",
							properties: {
								follow_up: {
									type: "array",
									description: "Required list of 2-4 suggested responses",
									items: { type: "object", properties: { text: { type: "string" } } },
									minItems: 1,
									maxItems: 4,
								},
							},
						},
					},
				},
			]

			const result = provider.testConvertToolsForOpenAI(tools)
			const followUp = result?.[0].function.parameters.properties.follow_up

			expect(result?.[0].function.strict).toBe(true)
			expect(followUp.minItems).toBe(1)
			expect(followUp.maxItems).toBeUndefined()
			expect(followUp.description).toBe('Required list of 2-4 suggested responses\n\nConstraints: {"maxItems":4}')
		})

		it("removes unsupported constraints recursively while keeping supported keywords", () => {
			const tools = [
				{
					type: "function",
					function: {
						name: "constraint_tool",
						parameters: {
							type: "object",
							properties: {
								count: { type: "number", minimum: 1, maximum: 9, multipleOf: 1 },
								name: {
									type: "string",
									minLength: 1,
									maxLength: 5,
									pattern: "^a",
									format: "email",
								},
								unsupportedFormat: { type: "string", format: "phone" },
								list: {
									type: "array",
									items: { type: "integer", exclusiveMinimum: 0 },
									minItems: 2,
									uniqueItems: true,
									contains: { type: "integer", minimum: 1 },
								},
								choice: { anyOf: [{ type: "string", maxLength: 3 }, { type: "null" }] },
							},
							$defs: { bounded: { type: "integer", maximum: 3 } },
						},
					},
				},
			]

			const result = provider.testConvertToolsForOpenAI(tools)
			const parameters = result?.[0].function.parameters

			expect(parameters.properties.count).toEqual({
				type: ["number", "null"],
				description: 'Constraints: {"minimum":1,"maximum":9,"multipleOf":1}',
			})
			expect(parameters.properties.name).toMatchObject({ type: ["string", "null"], format: "email" })
			expect(parameters.properties.name.pattern).toBeUndefined()
			expect(parameters.properties.name.minLength).toBeUndefined()
			expect(parameters.properties.name.maxLength).toBeUndefined()
			expect(parameters.properties.name.description).toBe(
				'Constraints: {"minLength":1,"maxLength":5,"pattern":"^a"}',
			)
			expect(parameters.properties.unsupportedFormat.format).toBeUndefined()
			expect(parameters.properties.list.minItems).toBeUndefined()
			expect(parameters.properties.list.uniqueItems).toBeUndefined()
			expect(parameters.properties.list.contains).toBeUndefined()
			expect(parameters.properties.list.items.exclusiveMinimum).toBeUndefined()
			expect(parameters.properties.choice.anyOf[0].maxLength).toBeUndefined()
			expect(parameters.$defs.bounded.maximum).toBeUndefined()
		})

		it.each([0, 1])("keeps supported minItems value %s", (minItems) => {
			const tools = [
				{
					type: "function",
					function: {
						name: "list_tool",
						parameters: {
							type: "object",
							properties: { values: { type: "array", items: { type: "string" }, minItems } },
						},
					},
				},
			]

			const result = provider.testConvertToolsForOpenAI(tools)

			expect(result?.[0].function.parameters.properties.values.minItems).toBe(minItems)
		})

		it("processes tuple items and nested schema keywords", () => {
			const tools = [
				{
					type: "function",
					function: {
						name: "nested_schema_tool",
						parameters: {
							type: "object",
							properties: {
								values: {
									type: "array",
									items: [
										{ type: "string", maxLength: 2 },
										{ type: "integer", minimum: 0 },
									],
								},
							},
							additionalProperties: { type: "string", minLength: 1 },
							not: { type: "number", maximum: 10 },
							if: { type: "number", minimum: 1 },
							then: { type: "string", maxLength: 5 },
							else: { type: "string", minLength: 2 },
						},
					},
				},
			]

			const result = provider.testConvertToolsForOpenAI(tools)
			const parameters = result?.[0].function.parameters

			expect(parameters.properties.values.items[0].maxLength).toBeUndefined()
			expect(parameters.properties.values.items[1].minimum).toBeUndefined()
			expect(parameters.additionalProperties).toBe(false)
			expect(parameters.not.maximum).toBeUndefined()
			expect(parameters.if.minimum).toBeUndefined()
			expect(parameters.then.maxLength).toBeUndefined()
			expect(parameters.else.minLength).toBeUndefined()
		})

		it("replaces additionalProperties values other than false in nested schemas", () => {
			const tools = [
				{
					type: "function",
					function: {
						name: "composed_object_tool",
						parameters: {
							type: "object",
							properties: {
								options: {
									anyOf: [
										{ type: "object", properties: {}, additionalProperties: true },
										{ type: "object", properties: {}, additionalProperties: { type: "string" } },
									],
								},
							},
						},
					},
				},
			]

			const result = provider.testConvertToolsForOpenAI(tools)
			const variants = result?.[0].function.parameters.properties.options.anyOf

			expect(variants[0].additionalProperties).toBe(false)
			expect(variants[1].additionalProperties).toBe(false)
			expect(variants[0].description).toBe('Constraints: {"additionalProperties":true}')
			expect(variants[1].description).toBe('Constraints: {"additionalProperties":{"type":"string"}}')
		})

		it("keeps properties whose names match unsupported keywords", () => {
			const tools = [
				{
					type: "function",
					function: {
						name: "keyword_property_tool",
						parameters: {
							type: "object",
							properties: {
								maxItems: { type: "integer" },
								minimum: { type: "number" },
							},
						},
					},
				},
			]

			const result = provider.testConvertToolsForOpenAI(tools)

			expect(result?.[0].function.parameters.properties).toHaveProperty("maxItems")
			expect(result?.[0].function.parameters.properties).toHaveProperty("minimum")
		})

		it("normalizes nullable object properties before stripping constraints", () => {
			const tools = [
				{
					type: "function",
					function: {
						name: "nullable_object_tool",
						parameters: {
							type: "object",
							properties: {
								options: {
									type: ["object", "null"],
									properties: { limit: { type: "integer", minimum: 1 } },
								},
							},
						},
					},
				},
			]

			const result = provider.testConvertToolsForOpenAI(tools)
			const options = result?.[0].function.parameters.properties.options

			// The schema declares no required key, so the property stays
			// nullable while its nested schema is still normalized (#547).
			expect(options.type).toEqual(["object", "null"])
			expect(options.required).toEqual(["limit"])
			expect(options.additionalProperties).toBe(false)
			expect(options.properties.limit.type).toEqual(["integer", "null"])
			expect(options.properties.limit.minimum).toBeUndefined()
		})

		it("should not apply schema conversion to MCP tools in base-provider", () => {
			// Note: In base-provider, MCP tools are passed through unchanged
			// The openai-native provider has its own handling for MCP tools
			const tools = [
				{
					type: "function",
					function: {
						name: "mcp--github--get_me",
						description: "Get current user",
						parameters: {
							type: "object",
							properties: {
								token: { type: "string", maxLength: 20 },
							},
							maxItems: 4,
							required: ["token"],
						},
					},
				},
			]

			const result = provider.testConvertToolsForOpenAI(tools)

			// MCP tools pass through original parameters in base-provider
			expect(result?.[0].function.parameters.additionalProperties).toBeUndefined()
			expect(result?.[0].function.parameters.maxItems).toBe(4)
			expect(result?.[0].function.parameters.properties.token.maxLength).toBe(20)
		})

		it("should sanitize lone UTF-16 surrogates in name, description, and parameters (#461)", () => {
			const tools = [
				{
					type: "function",
					function: {
						name: "read_file",
						description: "bad\uD800end",
						parameters: {
							type: "object",
							properties: {
								path: { type: "string", description: "bad\uDC00end" },
							},
						},
					},
				},
			]

			const result = provider.testConvertToolsForOpenAI(tools)

			expect(result?.[0].function.description).toBe("bad\uFFFDend")
			expect(result?.[0].function.parameters.properties.path.description).toBe("bad\uFFFDend")
			// Inspect the raw values: JSON.stringify escapes lone surrogates as \udXXX text,
			// so a regex over the serialized body can never fail. See expectNoLoneSurrogates.
			expectNoLoneSurrogates(result)
		})

		it("should sanitize lone UTF-16 surrogates in nested MCP tool parameters (#461)", () => {
			const lone = "bad\uD800end"
			const sanitized = "bad\uFFFDend"
			const tools = [
				{
					type: "function",
					function: {
						name: "mcp__srv__tool",
						description: "Run an MCP tool",
						parameters: {
							type: "object",
							properties: {
								path: { type: "string" },
								nested: {
									type: "object",
									properties: {
										list: { type: "string", description: lone },
									},
								},
							},
						},
					},
				},
			]

			const result = provider.testConvertToolsForOpenAI(tools)

			// MCP tools keep their original schema (no strict-mode conversion) ...
			expect(result?.[0].function.strict).toBe(false)
			expect(result?.[0].function.parameters.additionalProperties).toBeUndefined()
			// ... but strings nested in the parameters are still sanitized.
			expect(result?.[0].function.parameters.properties.nested.properties.list.description).toBe(sanitized)
			expectNoLoneSurrogates(result)
		})

		it("should sanitize lone UTF-16 surrogates in tool names (#461)", () => {
			const tools = [
				{
					type: "function",
					function: {
						name: "read\uD800file",
						description: "Read a file",
						parameters: { type: "object", properties: {} },
					},
				},
			]

			const result = provider.testConvertToolsForOpenAI(tools)

			expect(result?.[0].function.name).toBe("read\uFFFDfile")
		})

		it("should set strict: false and preserve declared schema when strict is disabled", () => {
			const tools = [
				{
					type: "function",
					function: {
						name: "read_file",
						description: "Read a file",
						parameters: {
							type: "object",
							properties: {
								path: { type: "string" },
								offset: { type: "integer", minimum: 1 },
							},
							required: ["path"],
							maxItems: 4,
						},
					},
				},
			]

			const result = provider.testConvertToolsForOpenAI(tools, false)

			expect(result?.[0].function.strict).toBe(false)
			// Declared schema preserved: original required array, no additionalProperties coercion
			expect(result?.[0].function.parameters).toEqual(tools[0].function.parameters)
		})

		it("should not mutate caller-owned schemas during strict normalization", () => {
			const tools = [
				{
					type: "function",
					function: {
						name: "nullable_tool",
						description: "Tool with a nullable property",
						parameters: {
							type: "object",
							properties: {
								path: { type: ["string", "null"], maxLength: 20 },
							},
							required: ["path"],
						},
					},
				},
			]

			const strictResult = provider.testConvertToolsForOpenAI(tools, true)
			expect(strictResult?.[0].function.parameters.properties.path.type).toBe("string")
			expect(strictResult?.[0].function.parameters.properties.path.maxLength).toBeUndefined()

			// Caller-owned schema is untouched, so a later non-strict request
			// can still send the original nullable type.
			expect(tools[0].function.parameters.properties.path.type).toEqual(["string", "null"])
			expect(tools[0].function.parameters.properties.path.maxLength).toBe(20)

			const nonStrictResult = provider.testConvertToolsForOpenAI(tools, false)
			expect(nonStrictResult?.[0].function.parameters).toEqual(tools[0].function.parameters)
		})

		it("should still set strict: false for MCP tools when strict is disabled", () => {
			const tools = [
				{
					type: "function",
					function: {
						name: "mcp--github--get_me",
						description: "Get current user",
						parameters: {
							type: "object",
							properties: {
								token: { type: "string" },
							},
							required: ["token"],
						},
					},
				},
			]

			const result = provider.testConvertToolsForOpenAI(tools, false)

			expect(result?.[0].function.strict).toBe(false)
			expect(result?.[0].function.parameters).toEqual(tools[0].function.parameters)
		})
		it("should preserve non-function tools unchanged", () => {
			const tools = [
				{
					type: "other_type",
					data: "some data",
				},
			]

			const result = provider.testConvertToolsForOpenAI(tools)

			expect(result?.[0]).toEqual(tools[0])
		})
	})

	describe("ensureCatalogLoaded", () => {
		it("loads once and memoizes a successful load", async () => {
			const load = vi.fn().mockResolvedValue(undefined)

			await provider.testEnsureCatalogLoaded(load)
			await provider.testEnsureCatalogLoaded(load)

			expect(load).toHaveBeenCalledTimes(1)
		})

		it("single-flights concurrent callers", async () => {
			let resolveLoad: () => void = () => {}
			const load = vi.fn(
				() =>
					new Promise<void>((resolve) => {
						resolveLoad = resolve
					}),
			)

			const first = provider.testEnsureCatalogLoaded(load)
			const second = provider.testEnsureCatalogLoaded(load)

			expect(load).toHaveBeenCalledTimes(1)

			resolveLoad()
			await Promise.all([first, second])
		})

		it("retries after a failed load", async () => {
			const load = vi.fn().mockRejectedValueOnce(new Error("catalog unavailable")).mockResolvedValue(undefined)

			await expect(provider.testEnsureCatalogLoaded(load)).rejects.toThrow("catalog unavailable")
			await expect(provider.testEnsureCatalogLoaded(load)).resolves.toBeUndefined()

			expect(load).toHaveBeenCalledTimes(2)
		})

		it("rejects a pre-aborted caller without starting a load", async () => {
			const controller = new AbortController()
			controller.abort(new Error("caller gave up"))
			const load = vi.fn().mockResolvedValue(undefined)

			await expect(provider.testEnsureCatalogLoaded(load, controller.signal)).rejects.toThrow("caller gave up")
			expect(load).not.toHaveBeenCalled()
		})

		it("detaches only the aborted waiter while the shared load still settles", async () => {
			let resolveLoad: () => void = () => {}
			const load = vi.fn(
				() =>
					new Promise<void>((resolve) => {
						resolveLoad = resolve
					}),
			)

			const controller = new AbortController()
			const wait = provider.testEnsureCatalogLoaded(load, controller.signal)
			controller.abort(new Error("caller gave up"))

			await expect(wait).rejects.toThrow("caller gave up")

			resolveLoad()
			await flushMacrotasks()

			// The shared load completed, so a later caller is a memoized no-op.
			await expect(provider.testEnsureCatalogLoaded(load)).resolves.toBeUndefined()
			expect(load).toHaveBeenCalledTimes(1)
		})

		it("does not forward the caller signal to the shared load", async () => {
			const controller = new AbortController()
			const load = vi.fn().mockResolvedValue(undefined)

			await provider.testEnsureCatalogLoaded(load, controller.signal)

			expect(load).toHaveBeenCalledWith()
		})

		it("propagates a shared-load failure to a signal-carrying waiter", async () => {
			const controller = new AbortController()
			const load = vi.fn().mockRejectedValueOnce(new Error("catalog unavailable")).mockResolvedValue(undefined)

			// The waiter is watching a signal that never aborts, so the rejection can
			// only come from the shared fetch failing -- the branch that must reject
			// the waiter rather than hang until the caller's signal fires.
			await expect(provider.testEnsureCatalogLoaded(load, controller.signal)).rejects.toThrow(
				"catalog unavailable",
			)

			// The failed load cleared the shared promise, so the next caller retries.
			await expect(provider.testEnsureCatalogLoaded(load)).resolves.toBeUndefined()
			expect(load).toHaveBeenCalledTimes(2)
		})

		it("removes the exact abort listener it registered after a successful load", async () => {
			const controller = new AbortController()
			const addListener = vi.spyOn(controller.signal, "addEventListener")
			const removeListener = vi.spyOn(controller.signal, "removeEventListener")
			const load = vi.fn().mockResolvedValue(undefined)

			await provider.testEnsureCatalogLoaded(load, controller.signal)

			// A long-lived signal must not accumulate listeners: the removal has to
			// target the same function reference that was registered.
			expect(addListener).toHaveBeenCalledWith("abort", expect.any(Function), { once: true })
			const registered = addListener.mock.calls[0]?.[1]
			expect(removeListener).toHaveBeenCalledWith("abort", registered)
			expect(removeListener).toHaveBeenCalledTimes(1)
		})

		it("removes the exact abort listener it registered after a rejected load", async () => {
			const controller = new AbortController()
			const addListener = vi.spyOn(controller.signal, "addEventListener")
			const removeListener = vi.spyOn(controller.signal, "removeEventListener")
			const load = vi.fn().mockRejectedValueOnce(new Error("catalog unavailable"))

			await expect(provider.testEnsureCatalogLoaded(load, controller.signal)).rejects.toThrow(
				"catalog unavailable",
			)

			expect(addListener).toHaveBeenCalledWith("abort", expect.any(Function), { once: true })
			const registered = addListener.mock.calls[0]?.[1]
			expect(removeListener).toHaveBeenCalledWith("abort", registered)
			expect(removeListener).toHaveBeenCalledTimes(1)
		})

		it("does not memoize a load that reports an empty catalog", async () => {
			const load = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)

			await provider.testEnsureCatalogLoaded(load)
			// The empty result must stay retryable, so the next caller loads again.
			await provider.testEnsureCatalogLoaded(load)
			expect(load).toHaveBeenCalledTimes(2)

			// The second load produced a catalog, so it is memoized.
			await provider.testEnsureCatalogLoaded(load)
			expect(load).toHaveBeenCalledTimes(2)
		})

		it("memoizes a load that returns true or void", async () => {
			const returningTrue = vi.fn().mockResolvedValue(true)
			await provider.testEnsureCatalogLoaded(returningTrue)
			await provider.testEnsureCatalogLoaded(returningTrue)
			expect(returningTrue).toHaveBeenCalledTimes(1)

			const other = new TestProvider()
			const returningVoid = vi.fn().mockResolvedValue(undefined)
			await other.testEnsureCatalogLoaded(returningVoid)
			await other.testEnsureCatalogLoaded(returningVoid)
			expect(returningVoid).toHaveBeenCalledTimes(1)
		})
	})
})
