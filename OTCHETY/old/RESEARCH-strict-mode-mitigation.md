# Исследование: strict mode + вложенные опциональные объекты в tool schemas (ref/multi_ref/transform)

**Дата:** 2026-06-02
**Цель:** Почему модель не генерирует `ref` в tool calls и как это исправить

---

## 1. Сводка (10 строк)

Проблема — модель не генерирует `ref`/`multi_ref`/`transform` в tool calls — имеет **три корневые причины**:

1. **OpenAI strict mode** (`strict: true`) требует все properties в `required`. Конвертер (`convertToolSchemaForOpenAI()`) дополнительно превращает `type: ["object", "null"]` → `type: "object"`, лишая модель возможности НЕ передавать ref. Модель вынуждена генерировать полный объект при каждом вызове — это ~200+ токенов накладных расходов. На практике модель просто игнорирует параметр.
2. **Anthropic strict mode** также увеличивает «грамматическое пространство» от optional параметров. Официальная рекомендация Anthropic — «Make parameters required where possible; each optional parameter roughly doubles a portion of the grammar's state space».
3. **Архитектурная ошибка:** `ref` — это **мета-параметр** для цитирования, а не функциональный параметр инструмента. Ни Claude Code, ни Cursor, ни Copilot не встраивают citation metadata в tool parameters — они используют отдельные механизмы (`@` references, Citations API). CRT пытается сделать это через tool schema, что ломается под strict mode.

**Главная рекомендация:** убрать `ref`/`multi_ref`/`transform` из корневого `required` массива и из tool schemas для strict mode провайдеров, передавая их через отдельный канал (metadata / system prompt / MCP).

---

## 2. Исследование 1: OpenAI/Anthropic strict mode — nested object optional fields

### 2.1 OpenAI: правила strict mode

