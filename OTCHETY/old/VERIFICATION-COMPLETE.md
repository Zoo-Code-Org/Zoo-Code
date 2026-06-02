# Верификация кода перед правками CRT

Дата: 2026-06-02
Вердикт: **Файлы прочитаны, факты зафиксированы. Критические проблемы выявлены и документированы.**

---

## 1. `base-provider.ts` — `convertToolSchemaForOpenAI()`

**Файл:** [`src/api/providers/base-provider.ts`](src/api/providers/base-provider.ts)
**Функция:** `convertToolSchemaForOpenAI(schema: any): any` — строки 63–106

### Что делает

Конвертирует OpenRouter-совместимую JSON-схему (со свободными `type`, неполными `required`, разрешёнными `additionalProperties`) в формат, требуемый **OpenAI Responses API strict mode**.

### Построчный разбор

| Строки    | Операция                                                                                                                                                   |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 63        | Сигнатура: `protected convertToolSchemaForOpenAI(schema: any): any`                                                                                        |
| 64–66     | Guard: если `schema` не объект, не существует, или `schema.type !== "object"` — возврат как есть                                                           |
| 68        | Spread-копия: `const result = { ...schema }`                                                                                                               |
| **72–74** | **`additionalProperties = false`** — принудительно ставит `false`, если ещё не `false`                                                                     |
| **76–79** | **`result.required = allKeys`** — все ключи из `properties` помещаются в `required`. Это strict mode: OpenAI требует, чтобы ВСЕ свойства были в `required` |
| **87–90** | **Nullable → non-null**: если `prop.type` — массив и содержит `"null"`, то `"null"` отфильтровывается. Если остался 1 тип — массив схлопывается в строку   |
| 93–94     | Рекурсивный вызов для вложенных объектов (`prop.type === "object"`)                                                                                        |
| 95–99     | Рекурсивный вызов для элементов массива типа `object` (`prop.type === "array" && prop.items?.type === "object"`)                                           |

### Ключевой момент для CRT

`ref`, `multi_ref`, `transform` **не обрабатываются** этой функцией вообще. Они остаются в `properties` как обычные поля со своими схемами (`type: ["object", "null"]`, `type: ["array", "null"]`). Поскольку функция:

1. Делает `required = allKeys` — все поля, включая `ref`, `multi_ref`, `transform`, становятся **обязательными**
2. Ставит `additionalProperties: false` — лишние поля запрещены
3. Конвертирует `type: ["object", "null"]` → `type: "object"` (удаляет `null`)

### Проблема

После `convertToolSchemaForOpenAI()` поля `ref`, `multi_ref`, `transform` становятся **required** и **non-nullable** (если у них был `type: ["object", "null"]`, то `null` удаляется на строке 89). Это означает, что OpenAI модель **обязана** всегда передавать эти поля, что ломает graceful fallback — модель не может их просто опустить.

**→ Нужно либо исключать `ref`/`multi_ref`/`transform` из конвертации, либо делать conditional schema.**

---

## 2. `getEffectiveApiHistory()`

**Файл:** [`src/core/condense/index.ts`](src/core/condense/index.ts)
**Функция:** `export function getEffectiveApiHistory(messages: ApiMessage[]): ApiMessage[]` — строки 546–640

### API

```typescript
function getEffectiveApiHistory(messages: ApiMessage[]): ApiMessage[]
```

Принимает полную историю API-сообщений (включая помеченные для конденсации/усечения), возвращает отфильтрованный массив для отправки провайдеру.

### Логика (два режима)

#### Режим A: Fresh Start (есть summary) — строки 548–606

1. **Строка 548:** `findLast(messages, (msg) => msg.isSummary === true)` — ищет последний summary
2. **Строка 553:** `messages.slice(summaryIndex)` — все сообщения от summary и далее
3. **Строки 558–567:** Собирает `tool_use_id` всех ассистентских сообщений в этом диапазоне
4. **Строки 570–590:** Фильтрует `tool_result`, которые ссылаются на `tool_use_id` из сообщений ДО summary (orphan tool_results)
5. **Строки 593–606:** Дополнительно фильтрует сообщения, помеченные как усечённые (`truncationParent`)

