# АУДИТ: source:chat — архитектура контекстного окна

## 1. Текущее состояние chat.ts

Файл: [`src/core/tools/ref/sources/chat.ts`](src/core/tools/ref/sources/chat.ts)

### Что делает

Функция `resolveChatSource()` принимает `ContentRef` с `ref.ref` = отрицательный индекс (например, `"-1"` — последнее сообщение ассистента) и возвращает фрагмент контента по этому индексу.

### Откуда читает

**Строка 28**: `const messages = task.assistantMessageContent`

### Структура данных, которую читает

```typescript
// src/core/task/Task.ts:344
assistantMessageContent: AssistantMessageContent[] = []
```

Где `AssistantMessageContent` ([`src/core/assistant-message/types.ts`](src/core/assistant-message/types.ts:3)) — это объединение:

```typescript
export type AssistantMessageContent = TextContent | ToolUse | McpToolUse
```

Каждый элемент — это **блок контента** (text, tool_use, mcp_tool_use), а не целое сообщение.

### Типы блоков, которые chat.ts умеет обрабатывать

| Тип            | Поле для текста                            |
| -------------- | ------------------------------------------ |
| `text`         | `.content`                                 |
| `tool_use`     | `JSON.stringify(.nativeArgs \|\| .params)` |
| `mcp_tool_use` | `JSON.stringify(.arguments)`               |

### В чём проблема

**`assistantMessageContent` — это потоковый буфер одного сообщения.** Он НЕ хранит историю. Он хранит блоки контента **текущего ассистентского сообщения**, которое сейчас стримится.

---

## 2. Три слоя данных

### Слой 0: Stream Buffer (`assistantMessageContent`)

```
Task.assistantMessageContent: AssistantMessageContent[]
```

- Живёт только во время стриминга одного ответа ассистента
- **Очищается** в `Task.ts:2615` при старте каждого API-запроса:
    ```typescript
    this.assistantMessageContent = []
    ```
- Содержит блоки с флагом `partial: boolean` для инкрементального отображения
- **Не сохраняется на диск**

### Слой 1: Saved History (`apiConversationHistory`)

```
Task.apiConversationHistory: ApiMessage[]
```

- Хранит **все** сообщения (user + assistant) за всю сессию
- Сохраняется на диск в `saveApiConversationHistory()` ([`Task.ts:966`](src/core/task/Task.ts:966)):
    ```typescript
    await saveApiMessages({
    	messages: structuredClone(this.apiConversationHistory),
    	taskId: this.taskId,
    	globalStoragePath: this.globalStoragePath,
    })
    ```
- Загружается с диска в `getSavedApiConversationHistory()` ([`Task.ts:860`](src/core/task/Task.ts:860))
- Содержит сообщения в Anthropic-формате: `{ role, content, ts, isSummary?, condenseParent?, condenseId?, ... }`
- Мост между слоями: `presentAssistantMessage()` собирает `Anthropic.MessageParam` из `assistantMessageContent` и сохраняет через `addToApiConversationHistory()` ([`Task.ts:3434`](src/core/task/Task.ts:3434))

### Слой 2: Effective History (фильтрованный вид)

```
getEffectiveApiHistory(apiConversationHistory): ApiMessage[]
```

Функция [`getEffectiveApiHistory()`](src/core/condense/index.ts:546) применяет фильтры:

1. **Fresh Start после конденсации**: если есть summary (`msg.isSummary === true`), возвращает только сообщения от summary и далее
2. **Фильтр condenseParent**: сообщения с `condenseParent`, указывающим на существующий summary, исключаются
3. **Фильтр truncationParent**: сообщения с `truncationParent`, указывающим на существующий маркер, исключаются
4. **Очистка orphan tool_result**: удаляются `tool_result` блоки, чьи `tool_use_id` не найдены в активных assistant-сообщениях

**Итог**: это то, что реально отправляется в API.

---

## 3. Где active window

Как `getEffectiveApiHistory()` ([`src/core/condense/index.ts:546`](src/core/condense/index.ts:546)) определяет границу:

