# Исследование: Best Practices для optional параметров в tool schemas (ref/multi_ref/transform)

**Дата:** 2026-06-02
**Цель:** Определить точные best practices для объявления опциональных `ref`/`multi_ref`/`transform` параметров в tool schemas с учётом strict mode провайдеров.

---

## 1. Executive Summary

1. **OpenAI strict mode** требует ВСЕ поля в `required`; опциональность достигается исключительно через `type: ["T", "null"]`. Наш конвертер в [`base-provider.ts`](src/providers/base-provider.ts) удаляет `null` из union, что ломает nullability — модель обязана генерировать полный ~300-токеновый ref-объект и поэтому игнорирует его.
2. **Anthropic strict tool use** НЕ требует всех полей в `required`. Рекомендует `input_examples` для обучения модели использованию optional параметров. Это позволяет сделать `ref` по-настоящему опциональным (не в required).
3. **Vercel AI SDK** имеет ту же проблему (issue [#6403](https://github.com/vercel/ai/issues/6403) — "Optional zod arg is required").
4. **Правильный паттерн:** Для каждого провайдера — своя конвертация. Для OpenAI — `type: ["object", "null"]` + в `required`. Для Anthropic/Mistral/Ollama — НЕ в `required`. Критический баг — удаление `null` из union.
5. **Рекомендация:** Исправить `convertToolSchemaForOpenAI()` — перестать удалять `null` из CRT-параметров. Для Anthropic — убрать `ref` из `required`. Добавить `input_examples` в tool schema.

---

## 2. OpenAI Function Calling — optional nested objects

### 2.1 Официальная документация (2026)

**Источник:** [OpenAI Function Calling Guide](https://developers.openai.com/api/docs/guides/function-calling) (выдержка через Tavily Extract)

Цитата из документации (секция "Strict mode"):

> Setting `strict` to `true` will ensure function calls reliably adhere to the function schema. This requires `additionalProperties` to be `false` for each object in the `parameters`, and all fields in `properties` must be marked as `required`. You can denote optional fields by adding `null` as a `type` option.

**Ключевой пример из документации:**

```json
{
	"type": "function",
	"function": {
		"name": "get_weather",
		"strict": true,
		"parameters": {
			"type": "object",
			"properties": {
				"location": {
					"type": "string"
				},
				"units": {
					"type": ["string", "null"], // ← ОПЦИОНАЛЬНОЕ ПОЛЕ
					"enum": ["celsius", "fahrenheit"]
				}
			},
			"required": ["location", "units"], // ← ВСЁ РАВНО В REQUIRED!
			"additionalProperties": false
		}
	}
}
```

Это подтверждает: **опциональное поле остаётся в `required`, но получает `type: ["T", "null"]`**.

### 2.2 Как это работает под капотом (openai-node source)

**Источник:** [openai-node/src/lib/transform.ts](https://github.com/openai/openai-node/blob/master/src/lib/transform.ts)

Функция `ensureStrictJsonSchema()`:

```typescript
function ensureStrictJsonSchema(
  jsonSchema: JSONSchemaDefinition,
  path: string[],
  root: JSONSchema,
): JSONSchema {
  if (!isObject(jsonSchema)) throw new TypeError(...)

  // add additionalProperties: false to object types
  const typ = jsonSchema.type;
  if (typ === 'object' && !('additionalProperties' in jsonSchema)) {
    jsonSchema.additionalProperties = false;
  }
  const required = jsonSchema.required ?? [];
  const properties = jsonSchema.properties;
  if (isObject(properties)) {
    for (const [key, value] of Object.entries(properties)) {
      if (!isNullable(value) && !required.includes(key)) {
        throw new Error(`Zod field at ... uses .optional() without .nullable()`);
      }
    }
    jsonSchema.required = Object.keys(properties); // ← ALL properties → required
  }
  // ...
}
```

Ключевые открытия:

1. **`isNullable(value)`** проверяет `type: ["T", "null"]` — такой формат **НЕ вызывает ошибку**.
2. **`jsonSchema.required = Object.keys(properties)`** — SDK сам принудительно перезаписывает `required`, добавляя все поля.
3. **НО** если наш конвертер удалил `null` из union (`["object", "null"] → "object"`), то `isNullable()` вернёт `false`, и SDK выбросит ошибку — если поле не в required. Если поле в required — ошибки нет, но nullability потеряна.

### 2.3 Известные проблемы (GitHub Issues)

| Issue                                                                 | Проблема                                                                    | Статус    |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------- |
| [openai-node#1180](https://github.com/openai/openai-node/issues/1180) | Model ignores `.optional()` fields, uses falsy values (0, "")               | Open      |
| [openai-node#1049](https://github.com/openai/openai-node/issues/1049) | JSON Schema `nullable: true` ignored. Only `type: ["string", "null"]` works | Confirmed |
| [Vercel AI#6403](https://github.com/vercel/ai/issues/6403)            | "Optional zod arg is required" — та же проблема strict mode                 | Open      |
| [Vercel AI#5360](https://github.com/vercel/ai/issues/5360)            | "Unable to specify optional (nullable) field" — `.optional()` broke         | Open      |

### 2.4 OpenAI Community

**Источник:** [Strict=True and Required Fields!](https://community.openai.com/t/strict-true-and-required-fields/1131075)

> If we turn on "Strict=True" in the function calling schema, then we have to list all of our fields under "Required". This is a rule that Open AI API forces us to follow. It causes issues in application development. Does anybody have any idea? Why do we have to list all fields under "Required"

Ответ сообщества:

> How would you expect strict mode to work? Disabling it is always an option. If you struggle with instruction adherence, it might be a good idea to refine your prompt. Another idea would be to simplify your function signature (schema).

**Источник:** [Need Help with Conditional Optional Fields](https://community.openai.com/t/need-help-with-conditional-optional-fields-in-openai-json-schema-with-strict-true/1354794)

> Create a union of the type of the field and `null` in the schema. E.g., `"type": ["string", "null"]`

---

## 3. Anthropic Tool Use — optional nested objects

### 3.1 Официальная документация

**Источник:** [Anthropic Define Tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)

Anthropic **не требует** strict mode для tool definitions. JSON Schema передаётся как есть. Optional поля работают естественно — просто не включаются в `required`.

**Ключевой пример из SDK:**

```ts
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod"

const weatherTool = betaZodTool({
	name: "get_weather",
	inputSchema: z.object({
		location: z.string().describe("The city and state, e.g. San Francisco, CA"),
		unit: z.enum(["celsius", "fahrenheit"]).default("fahrenheit"), // ← optional с default
	}),
	description: "Get the current weather in a given location",
	run: async (input) => {
		/* ... */
	},
})
```

### 3.2 Anthropic Strict Tool Use

**Источник:** [Anthropic Strict Tool Use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use)

Anthropic strict mode имеет ограничения JSON Schema:

- `minLength`, `maxLength`, `pattern`, `format` — не поддерживаются
- `$ref` и recursive schemas — не поддерживаются
- `anyOf`/`oneOf` — НЕ поддерживаются (кроме `type: ["T", "null"]` для nullable)

**НО** `required` массив может содержать только обязательные поля — опциональные поля просто не включаются.

### 3.3 Anthropic input_examples

**Источник:** [Anthropic Define Tools — Providing tool use examples](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)

```json
{
	"name": "get_weather",
	"description": "Get the current weather",
	"input_schema": {
		"type": "object",
		"properties": {
			"location": { "type": "string" },
			"unit": { "type": "string", "enum": ["c", "f"] }
		},
		"required": ["location"]
	},
	"input_examples": [{ "input": { "location": "San Francisco" } }, { "input": { "location": "Paris", "unit": "c" } }]
}
```

> Examples are included in the prompt alongside your tool schema, showing Claude concrete patterns for well-formed tool calls. This helps Claude understand when to include optional parameters.

**Это ключевой паттерн:** `input_examples` — механизм обучения модели использованию опциональных параметров без принуждения через `required`.

---

## 4. Vercel AI SDK — tool schemas

### 4.1 Подход AI SDK

**Источник:** [AI SDK 6 Blog Post](https://vercel.com/blog/ai-sdk-6), [AI SDK Tool Calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)

AI SDK использует Zod схемы для tool definitions:

```ts
const weatherTool = tool({
	description: "Get the weather in a location",
	inputSchema: z.object({
		location: z.string().describe("The location"),
		unit: z.string().optional().describe("Temperature unit"), // ← Zod optional
	}),
	execute: async ({ location, unit }) => {
		/* ... */
	},
})
```

### 4.2 Известная проблема

**Источник:** [Vercel AI Issue #6403](https://github.com/vercel/ai/issues/6403)

> I started getting this error in production even though the field is optional: "Invalid schema for response_format 'response': In context=(), 'required' is required to be supplied and to be an array including every key in properties."

Это **та же проблема** — OpenAI strict mode требует все поля в required. SDK пытается конвертировать Zod `.optional()` в JSON Schema, но strict mode это ломает.

### 4.3 Vercel Input Examples (AI SDK v6)

**Источник:** [AI SDK 6 — Input Examples](https://vercel.com/blog/ai-sdk-6)

```ts
tool({
	description: "Get the weather in a location",
	inputSchema: z.object({
		location: z.string().describe("The location"),
	}),
	inputExamples: [{ input: { location: "San Francisco" } }, { input: { location: "Paris" } }],
	execute: async ({ location }) => {
		/* ... */
	},
})
```

> Complex tool schemas with nested objects, specific formatting requirements, or domain-specific patterns can be difficult to describe clearly through tool descriptions alone. Input examples show the model concrete instances of correctly structured input.

---

## 5. Prompt Engineering Best Practices 2026

### 5.1 Decision Framework для optional параметров

**Источник:** [AI Agent Prompt Engineering 2026 Guide](https://www.inflectra.com/Ideas/Topic/AI-Agent-Prompt-Engineering.aspx)

Рекомендации:

1. **Simplify parameter structures** — Complex nested schemas with many optional fields confuse models
2. **Provide examples** — Include diverse examples covering both common cases and edge cases
3. **Teach decision patterns** — When to call a tool (or when not to), how to handle missing parameters

### 5.2 Anthropic Best Practices

**Источник:** [Anthropic Prompt Engineering](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering)

> Make parameters required where possible. Each optional parameter roughly doubles a portion of the grammar's state space. If a parameter always has a reasonable default, consider making it required.

**НО** 3 optional nested параметра (ref, multi_ref, transform) — это уже перебор. Рекомендация: **не класть 3 optional сложных объекта в одну схему**.

### 5.3 Vercel AI SDK Prompt Engineering

**Источник:** [Prompt Engineering in Vercel AI SDK](https://tigerabrodi.blog/prompt-engineering-in-vercels-ai-sdk)

> Simplify parameter structures — Complex nested schemas with many optional fields confuse models. Keep tool sets manageable — Limit yourself to 5 or fewer tools when possible.

### 5.4 Критическое правило упрощения схем

> Complex tool schemas with many optional fields confuse models. Keep tool sets manageable. Simply parameter structures.

Наш `ref` с 6 вложенными полями + `multi_ref` + `transform` — это **анти-паттерн** для tool schemas. Модель не может эффективно обрабатывать 3 опциональных сложных параметра.

---

## 6. Анализ: что именно пошло не так

### 6.1 Текущая проблема

```typescript
// В tool schemas (применяется для ВСЕХ провайдеров):
ref: {
    type: ["object", "null"],
    properties: { source, ref, startAnchor, endAnchor, selector, contextType },
    required: ["source", "ref", "startAnchor", "endAnchor", "selector", "contextType"],
    additionalProperties: false
}
```

**Проблема №1:** `convertToolSchemaForOpenAI()` в [`base-provider.ts`](src/providers/base-provider.ts) делает:

```typescript
type: ["object", "null"] → type: "object"  // null удалён!
```

После этого:

- Для OpenAI strict mode: поле `type: "object"` в `required`. Модель **обязана** генерировать полный ref-объект.
- Для Anthropic non-strict: поле `type: ["object", "null"]` НЕ в required — модель может не генерировать. НО конвертер применяется для ВСЕХ провайдеров.

**Проблема №2:** `ref` в `required` на уровне исходной схемы — для non-strict провайдеров это избыточно. Но для OpenAI strict это необходимо (strict mode требует все поля в required).

**Проблема №3:** 3 сложных optional параметра (ref, multi_ref, transform) в одной схеме — это три фактора, каждый из которых "удваивает грамматическое пространство" (по Anthropic).

### 6.2 Корень проблемы

НЕ в том, что `ref` объявлен с `required: ["source", "ref", ...]`. **А в том, что конвертер удаляет `null` из union**, и это происходит для ВСЕХ провайдеров.

---

## 7. Рекомендация: точная спецификация tool schema для ref

### 7.1 Для OpenAI (strict mode)

```json
{
	"type": "function",
	"function": {
		"name": "apply_diff",
		"strict": true,
		"parameters": {
			"type": "object",
			"properties": {
				"path": { "type": "string" },
				"diff": { "type": "string" },
				"ref": {
					"type": ["object", "null"],
					"description": "Content reference for token-efficient citation. Optional — pass null if not applicable. When provided, all nested fields are required.",
					"properties": {
						"source": { "type": "string", "enum": ["chat", "file", "terminal", "tool"] },
						"ref": { "type": "string" },
						"startAnchor": { "type": ["string", "null"] },
						"endAnchor": { "type": ["string", "null"] },
						"selector": { "type": ["string", "null"] },
						"contextType": {
							"type": ["string", "null"],
							"enum": ["code", "command", "prose", "markdown", "diff"]
						}
					},
					"required": ["source", "ref", "startAnchor", "endAnchor", "selector", "contextType"],
					"additionalProperties": false
				},
				"multi_ref": {
					"type": ["array", "null"],
					"items": { "type": "object" }
				},
				"transform": {
					"type": ["object", "null"],
					"properties": {
						"append": { "type": ["string", "null"] },
						"prepend": { "type": ["string", "null"] },
						"replace": {
							"type": ["object", "null"],
							"properties": { "from": { "type": "string" }, "to": { "type": "string" } },
							"required": ["from", "to"],
							"additionalProperties": false
						},
						"wrap_with": { "type": ["string", "null"] },
						"join_with": { "type": ["string", "null"] }
					},
					"required": ["append", "prepend", "replace", "wrap_with", "join_with"],
					"additionalProperties": false
				}
			},
			"required": ["path", "diff", "ref", "multi_ref", "transform"],
			"additionalProperties": false
		}
	}
}
```

**Ключевые моменты:**

- `type: ["object", "null"]` — **НЕ удалять null из union**
- `ref` в `required` — да, иначе strict mode выдаст ошибку
- Но модель может передать `null` вместо объекта, экономя токены
- `input_examples` — добавить примеры с `null`

### 7.2 Для Anthropic (non-strict, recommended)

```json
{
	"name": "apply_diff",
	"description": "Apply precise modifications to an existing file",
	"input_schema": {
		"type": "object",
		"properties": {
			"path": { "type": "string" },
			"diff": { "type": "string" },
			"ref": {
				"type": ["object", "null"],
				"description": "Content reference. Optional — omit entirely or pass null.",
				"properties": {
					"source": { "type": "string", "enum": ["chat", "file", "terminal", "tool"] },
					"ref": { "type": "string" }
				},
				"required": ["source", "ref"]
			},
			"multi_ref": {
				"type": ["array", "null"],
				"items": { "type": "object" }
			},
			"transform": {
				"type": ["object", "null"],
				"properties": {
					"append": { "type": "string" },
					"prepend": { "type": "string" },
					"join_with": { "type": "string" }
				}
			}
		},
		"required": ["path", "diff"]
	},
	"input_examples": [
		{ "input": { "path": "src/file.ts", "diff": "..." } },
		{
			"input": {
				"path": "src/file.ts",
				"diff": "...",
				"ref": { "source": "chat", "ref": "-1" }
			}
		}
	]
}
```

**Ключевые отличия от OpenAI:**

- `ref`, `multi_ref`, `transform` **НЕ в `required`**
- `input_examples` обучает модель использованию ref без принуждения
- nested `required` проще (`source`, `ref` — только обязательные)
- `additionalProperties: false` **НЕ требуется** (Anthropic не проверяет)

### 7.3 Исправление convertToolSchemaForOpenAI()

```typescript
// В base-provider.ts — НЕ удалять null из CRT-параметров
const CRT_PARAMS = new Set(["ref", "multi_ref", "transform"])

convertToolSchemaForOpenAI(schema: any): any {
    if (!schema || schema.type !== "object") return schema

    const result: any = {
        ...schema,
        additionalProperties: false,
    }

    const properties = result.properties || {}

    for (const [key, prop] of Object.entries(properties)) {
        if (!prop || typeof prop !== "object") continue

        // CRT-параметры: сохраняем type: ["object", "null"] как есть
        if (CRT_PARAMS.has(key)) {
            // pass through — не удаляем null из type union
            continue
        }

        // Для остальных параметров: удаляем null из type union
        // (стандартная конвертация)
        // ...
    }

    return result
}
```

---

## 8. Итоговая матрица решений

| Аспект                               | Текущее (плохо)                                   | Предлагаемое (хорошо)                                            |
| ------------------------------------ | ------------------------------------------------- | ---------------------------------------------------------------- |
| `type: ["object", "null"]` удаляется | ✅ Да, конвертер удаляет null                     | ❌ Нет — сохранять nullability                                   |
| `ref` в `required` для OpenAI        | ✅ Да (но null удалён, токены не экономятся)      | ✅ Да, с `type: ["object", "null"]` — модель может передать null |
| `ref` в `required` для Anthropic     | ✅ Да (избыточно — модель вынуждена генерировать) | ❌ Нет — только `path` и `diff` в required                       |
| `input_examples`                     | Нет                                               | ✅ Добавить для обучения модели                                  |
| `convertToolSchemaForOpenAI()`       | Применяется глобально                             | ✅ Фильтровать CRT-параметры                                     |
| Description полей ref                | Нет                                               | ✅ Добавить "Optional — pass null if not applicable"             |

---

## 9. Источники

| #   | Источник                                            | URL                                                                                                                      | Тип           |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------- |
| 1   | OpenAI Function Calling Guide (2026)                | https://developers.openai.com/api/docs/guides/function-calling                                                           | Official docs |
| 2   | openai-node transform.ts — ensureStrictJsonSchema   | https://github.com/openai/openai-node/blob/master/src/lib/transform.ts                                                   | Source code   |
| 3   | openai-node helpers.md — zodFunction                | https://github.com/openai/openai-node/blob/master/helpers.md                                                             | Official docs |
| 4   | openai-node Issue #1180 — optional() fields ignored | https://github.com/openai/openai-node/issues/1180                                                                        | GitHub        |
| 5   | openai-node Issue #1049 — nullable ignored          | https://github.com/openai/openai-node/issues/1049                                                                        | GitHub        |
| 6   | OpenAI Community — Strict=True Required Fields      | https://community.openai.com/t/strict-true-and-required-fields/1131075                                                   | Community     |
| 7   | OpenAI Community — Conditional Optional Fields      | https://community.openai.com/t/need-help-with-conditional-optional-fields-in-openai-json-schema-with-strict-true/1354794 | Community     |
| 8   | Anthropic Define Tools                              | https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools                                               | Official docs |
| 9   | Anthropic Strict Tool Use                           | https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use                                            | Official docs |
| 10  | Anthropic SDK — betaZodTool                         | https://github.com/anthropics/anthropic-sdk-typescript/blob/main/helpers.md                                              | Source code   |
| 11  | Vercel AI SDK 6                                     | https://vercel.com/blog/ai-sdk-6                                                                                         | Official blog |
| 12  | Vercel AI SDK Tool Calling                          | https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling                                                               | Official docs |
| 13  | Vercel AI Issue #6403 — Optional zod arg required   | https://github.com/vercel/ai/issues/6403                                                                                 | GitHub        |
| 14  | Vercel AI Issue #5360 — Optional field JSON Schema  | https://github.com/vercel/ai/issues/5360                                                                                 | GitHub        |
| 15  | Open AI — Structured Outputs Guide                  | https://developers.openai.com/api/docs/guides/structured-outputs                                                         | Official docs |
| 16  | Предыдущее исследование strict-mode-mitigation      | file://OTCHETY/RESEARCH-strict-mode-mitigation.md                                                                        | Internal      |

---

## 10. Приложение: exact JSON Schema для ref параметра

### Рекомендуемая финальная схема для ref

```typescript
// Для всех провайдеров (единая source schema)
// Конвертация в provider-specific формат — через convertToolSchemaForProvider()

export const refSchema = {
	type: ["object", "null"],
	description:
		"Content reference for token-efficient citation. " +
		"OPTIONAL — pass null (or omit entirely for non-OpenAI providers) if not applicable. " +
		"Use when content comes from chat, file, terminal output, or previous tool result.",
	properties: {
		source: {
			type: "string",
			enum: ["chat", "file", "terminal", "tool"],
			description: "Source of the referenced content",
		},
		ref: {
			type: "string",
			description: "Reference identifier within the source (e.g., message index, file path)",
		},
		startAnchor: {
			type: ["string", "null"],
			description: "Start anchor for extracting a fragment",
		},
		endAnchor: {
			type: ["string", "null"],
			description: "End anchor for extracting a fragment",
		},
		selector: {
			type: ["string", "null"],
			description: "Exact substring selector (alternative to anchors)",
		},
		contextType: {
			type: ["string", "null"],
			enum: ["code", "command", "prose", "markdown", "diff"],
			description: "Type of context for proper rendering",
		},
	},
	required: ["source", "ref", "startAnchor", "endAnchor", "selector", "contextType"],
	additionalProperties: false,
}

// Для multi_ref
export const multiRefSchema = {
	type: ["array", "null"],
	description: "OPTIONAL — Multiple content references. Pass null if not applicable.",
	items: refSchema, // тот же refSchema
}

// Для transform
export const transformSchema = {
	type: ["object", "null"],
	description: "OPTIONAL — Content transformations. Pass null if not applicable.",
	properties: {
		append: { type: ["string", "null"], description: "Text to append" },
		prepend: { type: ["string", "null"], description: "Text to prepend" },
		replace: {
			type: ["object", "null"],
			description: "Search-and-replace transformation",
			properties: { from: { type: "string" }, to: { type: "string" } },
			required: ["from", "to"],
			additionalProperties: false,
		},
		wrap_with: { type: ["string", "null"], description: "Text to wrap content with" },
		join_with: { type: ["string", "null"], description: "Separator for joining multi_ref" },
	},
	required: ["append", "prepend", "replace", "wrap_with", "join_with"],
	additionalProperties: false,
}
```

### Правила конвертации по провайдерам

```typescript
// Псевдокод для convertToolSchemaForProvider()

function convertToolSchemaForProvider(schema, provider) {
	switch (provider) {
		case "openai":
			return convertForOpenAI(schema) // all in required, type: ["T", "null"]

		case "anthropic":
			return convertForAnthropic(schema) // CRT params NOT in required
		// + add input_examples

		case "bedrock":
			return convertForBedrock(schema) // type: ["T", "null"] → anyOf

		case "vscode-lm":
			return convertForVSCodeLM(schema) // type: ["T", "null"] → anyOf

		default:
			return schema // pass through for Mistral, Ollama, etc.
	}
}
```