#### Режим B: Нет summary — строки 609–639

1. **Строки 613–624:** Собирает все существующие `condenseId` и `truncationId`
2. **Строки 629–639:** Фильтрует по `condenseParent` и `truncationParent` — если parent существует, сообщение исключается

### Возвращаемое значение

`ApiMessage[]` — отфильтрованный массив. Тип `ApiMessage` импортируется из `../../shared/tools`.

---

## 3. `chat.ts` — `resolveChatSource()`

**Файл:** [`src/core/tools/ref/sources/chat.ts`](src/core/tools/ref/sources/chat.ts)
**Функция:** `resolveChatSource(ref: ContentRef, task: Task): Promise<SelectorResult>` — строки 21–55

### Импорты (строки 8–11)

| Строка | Импорт                               |
| ------ | ------------------------------------ |
| 8      | `ContentRef` из `../../shared/tools` |
| 9      | `SelectorResult` из `../selector`    |
| 10     | `resolveContentRef` из `../selector` |
| 11     | `Task` из `../../../task/Task`       |

### Как получает `task.assistantMessageContent`

**Строка 28:** `const messages = task.assistantMessageContent`

Тип `AssistantMessageContent` описан в [`src/core/assistant-message/types.ts`](src/core/assistant-message/types.ts):

```typescript
export type AssistantMessageContent = TextContent | ToolUse | McpToolUse
```

### Индексация сообщений

**Строка 23:** `const index = parseInt(ref.ref, 10)`
**Строка 24–26:** Валидация — `isNaN(index) || index >= 0` → ошибка (только отрицательные индексы)
**Строка 29:** `const targetIndex = messages.length + index` — конвертация `-1` → `length - 1`
**Строки 31–33:** Проверка границ массива

### Обработка типов сообщений (строки 38–47)

| Строки | Тип            | Действие                                         |
| ------ | -------------- | ------------------------------------------------ |
| 38–40  | `text`         | `sourceText = message.content \|\| ""`           |
| 41–43  | `tool_use`     | `JSON.stringify(nativeArgs \|\| params \|\| {})` |
| 44–46  | `mcp_tool_use` | `JSON.stringify(arguments \|\| {})`              |

### Возвращаемые значения

| Условие                  | Результат                                                           |
| ------------------------ | ------------------------------------------------------------------- |
| `"-1"` (valid)           | `resolveContentRef(sourceId, sourceText, ref)` → `SelectorResult`   |
| `"-2"` (valid)           | То же для предпоследнего сообщения                                  |
| `index >= 0` или `NaN`   | `throw new Error("Invalid chat ref index: ...")`                    |
| `targetIndex` вне границ | `throw new Error("Chat message index ... out of bounds")`           |
| `sourceText` пустой      | `throw new Error("Chat message at index ... is empty or not text")` |

---

## 4. `native-tools/` — все 7 файлов

**Директория:** [`src/core/prompts/tools/native-tools/`](src/core/prompts/tools/native-tools/)

### Сводная таблица