```typescript
export function getEffectiveApiHistory(messages: ApiMessage[]): ApiMessage[] {
  // 1. Найти последний summary
  const lastSummary = findLast(messages, (msg) => msg.isSummary === true)

  if (lastSummary) {
    // 2. Fresh start: только от summary и далее
    const summaryIndex = messages.indexOf(lastSummary)
    let messagesFromSummary = messages.slice(summaryIndex)

    // 3. Удалить orphan tool_result
    // 4. Удалить truncationParent
    return messagesFromSummary.filter(...)
  }

  // 5. Без summary: фильтр по condenseParent / truncationParent
  return messages.filter(...)
}
```

**Схема active window:**

```
Без конденсации:
  [msg0][msg1][msg2]...[msgN]  ← Layer 1 (все)
  [msg0][msg1][msg2]...[msgN]  ← Layer 2 (все)

После конденсации (fresh start):
  [msg0(P)][msg1(P)]...[summary(id=X)]...[msgN]  ← Layer 1 (все, с тегами)
                       [summary(id=X)]...[msgN]  ← Layer 2 (active window)
                                              ^^^ последние N сообщений до summary
```

**Важно**: после конденсации `apiConversationHistory` содержит ВСЕ сообщения, но `getEffectiveApiHistory()` показывает только `summary + последние сообщения`. Сообщения с `condenseParent` скрыты, НО они всё ещё доступны для чтения в Layer 1.

---

## 4. Проблема с assistantMessageContent

### Когда очищается

В [`Task.ts:2612-2616`](src/core/task/Task.ts:2612):

```typescript
// Reset streaming state for each new API request
this.currentStreamingContentIndex = 0
this.currentStreamingDidCheckpoint = false
this.assistantMessageContent = [] // ← ОЧИСТКА
this.didCompleteReadingStream = false
this.userMessageContent = []
```

Это происходит **при старте каждого нового API-запроса**, после того как:

- Предыдущий ответ ассистента полностью получен
- `presentAssistantMessage()` обработал все блоки
- Сообщение сохранено в `apiConversationHistory` (через `addToApiConversationHistory()`)

### Что теряется

- **ВСЕ предыдущие сообщения ассистента**: chat.ts может видеть только блоки текущего стримящегося сообщения
- `"-1"` работает только если в данный момент идёт стриминг — после его завершения `assistantMessageContent` пуст
- `"-2"`, `"-3"` и т.д. никогда не работают, потому что массив всегда содержит только 0-N блоков одного сообщения

### Пример бага

```
User: "Сделай X"
  → API стримит ответ → assistantMessageContent = [text("делаю X"), tool_use(read_file)]
  → инструмент выполняется → assistantMessageContent = [text("делаю X"), tool_use(read_file)]
  → ответ завершён → assistantMessageContent = []
  → СТАРТ НОВОГО ЗАПРОСА → assistantMessageContent = []
  → API стримит новый ответ → assistantMessageContent = [text("результат")]

  CRT(source:"chat", ref:"-1") → ищет в assistantMessageContent → [text("результат")]
  CRT(source:"chat", ref:"-2") → out of bounds: длина = 1
```

**Правильное поведение**: `"-1"` должен указывать на предыдущее полное сообщение ассистента ("делаю X"), а не на текущее стримящееся.

---

## 5. Рекомендуемое решение

### chat.ts должен читать из Layer 1 или Layer 2

**Первый подход (Layer 1 — `apiConversationHistory`):**

- chat.ts получает `task.apiConversationHistory` (весь массив `ApiMessage[]`)
- Фильтрует ТОЛЬКО `assistant` сообщения (по полю `role`)
- Индексирует по отрицательному индексу: `-1` = последнее assistant-сообщение
- Извлекает текст из `content` (который может быть string или ContentBlockParam[])
- **Преимущество**: видит ВСЕ сообщения, включая сконденсированные
- **Недостаток**: может показывать контент, который LLM не видит (скрыт конденсацией)

**Второй подход (Layer 2 — `getEffectiveApiHistory()`):**

