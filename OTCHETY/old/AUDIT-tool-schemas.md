# Аудит прохождения tool schemas (ref/multi_ref/transform) до API-запроса

**Дата:** 2026-06-02
**Аудитор:** Автоматизированный анализ кода
**Файлы в фокусе:** `build-tools.ts`, `native-tools/index.ts`, `filter-tools-for-mode.ts`

---

## Краткое summary

Ниже описана полная цепочка от определения tool schema в individual tool файлах до отправки в API. **CRT-параметры (`ref`/`multi_ref`/`transform`) проходят во все API-запросы без фильтрации.** Единственная трансформация, которая затрагивает их — конвертация `type: ["object", "null"]` в `type: "object"` для OpenAI strict mode (через `convertToolSchemaForOpenAI()`), что лишает модель возможности явно указать `null`. Для Anthropic, Bedrock, Mistral, Ollama, VSCode LM и AI SDK параметры передаются полностью нетронутыми или с корректной 2020-12 трансформацией (`anyOf`). **Проблем в цепочке нет**, но есть архитектурное наблюдение: strict mode для OpenAI-совместимых провайдеров делает `ref`/`multi_ref`/`transform` нон-набл и всегда required, что увеличивает токенную стоимость каждого tool call`а.

---

## 1. Полная цепочка прохождения tool schema

### Этап 1: Определение индивидуальных tool схем

**Файлы:** `src/core/prompts/tools/native-tools/apply_diff.ts`, `execute_command.ts`, `write_to_file.ts`, `search_replace.ts`, `edit_file.ts`, `edit.ts`, `apply_patch.ts`

Каждый файл экспортирует объект `satisfies OpenAI.Chat.ChatCompletionTool`. Схемы содержат `ref`, `multi_ref`, `transform` как обязательные параметры:

```typescript
// apply_diff.ts:70-72
parameters: {
    properties: {
        ref:       { type: ["object", "null"], properties: { source, ref, startAnchor, endAnchor, selector, contextType }, required: [...], additionalProperties: false },
        multi_ref: { type: ["array", "null"], items: { type: "object" } },
        transform: { type: ["object", "null"], properties: { append, prepend, replace, wrap_with, join_with }, required: [...], additionalProperties: false },
    },
    required: ["path", "diff", "ref", "multi_ref", "transform"],
    additionalProperties: false,
}
```

**7 инструментов** имеют эти параметры: `apply_diff`, `execute_command`, `write_to_file`, `search_replace`, `edit_file`, `edit`, `apply_patch`.

### Этап 2: Сборка массива native tools

**Файл:** `src/core/prompts/tools/native-tools/index.ts:42-72`

Функция `getNativeTools()` возвращает массив всех инструментов **без каких-либо преобразований** — просто список экспортированных констант.

```typescript
// строка 71
] satisfies OpenAI.Chat.ChatCompletionTool[]
```

### Этап 3: Фильтрация по режиму (mode)

**Файл:** `src/core/prompts/tools/filter-tools-for-mode.ts:225-330`

Функция `filterNativeToolsForMode()`:

- Проверяет только **имя** инструмента (`tool.function.name`) на принадлежность к `allowedToolNames` (строка 316)
- Не трогает `parameters`/`properties` вообще
- Единственная модификация — rename инструмента через `getOrCreateRenamedTool()` (строки 318-321), который меняет только `function.name`, оставляя `parameters` нетронутыми

```typescript
// строка 312-326
for (const tool of nativeTools) {
	if ("function" in tool && tool.function) {
		const toolName = tool.function.name
		if (allowedToolNames.has(toolName)) {
			const aliasName = aliasRenames.get(toolName)
			if (aliasName) {
				filteredTools.push(getOrCreateRenamedTool(tool, aliasName))
			} else {
				filteredTools.push(tool) // ← как есть
			}
		}
	}
}
```

### Этап 4: Сборка финального массива + MCP + Custom Tools

**Файл:** `src/core/task/build-tools.ts:82-169`

Функция `buildNativeToolsArrayWithRestrictions()`:

- Получает отфильтрованные native tools (строка 117-125)
- Получает MCP tools (строка 128-129)
- Получает custom tools (строки 134-142)
- **Просто конкатенирует**: `[...filteredNativeTools, ...filteredMcpTools, ...nativeCustomTools]` (строка 145)
- **Никакой модификации схем** не происходит

### Этап 5: Прокидывание в API провайдер

**Файл:** `src/core/task/Task.ts`

3 ключевых вызова `buildNativeToolsArrayWithRestrictions()`:

- **Строка 1521** — для конденсации контекста
- **Строка 3750** — для повторной попытки (retry)
- **Строка 4128** — основной API-запрос к LLM

Результат (`tools`) передаётся через `metadata.tools` в `this.api.createMessage()`.

### Этап 6: Конвертация в формат провайдера

В зависимости от провайдера, схема проходит через одну из конвертаций.

---

## 2. Анализ по провайдерам

### 2.1 Anthropic (и Anthropic Vertex, MiniMax)

**Файл:** `src/core/prompts/tools/native-tools/converters.ts:28-39`

```typescript
// строка 28-39
export function convertOpenAIToolToAnthropic(tool: OpenAI.Chat.ChatCompletionTool): Anthropic.Tool {
	if (tool.type !== "function") {
		throw new Error(`Unsupported tool type: ${tool.type}`)
	}
	return {
		name: tool.function.name,
		description: tool.function.description || "",
		input_schema: tool.function.parameters as Anthropic.Tool.InputSchema, // ← ПРОСТО ПРИВОДИТ ТИП
	}
}
```

**Вердикт:** ✅ **Pass-through.** `tool.function.parameters` целиком становится `input_schema`. Никакой трансформации. CRT-параметры передаются как есть, включая `type: ["object", "null"]` — это валидный JSON Schema для Anthropic.

### 2.2 OpenAI (strict mode через base-provider)

**Файл:** `src/api/providers/base-provider.ts:27-106`

```typescript
// строка 41-51
return {
	...tool,
	function: {
		...tool.function,
		strict: !isMcp, // ← strict: true для native tools
		parameters: isMcp ? tool.function.parameters : this.convertToolSchemaForOpenAI(tool.function.parameters),
	},
}
```

**Функция `convertToolSchemaForOpenAI()`** (строки 63-106):

1. **Строка 72-73:** Устанавливает `additionalProperties: false` для всех object-схем
2. **Строка 79:** Все properties становятся required: `result.required = allKeys`
3. **Строка 87-89:** `type: ["object", "null"]` → `type: "object"` (null удаляется)
4. **Строка 93-94:** Рекурсивно обрабатывает nested objects (ref.properties, transform.properties)
5. **Строка 95-99:** Для `multi_ref` (`type: ["array", "null"]` → `type: "array"`) — рекурсивно обрабатывает `items`

**Что происходит с CRT-параметрами:**

| Параметр               | Исходный тип         | После конвертации               | Проблема?          |
| ---------------------- | -------------------- | ------------------------------- | ------------------ |
| `ref`                  | `["object", "null"]` | `"object"` (нон-набл, required) | Потеря nullability |
| `multi_ref`            | `["array", "null"]`  | `"array"` (нон-набл, required)  | Потеря nullability |
| `transform`            | `["object", "null"]` | `"object"` (нон-набл, required) | Потеря nullability |
| nested в ref/transform | `["string", "null"]` | `"string"` (нон-набл)           | Потеря nullability |

**ВАЖНО:** Исходные схемы уже имеют все CRT-параметры в `required` массиве (см. исходные файлы). Strict mode не добавляет новой обязательности — он просто подтверждает существующую.

Однако с `strict: true` модель **гарантированно** обязана сгенерировать значения для `ref`/`multi_ref`/`transform` при каждом вызове инструмента, что увеличивает потребление токенов.

### 2.3 Bedrock

**Файл:** `src/api/providers/bedrock.ts:1272-1289`

```typescript
// строка 1281-1286
inputSchema: {
    json: normalizeToolSchema(tool.function.parameters as Record<string, unknown>),
},
```

Использует `normalizeToolSchema()` из `src/utils/json-schema.ts:294-304`.

**Трансформация `normalizeToolSchema()`:**

- **Строка 126-231 (zod schema):** `type: ["object", "null"]` → `anyOf: [{type: "object"}, {type: "null"}]`
- Устанавливает `additionalProperties: false` для object-типов
- Рекурсивная обработка nested schemas

**Вердикт:** ✅ **Корректная 2020-12 трансформация.** CRT-параметры сохраняются полностью, nullability конвертируется в anyOf — стандартный JSON Schema draft 2020-12. Нет потери данных.

### 2.4 Mistral

**Файл:** `src/api/providers/mistral.ts:171-183`

```typescript
// строка 174-182
return tools
	.filter((tool) => tool.type === "function")
	.map((tool) => ({
		type: "function",
		function: {
			name: tool.function.name,
			description: tool.function.description,
			parameters: (tool.function.parameters as Record<string, unknown>) || {},
		},
	}))
