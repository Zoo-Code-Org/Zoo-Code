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
 * - compilation is pure: the caller-owned schema object is never mutated.
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
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
function compileSchemaNode(schema: unknown, depth: number): unknown {
	if (!isRecord(schema) || depth > MAX_SCHEMA_DEPTH) {
		return schema
	}

	const result: Record<string, unknown> = {}
	const removed: Record<string, unknown> = {}

	for (const [key, value] of Object.entries(schema)) {
		if (DEEPSEEK_REJECTED_SCHEMA_KEYWORDS.has(key)) {
			removed[key] = value
			continue
		}

		if (key === "properties" || key === "$defs" || key === "definitions") {
			if (isRecord(value)) {
				const compiled: Record<string, unknown> = {}
				for (const [name, subSchema] of Object.entries(value)) {
					compiled[name] = compileSchemaNode(subSchema, depth + 1)
				}
				result[key] = compiled
				continue
			}
		} else if (key === "items") {
			result[key] = Array.isArray(value)
				? value.map((entry) => compileSchemaNode(entry, depth + 1))
				: compileSchemaNode(value, depth + 1)
			continue
		} else if (key === "anyOf" || key === "oneOf" || key === "allOf" || key === "prefixItems") {
			if (Array.isArray(value)) {
				result[key] = value.map((entry) => compileSchemaNode(entry, depth + 1))
				continue
			}
		} else if (
			key === "additionalProperties" ||
			key === "not" ||
			key === "if" ||
			key === "then" ||
			key === "else" ||
			key === "propertyNames"
		) {
			if (isRecord(value)) {
				result[key] = compileSchemaNode(value, depth + 1)
				continue
			}
		}

		result[key] = value
	}

	if (Object.keys(removed).length > 0) {
		const hint = describeRemovedConstraints(removed)
		const existing = result.description
		result.description = typeof existing === "string" && existing.length > 0 ? `${existing}\n${hint}` : hint
	}

	return result
}

/**
 * Compiles a tool's `parameters` schema into the dialect DeepSeek accepts:
 * gateway-rejected keywords are removed and re-encoded into descriptions, and
 * the declared `required` arrays are preserved untouched (optionality stays
 * optional). Pure: the input schema is left untouched.
 */
export function compileToolParametersForDeepSeek(schema: unknown): unknown {
	return compileSchemaNode(schema, 0)
}