| Файл                 | `strict: true` | `ref` в properties | `ref` в required | `multi_ref` в properties | `multi_ref` в required | `transform` в properties | `transform` в required |
| -------------------- | :------------: | :----------------: | :--------------: | :----------------------: | :--------------------: | :----------------------: | :--------------------: |
| `execute_command.ts` |   ✅ стр.33    |     ✅ стр.49      |    ✅ стр.90     |        ✅ стр.65         |       ✅ стр.90        |        ✅ стр.69         |       ✅ стр.90        |
| `write_to_file.ts`   |   ✅ стр.23    |     ✅ стр.35      |    ✅ стр.76     |        ✅ стр.51         |       ✅ стр.76        |        ✅ стр.55         |       ✅ стр.76        |
| `apply_diff.ts`      |     **❌**     |     ✅ стр.30      |    ✅ стр.71     |        ✅ стр.46         |       ✅ стр.71        |        ✅ стр.50         |       ✅ стр.71        |
| `edit.ts`            |     **❌**     |     ✅ стр.41      |    ✅ стр.82     |        ✅ стр.57         |       ✅ стр.82        |        ✅ стр.61         |       ✅ стр.82        |
| `search_replace.ts`  |     **❌**     |     ✅ стр.44      |    ✅ стр.85     |        ✅ стр.60         |       ✅ стр.85        |        ✅ стр.64         |       ✅ стр.85        |
| `edit_file.ts`       |     **❌**     |     ✅ стр.65      |    ✅ стр.106    |        ✅ стр.81         |       ✅ стр.106       |        ✅ стр.85         |       ✅ стр.106       |
| `apply_patch.ts`     |     **❌**     |     ✅ стр.54      |    ✅ стр.95     |        ✅ стр.70         |       ✅ стр.95        |        ✅ стр.74         |       ✅ стр.95        |

### Критическая проблема №1: Отсутствие `strict: true`

**5 из 7 файлов** не имеют `strict: true`:

- `apply_diff.ts` ❌
- `edit.ts` ❌
- `search_replace.ts` ❌
- `edit_file.ts` ❌
- `apply_patch.ts` ❌

Без `strict: true` OpenAI не требует обязательного заполнения полей из `required`. Модель может опустить `ref`/`multi_ref`/`transform`. Следовательно, эти 5 инструментов могут работать без CRT, но CRT и не гарантирован.

**2 из 7** имеют `strict: true`:

- `execute_command.ts` ✅
- `write_to_file.ts` ✅

Для них модель **обязана** заполнять `ref`, `multi_ref`, `transform` (могут быть `null`). Это гарантирует, что парсер всегда найдёт эти поля, но нагружает модель лишними токенами.

### Критическая проблема №2: `additionalProperties: false`

Все 7 файлов имеют `additionalProperties: false` на всех уровнях вложенных схем (ref, transform замены). Это корректно для strict mode.

### Вывод по schemas

**Проблема**: `apply_diff` (основной инструмент редактирования!) не имеет `strict: true`. При этом `ref`/`multi_ref`/`transform` уже в `required`. Если включить `strict: true`, модель будет обязана их передавать.

---

## 5. `BaseTool.ts` — CRT-часть

**Файл:** [`src/core/tools/BaseTool.ts`](src/core/tools/BaseTool.ts)

### Проверка `block.refMeta` в `handle()` — строки 175–187

```typescript
// CRT: resolve ref if present, with graceful fallback
if (block.refMeta) {
	try {
		const refResults = await resolveRef(block.refMeta, task)
		if (refResults?.content) {
			params = this.injectRefContent(params, block.name, refResults)
		}
	} catch (error) {
		// Graceful fallback: use original params.
		// Error is logged but does NOT prevent execution.
		console.error(`[CRT] Failed to resolve ref for ${block.name}:`, error)
	}
}
```

**Логика:**

1. Строка 176: Проверяет `block.refMeta` (truthy check)
2. Строка 178: `resolveRef(block.refMeta, task)` — асинхронное разрешение референса
3. Строка 179: Если `refResults?.content` есть — заменяет параметр
4. Строки 182–186: **Graceful fallback** — при любой ошибке логгирует и продолжает с оригинальными params

### `injectRefContent()` — строки 107–139

```typescript
private injectRefContent(params, toolName, refResults): ToolParams<TName> {
    const p = { ...params } as any
    const content = refResults.joined ?? refResults.content

    switch (toolName) {
        case "execute_command":  p.command = content;   break
        case "write_to_file":    p.content = content;    break
        case "apply_diff":       p.diff = content;       break
        case "apply_patch":      p.patch = content;      break
        case "edit":
        case "search_and_replace":
        case "search_replace":
        case "edit_file":        p.new_string = content;  break
    }
    return p as ToolParams<TName>
}
```