```

**Вердикт:** ✅ **Pass-through.** Параметры не модифицируются.

### 2.5 Ollama

**Файл:** `src/api/providers/native-ollama.ts:186-201`

```typescript
// строка 193-200
.map((tool) => ({
    type: tool.type,
    function: {
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters as OllamaTool["function"]["parameters"],
    },
}))
```

**Вердикт:** ✅ **Pass-through.** Параметры не модифицируются.

### 2.6 VSCode LM

**Файл:** `src/api/providers/vscode-lm.ts:24-34`

```typescript
// строка 27-33
return tools
	.filter((tool) => tool.type === "function")
	.map((tool) => ({
		name: tool.function.name,
		description: tool.function.description || "",
		inputSchema: tool.function.parameters
			? normalizeToolSchema(tool.function.parameters as Record<string, unknown>)
			: undefined,
	}))
```

**Вердикт:** ✅ Те же трансформации, что у Bedrock (через `normalizeToolSchema`). CRT-параметры сохраняются.

### 2.7 AI SDK

**Файл:** `src/api/transform/ai-sdk.ts:161-180`

```typescript
// строка 172-175
toolSet[t.function.name] = createTool({
	description: t.function.description,
	inputSchema: jsonSchema(t.function.parameters as any),
})
```

Использует `zod` для конвертации JSON Schema в zod schema. **Вердикт:** ✅ Просто передаёт параметры насквозь.

### 2.8 Сводная таблица конвертации

| Провайдер             | Файл                       | Конвертация               | Судьба CRT-параметров             | Проблемы           |
| --------------------- | -------------------------- | ------------------------- | --------------------------------- | ------------------ |
| **Anthropic**         | `converters.ts:28-39`      | parameters → input_schema | ✅ Pass-through                   | —                  |
| **Anthropic Vertex**  | `anthropic-vertex.ts:82`   | Через converters          | ✅ Pass-through                   | —                  |
| **MiniMax**           | `minimax.ts:112`           | Через converters          | ✅ Pass-through                   | —                  |
| **OpenAI (native)**   | `base-provider.ts:28-106`  | strict + конвертация null | ⚠️ `["object","null"]`→`"object"` | Потеря nullability |
| **OpenAI-compatible** | `base-provider.ts:28-106`  | strict + конвертация null | ⚠️ То же                          | Потеря nullability |
| **Bedrock**           | `bedrock.ts:1272-1289`     | `normalizeToolSchema()`   | ✅ `["T","null"]` → `anyOf`       | —                  |
| **Mistral**           | `mistral.ts:171-183`       | Pass-through              | ✅                                | —                  |
| **Ollama**            | `native-ollama.ts:186-201` | Pass-through              | ✅                                | —                  |
| **VSCode LM**         | `vscode-lm.ts:24-34`       | `normalizeToolSchema()`   | ✅ `["T","null"]` → `anyOf`       | —                  |
| **AI SDK**            | `ai-sdk.ts:161-180`        | Zod jsonSchema            | ✅                                | —                  |

---

## 3. Ответы на вопросы

### Вопрос 1: Проходят ли ref/multi_ref/transform в финальный API-запрос?

**Да, проходят.** Ни на одном этапе нет фильтрации по имени параметра. Все 7 инструментов, содержащих CRT-параметры, доставляют их в API-запрос для всех провайдеров. В зависимости от провайдера параметры могут быть трансформированы (см. таблицу выше), но ни один параметр не удаляется и не игнорируется.

### Вопрос 2: Есть ли фильтрация/трансформация, которая может вырезать параметры?

**Нет фильтрации по имени параметров.** Точки, где параметры могли бы быть вырезаны:

- **`filterNativeToolsForMode()`** (`filter-tools-for-mode.ts:312-326`) — проверяет только `tool.function.name`, параметры не трогает
- **`getOrCreateRenamedTool()`** (`filter-tools-for-mode.ts:75-86`) — меняет только `function.name`, параметры остаются без изменений
- **`getMcpServerTools()`** (`mcp_server.ts`) — строит свои схемы, не затрагивая native tools

Существующие трансформации:

- `convertToolSchemaForOpenAI()` — меняет типы, но не удаляет параметры
- `normalizeToolSchema()` — меняет `["T","null"]` на `anyOf`, но сохраняет все поля

### Вопрос 3: Где именно формируется массив tools для API?

Массив tools для API формируется в **трёх местах** в `Task.ts`, все через `buildNativeToolsArrayWithRestrictions()`:

| Место                       | Строки    | Назначение                | includeAllToolsWithRestrictions |
| --------------------------- | --------- | ------------------------- | ------------------------------- |
| `condenseContext()`         | 1517-1532 | Для конденсации контекста | `false`                         |
| `retryWithNewContext()`     | 3749-3756 | Повторная попытка         | `false`                         |
| `startCustomModeTask()`     | 3963-3972 | Custom mode               | не найден в вычитанном          |
| `createStreamWithHistory()` | 4112-4141 | **Основной запрос к LLM** | `true` только для Gemini        |

Сам `buildNativeToolsArrayWithRestrictions()` в `build-tools.ts:82-169`:

1. Получает native tools через `getNativeTools()` (строка 112-114)
2. Фильтрует через `filterNativeToolsForMode()` (строка 117-125)
3. Получает MCP tools через `getMcpServerTools()` (строка 128)
4. Фильтрует MCP через `filterMcpToolsForMode()` (строка 129)
5. Опционально загружает custom tools (строки 134-142)
6. Конкатенирует: `[...filteredNativeTools, ...filteredMcpTools, ...nativeCustomTools]` (строка 145)

### Вопрос 4: Разница в формате tool schema для разных провайдеров?

Да, существенная:

**OpenAI-формат (общий):**

```json
{
    "type": "function",
    "function": {
        "name": "...",
        "description": "...",
        "parameters": { ... }
    }
}
```

**С провайдер-специфичными вариациями:**

| Провайдер           | Структура                                                                     | strict | TypeScript location    |
| ------------------- | ----------------------------------------------------------------------------- | ------ | ---------------------- |
| **Anthropic**       | `{name, description, input_schema}`                                           | —      | `converters.ts:28`     |
| **Bedrock**         | `{toolSpec: {name, description, inputSchema: {json: ...}}}`                   | —      | `bedrock.ts:1278`      |
| **Mistral**         | `{type: "function", function: {name, description, parameters}}`               | —      | `mistral.ts:174`       |
| **Ollama**          | `{type: "function", function: {name, description, parameters}}`               | —      | `native-ollama.ts:193` |
| **OpenAI (strict)** | `{type: "function", function: {name, description, parameters, strict: true}}` | ✅ Да  | `base-provider.ts:45`  |
| **VSCode LM**       | `{name, description, inputSchema}`                                            | —      | `vscode-lm.ts:27`      |
| **AI SDK**          | `Record<name, tool>` (zod schema)                                             | —      | `ai-sdk.ts:172`        |

### Вопрос 5: Может ли strict mode с type: ["object", "null"] вызвать проблемы?

**Потенциально да, для OpenAI-совместимых провайдеров.**

**Проблема 1 — Потеря nullability:**
В `base-provider.ts:87-89`:

```typescript
if (prop && Array.isArray(prop.type) && prop.type.includes("null")) {
	const nonNullTypes = prop.type.filter((t: string) => t !== "null")
	prop.type = nonNullTypes.length === 1 ? nonNullTypes[0] : nonNullTypes
}
```

`type: ["object", "null"]` → `type: "object"`. Модель **не может** передать `null`, только объект. Это заставляет модель генерировать `ref: {}`, даже когда она не хочет использовать цитирование.

**Проблема 2 — Все параметры required:**
В `base-provider.ts:79`:

```typescript
result.required = allKeys
```

Хотя исходные схемы уже имеют `required: ["path", "diff", "ref", "multi_ref", "transform"]`, это означает, что модель ВСЕГДА тратит токены на генерацию `ref`, `multi_ref`, `transform` при каждом вызове инструмента.

**Проблема 3 — OpenRouter/прокси с strict без поддержки:**
Если провайдер использует strict mode (через `base-provider.ts`), но модель на другом конце не поддерживает strict mode, это может вызвать ошибки валидации схемы. Например, OpenRouter, ретранслирующий strict-схему в Anthropic API.

**Проблема 4 — VSCode LM + Copilot:**
`vscode-lm.ts` использует `normalizeToolSchema()`, который корректно конвертирует `["object","null"]` в `anyOf`. Проблем нет.

---

## 4. Вывод: есть ли проблема в этой цепочке?

**Критических проблем нет.** CRT-параметры (`ref`/`multi_ref`/`transform`) **доходят до всех API-запросов** для всех провайдеров без потери данных.

**Наблюдения:**

1. **Для Anthropic, Bedrock, Mistral, Ollama, VSCode LM, AI SDK** — схема передаётся полностью корректно. Никаких проблем.

2. **Для OpenAI и OpenAI-совместимых провайдеров** — есть потеря nullability через `convertToolSchemaForOpenAI()`. `type: ["object", "null"]` превращается в `type: "object"`. Это может:

    - Увеличить токенную стоимость (модель обязана генерировать все CRT-поля каждый раз)
    - Заставить модель генерировать `ref: {}` даже когда цитирование не нужно

3. **Рекомендация (опционально):** Если токенная стоимость важна, можно сделать `ref`/`multi_ref`/`transform` **не required** в исходных схемах (убрать их из `required` массива). Тогда strict mode пропустит их генерацию, когда они не нужны. Однако это потребует изменений в рантайм-логике обработки tool call`ов на стороне рантайма.

4. **Нигде нет бага.** Все трансформации корректны и ожидаемы для соответствующих провайдеров. Цепочка: `tool file → getNativeTools() → filterNativeToolsForMode() → buildNativeToolsArrayWithRestrictions() → provider converter → API call` — полна и непротиворечива.