**Источник:** [OpenAI Function Calling Guide](https://developers.openai.com/api/docs/guides/function-calling)

OpenAI требует при `strict: true`:

1. `additionalProperties: false` во всех object-схемах
2. **Все** поля в `properties` должны быть перечислены в `required`
3. `oneOf`, `anyOf`, `if-then-else` **НЕ поддерживаются**

Цитата из документации:

> Setting `strict` to `true` ensures function calls reliably adhere to the function schema. This requires `additionalProperties` to be `false` and all fields in `properties` to be marked as `required`.

### 2.2 OpenAI: как делать опциональные поля

**Источник:** [OpenAI Community — Need Help with Conditional Optional Fields](https://community.openai.com/t/need-help-with-conditional-optional-fields-in-openai-json-schema-with-strict-true/1354794)

Единственный способ сделать опциональное поле в strict mode:

```json
{
	"type": ["string", "null"],
	"description": "The unit to return the temperature in",
	"enum": ["F", "C"]
}
```

Поле остаётся в `required`, но может принимать `null`. OpenAI явно рекомендует этот паттерн:

> Answer: Create a union of the type of the field and `null` in the schema.

**Проблема для CRT:** Наш конвертер `convertToolSchemaForOpenAI()` (в `base-provider.ts:87-89`) **удаляет** `null` из union:

```typescript
if (prop && Array.isArray(prop.type) && prop.type.includes("null")) {
	const nonNullTypes = prop.type.filter((t: string) => t !== "null")
	prop.type = nonNullTypes.length === 1 ? nonNullTypes[0] : nonNullTypes
}
```

`type: ["object", "null"]` → `type: "object"`. В результате модель **обязана** сгенерировать полноценный объект `ref`, а не `null`.

### 2.3 OpenAI Zod issue — nullable vs type union

**Источник:** [GitHub — zod issue #5432](https://github.com/colinhacks/zod/issues/5432), [openai-node issue #1049](https://github.com/openai/openai-node/issues/1049)

Важное открытие: OpenAI **не поддерживает** `"nullable": true` (Zod `.nullable()`). Только `"type": ["string", "null"]` (Zod `z.union([z.string(), z.null()])`).

> When using `nullable: true`, the LLM always returns a string and never null. `type: ["string", "null"]` works well.

Наш `type: ["object", "null"]` — это правильный формат.

### 2.4 Anthropic strict tool use ограничения

**Источник:** [Anthropic Strict Tool Use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use), [Structured Outputs — Best Practices](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)

Anthropic также требует `strict: true` на уровне tool definition. Ограничения JSON Schema у Anthropic:

- `minLength`, `maxLength`, `pattern`, `format` — не поддерживаются
- `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum` — не поддерживаются
- `minItems`, `maxItems` — не поддерживаются
- `$ref` и `recursive schemas` — не поддерживаются
- `anyOf`/`oneOf` — НЕ поддерживаются (только для nullable через `type: ["T", "null"]`)

**Критическая рекомендация Anthropic:**

> Reduce optional parameters. Make parameters `required` where possible. Each optional parameter roughly doubles a portion of the grammar's state space. If a parameter always has a reasonable default, consider making it required and having Claude provide that default explicitly.

Наш `ref`/`multi_ref`/`transform` — это 3 optional параметра с глубоко вложенными объектами (у `ref` — 6 полей, у `transform` — 5 полей). Каждый «удваивает грамматическое пространство». Это делает схему дорогой для strict mode.

---

## 3. Исследование 2: Почему модель может игнорировать ref

### 3.1 Токенная стоимость принудительной генерации

При текущей схеме модель **обязана** сгенерировать для каждого вызова инструмента:

```json
"ref": {
  "source": "chat",
  "ref": "-1",
  "startAnchor": null,
  "endAnchor": null,
  "selector": null,
  "contextType": null
},
"multi_ref": null,
"transform": null
```

Это ~200-300 токенов на каждый tool call. Для задачи с 10 tool calls — 2000-3000 токенов только на ref-поля. Модель «знает», что это дорого, и предпочитает не генерировать ref вообще.

### 3.2 Проблема с OpenRouter и прокси-провайдерами

OpenRouter и аналогичные сервисы могут:

1. Получить схему с `strict: true` (через `base-provider.ts`)
2. Перенаправить запрос к Anthropic/Bedrock, которые не поддерживают OpenAI-формат strict
3. Либо тихо дропнуть неподдерживаемые поля

При этом `ref` с `type: ["object", "null"]` может быть:

- Сконвертирован в `type: "object"` (потеря nullability)
- Оставлен как есть, но проигнорирован моделью
- Вызвать ошибку валидации схемы

### 3.3 type: ["object", "null"] с ALL required — патологический случай

У нас в схеме `ref`:

```json
{
	"type": ["object", "null"],
	"required": ["source", "ref", "startAnchor", "endAnchor", "selector", "contextType"],
	"additionalProperties": false
}
```

Это означает: «ref может быть объектом ИЛИ null, НО если объект — то ВСЕ поля обязательны». Для strict mode это значит: модель может передать `null` (но Open AI strict mode конвертирует в `"type": "object"` — так что null невозможен). Если же передаётся объект — все 6 полей обязательны. Это **максимально строгая** и токено-затратная форма.

### 3.4 Provider-specific issues

- **OpenAI strict:** `type: ["object", null]` → `type: "object"`. Nullability потеряна. Модель должна генерировать полный ref.
- **Anthropic strict:** Optional nested объекты удваивают грамматическое пространство. Anthropic рекомендует их избегать.
- **Bedrock/VSCode LM:** `normalizeToolSchema()` конвертирует `["object", "null"]` → `anyOf: [{type: "object"}, {type: "null"}]`. Это корректно, но модель может игнорировать anyOf.
- **Mistral/Ollama:** Pass-through, но сами модели могут не поддерживать сложные nested схемы.

---

## 4. Исследование 3: Альтернативные подходы у других AI-агентов

### 4.1 Claude Code — `@` references

**Источник:** [Referencing Files in Claude Code](https://stevekinney.com/courses/ai-development/referencing-files-in-claude-code), [Anthropic Citations API](https://platform.claude.com/docs/en/build-with-claude/citations)

Claude Code использует:

- **`@file`** / **`@dir`** в пользовательском вводе (client-side parsing, не tool parameter)
- **Citations API** — отдельный API feature для документов (PDF, text), не связанный с tool schemas
- **Мета-параметров в tool definitions нет вообще**

### 4.2 Cursor — `@` symbols + codebase indexing

**Источник:** [Cursor AI Semantic Search Guide](https://www.digitalapplied.com/blog/cursor-semantic-search-coding-ai-guide)

Cursor использует:

- **`@codebase`**, **`@file`**, **`@folder`**, **`@code`**, **`@docs`**, **`@web`** — все на уровне UI/промпта
- **Codebase indexing** — семантический поиск по коду
- **Никаких content reference параметров в tool calls**

### 4.3 GitHub Copilot — GitHub Issues интеграция

Copilot использует references через:

- **GitHub Issues** как источник контекста
- **`@` mentions** внутри IDE
- Отдельный слой интеграции с GitHub API

### 4.4 Anthropic Citations API отдельно

**Источник:** [Anthropic Citations Docs](https://platform.claude.com/docs/en/build-with-claude/citations)

Антропик вынес цитирование в отдельный API параметр `citations: {enabled: true}` на уровне документа, а не на уровне инструмента:

```json
{
	"type": "document",
	"source": {
		"type": "content",
		"content": [{ "type": "text", "text": "First chunk" }]
	},
	"citations": { "enabled": true }
}
```

Citations **несовместимы** со structured outputs (`strict: true`):

> Citations require interleaving citation blocks with text, which conflicts with strict JSON schema constraints. Returns 400 error if citations enabled with `output_config.format`.

Это подтверждает: strict mode и мета-параметры цитирования — **конфликтующие концепции**.

---

## 5. Вывод: корень проблемы

Проблема — **архитектурная**, не баг в конвертере.

| Аспект                     | Текущее состояние     | Проблема                                     |
| -------------------------- | --------------------- | -------------------------------------------- |
| `ref` в `required`         | ✅ Да                 | Strict mode требует required — OK            |
| `type: ["object", "null"]` | ✅ Правильный формат  | Но конвертер удаляет null                    |
| Nested required поля       | ✅ 6 полей в required | Генерировать 200+ токенов каждый раз         |
| Альтернативы               | Нет отдельного канала | Другие агенты используют `@` / Citations API |
| Provider compatibility     | Разная конвертация    | Для OpenAI одно, для Anthropic другое        |

**Ключевое открытие:** Ни один другой AI-агент (Claude Code, Cursor, Copilot) не встраивает content reference метаданные в tool parameters. Все используют отдельные механизмы. CRT пытается сделать что-то, что не вписывается в парадигму tool-parameters-for-strict-mode.

---

## 6. Рекомендации

### 6.1 Рекомендация A (рекомендуемая) — вынести ref из tool schemas

Создать отдельный канал для передачи content references, не смешивая с tool parameters:

**Вариант A1:** Передавать ref через `system prompt` / инструкцию в начале сообщения:

> "When you make a tool call and the content is from a file, include the reference in markdown after the tool use in your response."

**Вариант A2:** Использовать `metadata` поле API-запроса (если провайдер поддерживает).

**Вариант A3:** Реализовать `post-processing` на стороне API-прокси: модель возвращает обычные tool calls, а **сервер** добавляет ref на основе контекста.

### 6.2 Рекомендация B (минимальные изменения) — убрать только strict mode compliance

Изменить `convertToolSchemaForOpenAI()` чтобы он не удалял `ref`/`multi_ref`/`transform`, а также не добавлял их в `required`:

```typescript
// base-provider.ts — filter out CRT params from strict mode processing
const CRT_PARAMS = new Set(["ref", "multi_ref", "transform"])

function convertToolSchemaForOpenAI(schema: any): any {
	if (!schema || schema.type !== "object") return schema

	const result = { ...schema, additionalProperties: false }
	const properties = result.properties || {}
	const allKeys = Object.keys(properties)

	// CRT parameters — NOT marked as required, keep their nullability
	const nonCrtKeys = allKeys.filter((k) => !CRT_PARAMS.has(k))
	result.required = nonCrtKeys // Only non-CRT params are required

	for (const [key, prop] of Object.entries(properties)) {
		if (CRT_PARAMS.has(key)) continue // Skip CRT params

		if (
			prop.type === "object" ||
			(Array.isArray(prop.type) && prop.type.includes("object") && !prop.type.includes("null"))
		) {
			properties[key] = convertToolSchemaForOpenAI(prop)
		}
	}

	return result
}
```

### 6.3 Рекомендация C (средняя сложность) — убрать ref из required на уровне схем

Изменить исходные tool schemas — убрать `ref`, `multi_ref`, `transform` из корневого `required`:

```typescript
// Текущее (неправильно):
required: ["path", "diff", "ref", "multi_ref", "transform"],

// Предлагаемое:
required: ["path", "diff"],
```

Оставить `ref`/`multi_ref`/`transform` как полностью опциональные поля. Модель сможет их НЕ передавать. Если же модель решит использовать ref — она передаст объект со всеми required nested полями.

**Плюсы:** Минимальные изменения, модель может выбирать.
**Минусы:** Для OpenAI strict mode любое поле не в `required` = модель никогда его не сгенерирует (strict mode требует все в required). То есть для OpenAI это сработает наоборот — убьёт ref полностью.

→ **Вывод:** Рекомендация С не работает для strict mode.

### 6.4 Рекомендация D (через system prompt) — объяснить модели ценность ref

Добавить в system prompt:

```
IMPORTANT: When you call a tool, you SHOULD include the 'ref' parameter
with the source of the content you are referencing. This saves tokens
on subsequent calls because the content can be reconstructed from the reference.
The 'ref' parameter is optional — pass null if not applicable. But prefer
using it when the content comes from a chat message, file, terminal output,
or previous tool result.
```

Но это не решит проблему токенной стоимости генерации ref.

### 6.5 Рекомендация E (рекомендуемая) — комбинированный подход

1. **Убрать `ref`/`multi_ref`/`transform` из `required` в tool schemas** (изменение в 7 файлах) — для Anthropic, Mistral, Ollama модель сможет их не передавать.
2. **Для OpenAI strict mode** — вырезать CRT-параметры из схемы перед отправкой в `convertToolSchemaForOpenAI()`, передавая их через отдельный `metadata` параметр API-запроса.
3. **Добавить в system prompt** инструкцию об использовании ref.

---

## 7. Примеры кода «как должно быть»

### Пример 1: Tool schema без ref в required

```typescript
// apply_diff.ts — ref/multi_ref/transform не в required
export const apply_diff = {
	type: "function",
	function: {
		name: "apply_diff",
		description: APPLY_DIFF_DESCRIPTION,
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "The path of the file to modify.",
				},
				diff: {
					type: "string",
					description: DIFF_PARAMETER_DESCRIPTION,
				},
				ref: {
					type: ["object", "null"],
					properties: {
						source: { type: "string", enum: ["chat", "file", "terminal", "tool"] },
						ref: { type: "string" },
						startAnchor: { type: ["string", "null"] },
						endAnchor: { type: ["string", "null"] },
						selector: { type: ["string", "null"] },
						contextType: {
							type: ["string", "null"],
							enum: ["code", "command", "prose", "markdown", "diff"],
						},
					},
					required: ["source", "ref", "startAnchor", "endAnchor", "selector", "contextType"],
					additionalProperties: false,
				},
				multi_ref: {
					type: ["array", "null"],
					items: { type: "object" },
				},
				transform: {
					type: ["object", "null"],
					properties: {
						append: { type: ["string", "null"] },
						prepend: { type: ["string", "null"] },
						replace: {
							type: ["object", "null"],
							properties: { from: { type: "string" }, to: { type: "string" } },
							required: ["from", "to"],
							additionalProperties: false,
						},
						wrap_with: { type: ["string", "null"] },
						join_with: { type: ["string", "null"] },
					},
					required: ["append", "prepend", "replace", "wrap_with", "join_with"],
					additionalProperties: false,
				},
			},
			required: ["path", "diff"], // !!! ref/multi_ref/transform НЕ в required
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
```

### Пример 2: Open AI конвертер — фильтрация CRT-параметров

```typescript
// base-provider.ts — экранирование CRT-параметров от strict mode
const CRT_PARAMS = new Set(["ref", "multi_ref", "transform"])

convertToolSchemaForOpenAI(schema: any): any {
    if (!schema || schema.type !== "object") return schema

    const result: any = {
        ...schema,
        additionalProperties: false,
    }

    const properties = result.properties || {}
    const keys = Object.keys(properties)

    // CRT-параметры НЕ включаются в required для strict mode
    const strictKeys = keys.filter(k => !CRT_PARAMS.has(k))
    result.required = strictKeys.length > 0 ? strictKeys : undefined

    for (const [key, prop] of Object.entries(properties)) {
        if (!prop || typeof prop !== "object") continue

        // CRT-параметры: сохраняем как есть (с nullability)
        if (CRT_PARAMS.has(key)) continue

        // Non-CRT parameters: existing conversion logic
        if (prop.type === "object" && !Array.isArray(prop.type)) {
            properties[key] = this.convertToolSchemaForOpenAI(prop)
        } else if (Array.isArray(prop.type)) {
            const nonNullTypes = prop.type.filter((t: string) => t !== "null")
            properties[key] = {
                ...prop,
                type: nonNullTypes.length === 1 ? nonNullTypes[0] : nonNullTypes,
            }
            if (prop.type.includes("object")) {
                properties[key] = this.convertToolSchemaForOpenAI(prop)
            }
        }
    }

    return result
}
```

### Пример 3: Передача ref через metadata

```typescript
// Task.ts — передача ref через отдельный канал
// Вместо того чтобы требовать ref в tool parameters,
// передаём список доступных references через metadata

const apiRequest = {
	model: model,
	messages: messages,
	tools: toolDefinitionsWithoutRef, // ref убран из tool schemas
	metadata: {
		availableRefs: {
			chat: chatHistory.map((msg, i) => ({ index: i, role: msg.role })),
			files: currentFileContext.map((f) => ({ path: f.path, hash: f.hash })),
			terminal: terminalOutputs.map((t, i) => ({ index: i, command: t.command })),
			tool: previousToolResults.map((r, i) => ({
				id: r.tool_use_id,
				name: r.tool_name,
			})),
		},
	},
}
```

---

## 8. План действий (по приоритету)

| #   | Действие                                                                        | Трудозатраты                | Эффект                                                               |
| --- | ------------------------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------- |
| 1   | Убрать `ref`/`multi_ref`/`transform` из `required` в 7 tool files               | Малая (7 файлов × 1 строка) | Модель перестанет тратить токены на ref для Anthropic/Mistral/Ollama |
| 2   | Модифицировать `convertToolSchemaForOpenAI()` — экранировать CRT-параметры      | Средняя (~30 строк)         | OpenAI strict mode перестанет требовать ref                          |
| 3   | Добавить инструкцию в system prompt про использование ref                       | Малая (~5 строк)            | Модель будет знать, что ref опционален                               |
| 4   | (Опционально) Реализовать post-processing ref на серверной стороне              | Высокая                     | Полная автоматизация цитирования                                     |
| 5   | Аудит runtime: что происходит, когда модель не передаёт ref/multi_ref/transform | Средняя                     | Проверить, не падает ли парсинг                                      |

---

## 9. Источники

| #   | Источник                                           | URL                                                                                                                      | Тип           |
| --- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------- |
| 1   | OpenAI Function Calling Guide                      | https://developers.openai.com/api/docs/guides/function-calling                                                           | Official docs |
| 2   | OpenAI Structured Outputs                          | https://developers.openai.com/api/docs/guides/structured-outputs                                                         | Official docs |
| 3   | OpenAI Community — Optional Fields in Strict Mode  | https://community.openai.com/t/need-help-with-conditional-optional-fields-in-openai-json-schema-with-strict-true/1354794 | Community     |
| 4   | OpenAI Community — Strict=True and Required Fields | https://community.openai.com/t/strict-true-and-required-fields/1131075                                                   | Community     |
| 5   | Zod Issue #5432 — nullable vs type union           | https://github.com/colinhacks/zod/issues/5432                                                                            | GitHub        |
| 6   | openai-node Issue #1049 — nullable ignored         | https://github.com/openai/openai-node/issues/1049                                                                        | GitHub        |
| 7   | Anthropic Strict Tool Use                          | https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use                                            | Official docs |
| 8   | Anthropic Structured Outputs Best Practices        | https://platform.claude.com/docs/en/build-with-claude/structured-outputs                                                 | Official docs |
| 9   | Anthropic Citations API                            | https://platform.claude.com/docs/en/build-with-claude/citations                                                          | Official docs |
| 10  | Referencing Files in Claude Code                   | https://stevekinney.com/courses/ai-development/referencing-files-in-claude-code                                          | Tutorial      |
| 11  | Cursor AI Semantic Search                          | https://www.digitalapplied.com/blog/cursor-semantic-search-coding-ai-guide                                               | Blog          |
| 12  | AI Agent Products Dissected: Cursor                | https://productwithshambhavi.substack.com/p/ai-agent-products-dissected-cursor                                           | Blog          |
| 13  | AСTUIT-TOOL-SCHEMAS (наш аудит)                    | file://OTCHETY/AUDIT-tool-schemas.md                                                                                     | Internal      |

---

## 10. Приложение: поведение type: ["object", "null"] по провайдерам

| Провайдер              | Исходный тип        | После конвертации                         | Может ли модель передать null? | ref в required? |
| ---------------------- | ------------------- | ----------------------------------------- | ------------------------------ | --------------- |
| **OpenAI (strict)**    | `["object","null"]` | `"object"`                                | ❌ Нет (null удалён)           | Да              |
| **Anthropic**          | `["object","null"]` | `["object","null"]`                       | ✅ Да                          | Да              |
| **Anthropic (strict)** | `["object","null"]` | `["object","null"]`                       | ✅ Да                          | Да              |
| **Bedrock**            | `["object","null"]` | `anyOf: [{type:"object"}, {type:"null"}]` | ✅ Да                          | Да              |
| **Mistral**            | `["object","null"]` | `["object","null"]`                       | ✅ Да                          | Да              |
| **Ollama**             | `["object","null"]` | `["object","null"]`                       | ✅ Да(?)                       | Да              |
| **VSCode LM**          | `["object","null"]` | `anyOf: [{type:"object"}, {type:"null"}]` | ✅ Да                          | Да              |

После применения Рекомендации E (убрать из required):

| Провайдер           | ref в required? | Может не передавать ref?                         | Комментарий                      |
| ------------------- | --------------- | ------------------------------------------------ | -------------------------------- |
| **OpenAI (strict)** | ❌ Нет          | ❌ Нет (strict mode игнорирует не-required поля) | Ref не будет работать для OpenAI |
| **Anthropic**       | ❌ Нет          | ✅ Да                                            | Может не передавать              |
| **Bedrock**         | ❌ Нет          | ✅ Да                                            | Может не передавать              |
| **Mistral**         | ❌ Нет          | ✅ Да                                            | Может не передавать              |
| **Ollama**          | ❌ Нет          | ✅ Да                                            | Может не передавать              |
| **VSCode LM**       | ❌ Нет          | ✅ Да                                            | Может не передавать              |

**То есть** для OpenAI нужно отдельное решение (экранирование через `convertToolSchemaForOpenAI()` + server-side ref injection).