- chat.ts вызывает `getEffectiveApiHistory(task.apiConversationHistory)`
- Получает только те сообщения, которые реально видны API (active window)
- Фильтрует по `role === "assistant"`
- **Преимущество**: консистентность с тем, что видит LLM
- **Недостаток**: сконденсированные сообщения недоступны

### Рекомендация: Layer 2 (Effective History)

CRT — это инструмент для LLM. LLM должен цитировать только то, что он может видеть. Поэтому **правильный источник — Layer 2**. Если нужно цитировать сконденсированные сообщения, это должна быть отдельная фича (например, `source:"archive"`).

---

## 6. Virtual Content Grid (VCG)

### Концепция

VCG — это индексный файл, который позволяет LLM точно цитировать любой контент в своём active window, используя виртуальные координаты.

### Структура

```
Message Grid:
┌─────────┬──────┬──────────┬──────────────────────────┐
│ msg_idx │ role │ ts       │ blocks                   │
├─────────┼──────┼──────────┼──────────────────────────┤
│ 0       │ user │ 1000000  │ [text("сделай X")]       │
│ 1       │ asst │ 1000010  │ [tool_use(read_file)]    │
│ 2       │ user │ 1000020  │ [tool_result(...)]       │
│ 3       │ asst │ 1000030  │ [text("результат")]      │
└─────────┴──────┴──────────┴──────────────────────────┘

Block Grid (для сообщений с несколькими блоками):
┌─────────┬────────┬──────┬───────┬──────────────────────┐
│ msg_idx │ blk_idx│ type │ name  │ text_preview         │
├─────────┼────────┼──────┼───────┼──────────────────────┤
│ 3       │ 0      │ text │ —     │ "результат"          │
│ 3       │ 1      │ tool │ write │ "пишу файл..."       │
└─────────┴────────┴──────┴───────┴──────────────────────┘
```

### Как VCG решает проблему конденсации

После конденсации Layer 1 всё ещё содержит все сообщения с `condenseParent`. VCG может:

1. **Режим "active"** — показывает только Layer 2 (то, что видит API)
2. **Режим "full"** — показывает Layer 1 + Layer 2 (всё, что есть на диске)

LLM использует VCG для построения точных ref-ссылок.

### Формат ref с VCG

```
{ source: "chat", ref: "-1", startAnchor: "функция main(", endAnchor: "}" }
                    ^^^ индекс сообщения в active window
```

Или с явным временем:

```
{ source: "chat", ref: "@1000010", ... }
                    ^^^ timestamp сообщения
```

---

## 7. Код для правок в chat.ts

### Текущий код (проблемный)

```typescript
// src/core/tools/ref/sources/chat.ts:28
const messages = task.assistantMessageContent
```

### Предлагаемые изменения

#### 7.1. Импорт `getEffectiveApiHistory`

```typescript
// Добавить импорт
import { getEffectiveApiHistory } from "../../condense/index"
```

#### 7.2. Заменить источник данных

```typescript
// Вместо:
const messages = task.assistantMessageContent

// Использовать:
const allHistory = task.getApiConversationHistory() || task.apiConversationHistory
const effectiveHistory = getEffectiveApiHistory(allHistory)
const assistantMessages = effectiveHistory.filter((msg) => msg.role === "assistant")
```

**Или**, если `Task` не экспортирует `apiConversationHistory` напрямую (требует проверки), нужно добавить геттер.

#### 7.3. Изменить логику индексации

Сейчас `targetIndex` индексирует в массив блоков (`AssistantMessageContent[]`). Нужно индексировать в массив **сообщений** (`ApiMessage[]`):

```typescript
const targetIndex = assistantMessages.length + index // -1 → последнее assistant-сообщение

if (targetIndex < 0 || targetIndex >= assistantMessages.length) {
	throw new Error(
		`Chat message index ${ref.ref} out of bounds. Available: ${assistantMessages.length} assistant messages.`,
	)
}

const message = assistantMessages[targetIndex]
// Теперь message — это ApiMessage с role: "assistant"
```

