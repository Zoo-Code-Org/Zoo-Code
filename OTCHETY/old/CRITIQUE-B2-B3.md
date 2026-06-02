# CRITIQUE REPORT: B.2 + B.3

**Дата:** 2026-06-02T21:34 (MSK+3)
**Аналитик:** research-analyst
**Статус:** ✅ Завершено

---

## B.2 — Фикс `convertToolSchemaForOpenAI()` в `base-provider.ts`

### Фикс 1: Сохранение оригинального `required` массива

**Изменение:**

```typescript
// Было (строка 79):
result.required = allKeys

// Стало:
result.required = schema.required && schema.required.length > 0 ? schema.required : allKeys
```

#### Статус: ⚠️ Условно-корректно с риском

**Верификация через Context7** ([`/openai/openai-node`](https://github.com/openai/openai-node)):

- Исходники [`transform.ts`](https://github.com/openai/openai-node/blob/master/src/lib/transform.ts): функция `ensureStrictJsonSchema()` принудительно устанавливает `jsonSchema.required = Object.keys(properties)` — **все свойства должны быть required** при strict mode.
- Документация OpenAI: _"All fields in properties must be marked as required"_ для `strict: true`.

**Верификация через Tavily:**

- [OpenAI Developer Community — Strict mode & Required Fields](https://community.openai.com/t/strict-true-and-required-fields/1131075): подтверждается, что strict mode требует все поля в `required`.
- [OpenAI Function Calling docs](https://developers.openai.com/api/docs/guides/function-calling): _"Setting strict to true will ensure function calls reliably adhere to the function schema"_ с требованием всех полей в required.
- [Community thread — o1/o3 cannot handle optional args](https://community.openai.com/t/o1-o3-series-cannot-handle-optional-args-in-function-calling/1110558): пользователи сообщают, что strict mode **отклоняет** схемы, где не все поля в required.

**Проблема:** Если `schema.required` содержит **не все** ключи (что и бывает для CRT-схем, где `ref/multi_ref/transform` — опциональны), то при `strict: true` OpenAI **отклонит** запрос с ошибкой:

```
'required' is required to be supplied and to be an array including every key in properties
```

**Риск:** Регрессия для OpenAI strict mode. Фикс корректен только для случаев, где strict mode **выключен** (`strict: false` или `strict` не передан).

**Рекомендация:**

1. Добавить проверку: если `strict: true` → использовать `allKeys` (игнорировать оригинальный `required`)
2. Или: проверять, что все ключи из `properties` присутствуют в `schema.required`:
    ```typescript
    const originalRequired = schema.required?.filter((k: string) => allKeys.includes(k)) ?? []
    result.required = originalRequired.length === allKeys.length ? originalRequired : allKeys
    ```

---

### Фикс 2: Сохранение nullable union types (`["object", "null"]`)

**Изменение:**

```typescript
// Было:
const nonNullTypes = prop.type.filter((t: string) => t !== "null")
prop.type = nonNullTypes.length === 1 ? nonNullTypes[0] : nonNullTypes

// Стало:
const nonNullTypes = prop.type.filter((t: string) => t !== "null")
if (nonNullTypes.length > 0) {
	prop.type = nonNullTypes.length === 1 ? nonNullTypes[0] : nonNullTypes
}
// Если только null остаётся, логи
```

#### Статус: ✅ Корректно

**Верификация через Context7:**

- [OpenAI Migration Guide](https://github.com/openai/openai-node/blob/master/MIGRATION.md): _"Optional properties must explicitly be marked with `.nullable()`"_ — подтверждает, что nullable union types — официальный механизм.
- [OpenAI Helpers documentation](https://github.com/openai/openai-node/blob/master/helpers.md): примеры с `z.string().optional().nullable()` — двухэтапная маркировка optional + nullable.

**Верификация через Tavily:**

- [OpenAI Function Calling Guide](https://developers.openai.com/api/docs/guides/function-calling): _"You can denote optional fields by adding `null` as a type option"_ с примером `"type": ["string", "null"]`.
- [Community — Clarity on Optional Parameters](https://community.openai.com/t/clarity-on-optional-parameters-in-structured-outputs/928507): подтверждается, что `["string", "null"]` — правильный способ для optional полей.

**Анализ логики:**

- Если `type: ["string", "null"]` → `nonNullTypes = ["string"]` → `prop.type = "string"` ✅
- Если `type: ["object", "null"]` → `nonNullTypes = ["object"]` → `prop.type = "object"` ✅
- Если `type: "null"` (маловероятно) → `nonNullTypes = []` → **сохраняется оригинальный массив** ✅

---

### Сравнение с `openai-native.ts`

В [`openai-native.ts:250`](../../src/api/providers/openai-native.ts:250) функция `ensureAllRequired()` **до сих пор использует** `result.required = allKeys` без сохранения оригинального `required` массива. Это неконсистентно с фиксом в `base-provider.ts`.

#### Статус: ❌ Неконсистентность

**Рекомендация:** Синхронизировать `ensureAllRequired()` в `openai-native.ts` с фиксом из `base-provider.ts` (с учётом предостережения про strict mode).

---

## B.3 — Фикс `chat.ts`

### Изменения:

1. **Источник данных:** `task.assistantMessageContent` → `getEffectiveApiHistory(task.apiConversationHistory)`
2. **Фильтрация:** Только `role === "assistant"` сообщения
3. **Индексация:** По сообщениям (не по блокам контента)
4. **Новый хелпер:** `extractTextFromAssistantMessage()` для парсинга `ApiMessage`

#### Статус: ✅ Функционально корректно

**Анализ `getEffectiveApiHistory()`** ([`src/core/condense/index.ts:546`](../../src/core/condense/index.ts:546)):

- Функция корректно обрезает историю до активного окна (от последнего `isSummary` сообщения)
- Фильтрует orphan `tool_result` блоки, чьи `tool_use_id` отсутствуют в активном окне
- Это правильно для CRT — референсы должны указывать только на сообщения, которые реально видны модели

**Анализ индексации:**

- `const targetIndex = assistantMessages.length + index` — корректно для отрицательных индексов
- `-1` → последнее assistant сообщение
- `-2` → предпоследнее, и т.д.
- Валидация: `isNaN(index) || index >= 0` — корректно отклоняет `0`, положительные и NaN

**Анализ `extractTextFromAssistantMessage()`:**

- Text блоки: `block.text` — корректно
- ToolUse: `block.nativeArgs || block.params || {}` — корректно (сохраняет fallback)
- McpToolUse: `block.arguments || {}` — корректно
- String content fallback: `typeof message.content === "string"` — legacy support ✅

---

### B.3 — Найденные проблемы в тестовом покрытии

#### Проблема 1: ❌ Нет теста на фильтрацию user сообщений

Все тесты используют только `role: "assistant"` сообщения. Ни один тест не проверяет сценарий со смешанной историей:

```typescript
apiConversationHistory: [
	{ role: "user", content: [{ type: "text", text: "User question" }] },
	{ role: "assistant", content: [{ type: "text", text: "Assistant answer" }] },
]
```

В этом случае `history.filter(msg => msg.role === "assistant")` должен корректно отфильтровать user сообщение и `-1` должен возвращать "Assistant answer". **Это не тестируется.**

#### Проблема 2: ❌ Нет теста на `getEffectiveApiHistory` с обрезкой истории

Мок `getEffectiveApiHistory` в тестах — это identity function:

```typescript
getEffectiveApiHistory: vi.fn((messages: any) => messages)
```

Нет теста, где `getEffectiveApiHistory` реально обрезает историю (через `isSummary`), и индексация корректно работает с обрезанным массивом. Это **потенциальная регрессия** при использовании condensing.

#### Проблема 3: ⚠️ Краевой случай — `content: []` (пустой массив)

Если assistant сообщение приходит с `content: []`, `extractTextFromAssistantMessage()` возвращает `""`, что вызывает ошибку "empty or not text". Это может быть валидным сценарием при streaming или когда сообщение содержит только tool_result (который находится в user message по Anthropic convention).

---

### Тесты: ✅ Все 37 проходят

```
 ✓ 37 passed (1 file)
```

Тесты корректно переписаны с `assistantMessageContent` на `apiConversationHistory` с правильной структурой `{ role, content: [...] }`. Добавлен мок для `getEffectiveApiHistory`. 100% проходимость.

---

## Сводка

| #     | Изменение                            | Статус | Комментарий                                                   |
| ----- | ------------------------------------ | ------ | ------------------------------------------------------------- |
| B.2-1 | Сохранение оригинального `required`  | ⚠️     | Риск регрессии для strict mode. Нужна проверка `strict` флага |
| B.2-2 | Сохранение nullable union types      | ✅     | Полностью соответствует документации OpenAI                   |
| B.2-3 | Консистентность с `openai-native.ts` | ❌     | `openai-native.ts:250` не синхронизирован                     |
| B.3-1 | Переход на `getEffectiveApiHistory`  | ✅     | Корректно, но не тестируется с обрезкой                       |
| B.3-2 | Фильтрация assistant сообщений       | ⚠️     | Корректно в коде, не тестируется со смешанной историей        |
| B.3-3 | Индексация `-1`, `-2`                | ✅     | Математически корректна                                       |
| B.3-4 | Тесты                                | ✅     | 37/37 passed, но есть пробелы в покрытии                      |

### Ключевые рекомендации

1. **B.2-1:** Добавить проверку `strict` флага — при strict mode всегда использовать `allKeys`
2. **B.2-3:** Синхронизировать `openai-native.ts:ensureAllRequired()` с `base-provider.ts`
3. **B.3-1:** Добавить тест с `getEffectiveApiHistory`, реально обрезающим историю (через `isSummary`)
4. **B.3-2:** Добавить тест со смешанной user/assistant историей
5. **B.3-3:** Рассмотреть обработку `content: []` — возможно, не должна быть ошибкой

---

### Источники (MCP верификация)

**Context7:**

- [`/openai/openai-node`](https://github.com/openai/openai-node) — `transform.ts` (strict mode validation), `MIGRATION.md` (nullable.optional()), `helpers.md` (Zod schemas)
- [`/openai/openai-python`](https://github.com/openai/openai-python) — дополнительная верификация (альтернативный SDK)

**Tavily:**

- [OpenAI Function Calling Guide](https://developers.openai.com/api/docs/guides/function-calling) — официальная документация
- [Community: Strict=True and Required Fields](https://community.openai.com/t/strict-true-and-required-fields/1131075)
- [Community: o1/o3 series cannot handle optional args](https://community.openai.com/t/o1-o3-series-cannot-handle-optional-args-in-function-calling/1110558)
- [Community: Clarity on Optional Parameters](https://community.openai.com/t/clarity-on-optional-parameters-in-structured-outputs/928507)