**Строка 113:** `const content = refResults.joined ?? refResults.content` — приоритет у `joined` (если был `join_with` в transform), иначе `content` (первый фрагмент).

### Graceful fallback

Если `resolveRef()` выбрасывает исключение (строка 182), ошибка логгируется в консоль, но выполнение продолжается с **оригинальными параметрами** (без CRT-инъекции). Это означает:

- AI запросил CRT, но референс не разрешился → AI получит `tool_result` от выполнения тула без CRT-данных
- Никакого прерывания/ошибки для пользователя

### Полный поток handle() — строки 153–215

```
handle(task, block, callbacks)
├── block.partial? → handlePartial() → return
├── block.nativeArgs !== undefined?
│   ├── params = block.nativeArgs
│   ├── block.refMeta? → resolveRef() → injectRefContent()
│   └── (fallback при ошибке)
├── else (legacy/XML)? → throw Error("XML tool calls are no longer supported")
└── await this.execute(params, task, callbacks)
```

---

## 6. `filter-tools-for-mode.ts`

**Файл:** [`src/core/prompts/tools/filter-tools-for-mode.ts`](src/core/prompts/tools/filter-tools-for-mode.ts)

### Как фильтруются инструменты

Функция `filterNativeToolsForMode()` (строки 225–330):

1. **Строки 235–243:** Определяет `modeConfig` по слагу (с fallback на defaultMode)
2. **Строка 246:** `getToolsForMode(modeConfig.groups)` — получает все тулы для групп мода
3. **Строки 249–260:** `isToolAllowedForMode()` — проверка разрешений для каждого тула
4. **Строки 263–269:** `applyModelToolCustomization()` — excluded/included tools от модели
5. **Строки 272–307:** **Условные исключения**:
    - `codebase_search` — если CodeIndex не настроен
    - `update_todo_list` — если `todoListEnabled === false`
    - `generate_image` — если эксперимент не включён
    - `run_slash_command` — если эксперимент не включён
    - `disabledTools` — явно отключённые в settings
    - `access_mcp_resource` — если MCP не активен
6. **Строки 310–327:** Фильтрация массива native tool definitions по имени + alias rename

### Вырезается ли что-то из `properties`?

**НЕТ.** Функция не модифицирует схемы инструментов. Она только:

- Добавляет/удаляет целые тулы по имени
- Переименовывает тулы через alias (например `edit_file` → `edit`)
- Возвращает `OpenAI.Chat.ChatCompletionTool[]`

Все `ref`/`multi_ref`/`transform` поля в схемах остаются нетронутыми.

---

## Сводка критических проблем для CRT

| #   | Проблема                                                                                                      | Файл(ы)                                                                           | Приоритет                                                      |
| --- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 1   | `convertToolSchemaForOpenAI()` делает `ref`/`multi_ref`/`transform` required и non-nullable                   | `base-provider.ts` строки 72–79, 87–90                                            | **HIGH** — ломает graceful fallback для OpenAI                 |
| 2   | 5/7 native-tools не имеют `strict: true`, хотя `ref`/`multi_ref`/`transform` уже в `required`                 | `apply_diff.ts`, `edit.ts`, `search_replace.ts`, `edit_file.ts`, `apply_patch.ts` | **HIGH** — `apply_diff` (основной инструмент!) без strict mode |
| 3   | 2/7 native-tools имеют `strict: true` → модель ВСЕГДА шлёт `ref`/`multi_ref`/`transform` (даже если не нужны) | `execute_command.ts`, `write_to_file.ts`                                          | **MEDIUM** — лишние токены, но корректно                       |
| 4   | `chat.ts` не обрабатывает `multi_ref` напрямую — это делает `resolveRef()` в index.ts                         | `chat.ts`                                                                         | **LOW** — делегировано оркестратору, корректно                 |
| 5   | `filter-tools-for-mode.ts` не трогает свойства схем — рефы проходят транзитом                                 | `filter-tools-for-mode.ts`                                                        | **INFO** — так и задумано                                      |