#### 7.4. Изменить извлечение текста

`ApiMessage.content` может быть `string | Anthropic.ContentBlockParam[]`. Нужна функция-экстрактор:

```typescript
function extractTextFromApiMessage(message: ApiMessage): string {
	if (typeof message.content === "string") {
		return message.content
	}
	if (Array.isArray(message.content)) {
		return message.content
			.filter((block): block is Anthropic.TextBlockParam => block.type === "text")
			.map((block) => block.text)
			.join("\n")
	}
	return ""
}
```

#### 7.5. Полный обновлённый код функции

```typescript
import type { ContentRef } from "../../../../shared/tools"
import type { SelectorResult } from "../selector"
import { resolveContentRef } from "../selector"
import type { Task } from "../../../task/Task"
import { getEffectiveApiHistory } from "../../condense/index"

// Извлекает текст из ApiMessage.content
function extractTextFromMessage(message: ApiMessage): string {
	if (typeof message.content === "string") {
		return message.content
	}
	if (Array.isArray(message.content)) {
		return message.content
			.filter((block) => block.type === "text")
			.map((block) => (block as Anthropic.TextBlockParam).text)
			.join("\n")
	}
	return ""
}

export async function resolveChatSource(ref: ContentRef, task: Task): Promise<SelectorResult> {
	const index = parseInt(ref.ref, 10)
	if (isNaN(index) || index >= 0) {
		throw new Error(`Invalid chat ref index: ${ref.ref}. Use negative numbers (e.g., "-1" for last).`)
	}

	// Layer 2: effective history — только то, что видит API
	const effectiveHistory = getEffectiveApiHistory(task.apiConversationHistory)
	const assistantMessages = effectiveHistory.filter((msg) => msg.role === "assistant")
	const targetIndex = assistantMessages.length + index

	if (targetIndex < 0 || targetIndex >= assistantMessages.length) {
		throw new Error(
			`Chat message index ${ref.ref} out of bounds. Available: ${assistantMessages.length} assistant messages.`,
		)
	}

	const message = assistantMessages[targetIndex]
	const sourceText = extractTextFromMessage(message)

	if (!sourceText) {
		throw new Error(`Chat message at index ${ref.ref} is empty or not text.`)
	}

	const sourceId = `chat:${ref.ref}`
	return resolveContentRef(sourceId, sourceText, ref)
}
```

### 7.6. Зависимости и проверки

- Необходимо убедиться, что `Task.apiConversationHistory` — публичное поле (сейчас `public` по умолчанию, строка 310)
- `getEffectiveApiHistory` уже публичная функция, экспортируется из [`src/core/condense/index.ts`](src/core/condense/index.ts)
- Нужен импорт `Anthropic` для типов `TextBlockParam`
- Нужен импорт `ApiMessage` из `src/core/task-persistence`

### 7.7. Обработка сконденсированных сообщений

Если нужно также поддерживать референсы к сконденсированным сообщениям (Layer 1), можно добавить опциональный параметр:

```typescript
// В ContentRef добавить флаг includeArchived?: boolean
const source = ref.includeArchived
	? task.apiConversationHistory // Layer 1 — все сообщения
	: getEffectiveApiHistory(task.apiConversationHistory) // Layer 2 — active window
```

---

## Резюме

| Аспект            | Сейчас                              | Должно быть                                                |
| ----------------- | ----------------------------------- | ---------------------------------------------------------- |
| Источник данных   | `assistantMessageContent` (Layer 0) | `getEffectiveApiHistory(apiConversationHistory)` (Layer 2) |
| Тип данных        | `AssistantMessageContent[]` (блоки) | `ApiMessage[]` (сообщения)                                 |
| Индексация        | По блокам одного сообщения          | По сообщениям в active window                              |
| После стрима      | Массив пуст → out of bounds         | Все предыдущие сообщения доступны                          |
| После конденсации | N/A                                 | Сконденсированные скрыты (Layer 2)                         |
| Персистентность   | Нет (только в памяти)               | Есть (сохраняется на диск)                                 |
