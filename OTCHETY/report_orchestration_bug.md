# 🔥 Отчёт: Расследование сломанной оркестрации — `new_task` не возвращает результаты

**Дата:** 2026-06-04
**Автор:** Research Analyst (Mode: research-analyst)
**Версия BUILD:** 🔥🚀BUILD🚀🔥 (based on pre-b7857bcd6 codebase)

---

## 1. Executive Summary

**Коренная причина: Многофакторная регрессия.** BUILD содержит только ОДИН cherry-pick из цепочки upstream фиксов делегирования (`3c1895409`), в то время как 10+ критически важных коммитов, включая монументальный upstream-фикс на 20 файлов / 1714 строк (`b7857bcd6`), отсутствуют.

Оркестрация работает "через раз" потому, что некоторые гонки иногда выигрываются, иногда нет — в зависимости от тайминга, загрузки CPU и состояния globalState.

---

## 2. Сравнение веток

### Коммиты в BUILD (оркестрационные)

| Commit      | Что делает                                                                                       | Статус     |
| ----------- | ------------------------------------------------------------------------------------------------ | ---------- |
| `3c1895409` | 🔴 СУПЕРВАЖНЫЙ ФИКС: убран `cancelledDelegationChildIds` из guard в `reopenParentFromDelegation` | ✅ В BUILD |
|             | Exempt subtask from `didToolFailInCurrentTurn` guard                                             | ✅ В BUILD |
|             | Добавлен `console.warn` при неудачном reopen                                                     | ✅ В BUILD |

### Критические коммиты НЕ в BUILD

| Commit      | Что делает                                            | Файлов                     | Риск                        |
| ----------- | ----------------------------------------------------- | -------------------------- | --------------------------- |
| `b7857bcd6` | **МЕГА-ФИКС**: жесткое подавление гонок делегирования | **20 файлов / 1714 строк** | 🔴 КРИТИЧЕСКИЙ              |
| `d06d97020` | `skipPrevResponseIdOnce` для OpenAI Responses API     | 1 файл                     | 🔴 GPT-5 не видит результат |
| `b1765361d` | Defer new_task tool_result до завершения subtask      | 1 файл                     | 🟡 result возвращается рано |
| `b2a8c5c7b` | Parent hang после per-mode API profile switch         | 2 файла                    | 🟡                          |
| `70775f0ec` | `removeClineFromStack()` delegation-aware             | 2 файла                    | 🔴 orphaned parent tasks    |
| `7c58f2997` | Race condition в `new_task` delegation                | 1 файл                     | 🔴 потеря parent history    |
| `115d6c5fc` | Serialize taskHistory writes                          | 2 файла                    | 🔴 race на globalState      |
| `6826e20da` | Parent state loss при delegation                      | 1 файл                     | 🔴                          |
| `9b5f6392d` | Metadata‑driven subtasks                              | 8 файлов                   | 🔴                          |
| `e742511d9` | Infinite loop в `attempt_completion`                  | 1 файл                     | 🟡                          |
| `edd7cc098` | Flush pending tool results перед delegation           | 1 файл                     | 🟡                          |

---

## 3. Доказательства из кода

### 3.1. `delegationMeta.ts` — Файл ОТСУТСТВУЕТ

```bash
$ ls src/core/task-persistence/delegationMeta.ts
# => MISSING
```

Upstream-фикс `b7857bcd6` создаёт этот файл для per-task persistence делегационных метаданных. В BUILD вся делегационная информация хранится ТОЛЬКО в `globalState` (`updateTaskHistory`), что приводит к:

1. **Eviction**: Когда `globalState` переполняется, delegation-поля теряются
2. **Race condition**: `last writer wins` — child task может перезаписать parent delegation
3. **Нет fallback**: `removeClineFromStack` не имеет disk-based repair

### 3.2. `ClineProvider.ts` — Отсутствует `delegationInProgress` mutex

В BUILD (строка ~178):

```typescript
private cancelledDelegationChildIds = new Set<string>()
// 👆 cancelledDelegationChildIds ЕСТЬ, но её guard УЖЕ УБРАН (из 3c1895409)
```

Upstream добавляет:

```typescript
private delegationInProgress = false
public isTaskCreationInProgress = false
```

Без этого mutex'а две параллельные операции делегирования для одного parentId **рондают друг с другом**.

### 3.3. `ClineProvider.ts:delegateParentAndOpenChild` — Отличия

**BUILD** (строки ~3446-3463):

```typescript
const child = await this.createTask(message, undefined, parent as any, {
	initialTodos,
	initialStatus: "active", // ⚠️ ЕСТЬ в BUILD
	startTask: false,
})
// ... persist delegation
const { historyItem } = await this.getTaskWithId(parentTaskId) // ⚠️ Может упасть
```

**Upstream** (b7857bcd6):

```typescript
const child = await this.createTask(message, undefined, parent as any, {
	initialTodos,
	startTask: false, // initialStatus: УБРАН
})
// ... persist child initial status SEPARATELY before parent delegation
await this.updateTaskHistory({
	/* child status "active" */
})
// ... parent delegation with try-catch fallback from globalState
let parentHistory
try {
	parentHistory = (await this.getTaskWithId(parentTaskId)).historyItem
} catch (err) {
	// In-memory fallback if parent not in globalState
	parentHistory = {
		/* fallback */
	}
}
```

**Проблема**: `initialStatus: "active"` создаёт race condition — child task's `saveClineMessages` в `startTask()` может перезаписать parent's delegation поля в globalState.

### 3.4. `Task.ts` — Отсутствующие `.catch()` на `presentAssistantMessage`

**BUILD** (строки ~467-530+):

```typescript
presentAssistantMessage(this)
// ⚠️ НЕТ .catch() — необработанный reject = crash делегации
```

**Upstream**:

```typescript
presentAssistantMessage(this).catch((err) => {
	if (!this.abort) {
		console.error("[presentAssistantMessage] Unhandled error:", err)
	}
})
```

### 3.5. `Task.ts` — Отсутствует `skipPrevResponseIdOnce` фикс

Upstream `d06d97020` добавляет в `resumePausedTask()`:

```typescript
this.skipPrevResponseIdOnce = true
```

**Без этого GPT-5 / OpenAI Responses API никогда не получает subtask result** — модель видит только контекст ДО создания subtask.

### 3.6. `Task.ts` — Отсутствует `debouncedEmitTokenUsage.cancel()` в `dispose()`

Upstream добавляет:

```typescript
// Cancel debounced token usage emitter
this.debouncedEmitTokenUsage.cancel()
```

Без этого **zombie callback** может выполниться после dispose и вызвать некорректное состояние.

### 3.7. `AttemptCompletionTool.ts` — Анализ текущего кода

**Уже исправлено** (`3c1895409`):

- ✅ `cancelledDelegationChildIds` guard удалён из `reopenParentFromDelegation` (ClineProvider.ts строка 3534)
- ✅ Subtask exempt от `didToolFailInCurrentTurn` guard (строка 46)
- ✅ ParentHistory verification перед delegation (строка 104-108)
- ✅ Console.warn при неудачном reopen (строка 192-196)

**Проблемы остаются**:

- ⚠️ В `delegateToParent()` при неудачном reopen возвращается `"continue"` → поток падает на `ask("completion_result")` (строка 147) → оркестратор НЕ ПОЛУЧАЕТ результат
- ⚠️ Вся логика полагается на `getTaskWithId()` который может выбросить ошибку если parent не в globalState
- ⚠️ `emitTaskCompleted` вызывается после делегирования, но при `"continue"` пути не вызывается

---

## 4. Корневая причина сломанной оркестрации

### Основная причина: BUILD — это pre-b7857bcd6 код с единственным cherry-pick

`b7857bcd6` — это upstream PR #11379 (Hannes Rudolph), который исправляет **7 различных race conditions** в системе делегирования. BUILD был создан на основе кода ДО этого PR и cherry-pick'нул только один поверхностный симптом-фикс.

Цепочка отказов:

```
1. Пользователь создаёт subtask через new_task
2. `delegateParentAndOpenChild` записывает "delegated" в globalState
3. Subtask начинает работу, `startTask()` → `saveClineMessages()` вызывается
4. `saveClineMessages()` → `updateTaskHistory()` ПЕРЕЗАПИСЫВАЕТ globalState
   без delegation-полей (initialStatus race)
5. Parent теряет статус "delegated" → становится "active"
6. Subtask завершает → `attempt_completion` проверяет parent статус
7. Parent.status !== "delegated" → делегирование пропускается
8. Subtast завершается нормально, но parent НЕ ПОЛУЧАЕТ результат
```

**Если race не произошла** (шаг 4 успел до шага 5) → оркестрация работает. Если произошла — ломается.

### Как это выглядит пользователю:

- Оркестратор зависает "навсегда" (parent в статусе "delegated")
- Subtask показывает "готово", но parent не возобновляется
- Иногда работает, иногда нет
- Для GPT-5/OpenAI Responses API: результат subtask просто не отображается в промпте

---

## 5. План фикса

### Фаза 1: Безопасные cherry-pick из upstream (10 коммитов)

| #   | Коммит      | Файлы                                    | Приоритет | Риск              |
| --- | ----------- | ---------------------------------------- | --------- | ----------------- |
| 1   | `d06d97020` | `src/core/task/Task.ts`                  | 🔴 P0     | Низкий — 4 строки |
| 2   | `e742511d9` | `AttemptCompletionTool.ts`               | 🔴 P0     | Низкий            |
| 3   | `115d6c5fc` | `ClineProvider.ts` + тесты               | 🔴 P0     | Средний           |
| 4   | `edd7cc098` | `Task.ts` / `presentAssistantMessage.ts` | 🟡 P1     | Средний           |
| 5   | `d2d311e50` | `AttemptCompletionTool.ts`               | 🟡 P1     | Низкий            |
| 6   | `b1765361d` | `presentAssistantMessage.ts`             | 🔴 P0     | Средний           |

### Фаза 2: Мега-фикс b7857bcd6 (выборочно)

| #   | Компонент              | Файлы              | Описание                                                                                              |
| --- | ---------------------- | ------------------ | ----------------------------------------------------------------------------------------------------- |
| 7   | `delegationMeta.ts`    | НОВЫЙ файл         | Per-task delegation metadata persistence                                                              |
| 8   | `ClineProvider.ts`     | +~200 строк        | `delegationInProgress` mutex, TOCTOU fixes, disk fallback                                             |
| 9   | `Task.ts`              | +~80 строк         | Remove `initialStatus`, `.catch()` on `presentAssistantMessage()`, `debouncedEmitTokenUsage.cancel()` |
| 10  | `removeClineFromStack` | в ClineProvider.ts | Disk-based delegation repair fallback                                                                 |

### Фаза 3: Тесты

| #   | Тест                                      | Описание                                        |
| --- | ----------------------------------------- | ----------------------------------------------- |
| 11  | `attemptCompletionDelegation.spec.ts`     | Тест полного цикла делегирования (из b7857bcd6) |
| 12  | `delegationMeta.spec.ts`                  | Тест per-task persistence (из b7857bcd6)        |
| 13  | `provider-delegation.spec.ts`             | Тест на гонки (дополнить)                       |
| 14  | `removeClineFromStack-delegation.spec.ts` | Тест на repair при отмене (из b7857bcd6)        |

### Детальные правки (с примерами)

#### Правка 1: `src/core/task/Task.ts` — `.catch()` на presentAssistantMessage

```typescript
// ЗАМЕНИТЬ:
presentAssistantMessage(this)

// НА:
presentAssistantMessage(this).catch((err) => {
	if (!this.abort) {
		console.error("[presentAssistantMessage] Unhandled error:", err)
	}
})
```

**Где:** Все 4 места вызова `presentAssistantMessage(this)` в `Task.ts` (строки ~470, ~488, ~518, ~541)

#### Правка 2: `src/core/task/Task.ts` — skipPrevResponseIdOnce

```typescript
// В resumePausedTask(), ПОСЛЕ добавления subtask result в API историю:
if (!this.skipPrevResponseIdOnce) {
	this.skipPrevResponseIdOnce = true
}
```

**Где:** В методе `resumePausedTask()`, после `this.addToApiConversationHistory(...)` или эквивалента.

#### Правка 3: `src/core/task/Task.ts` — Remove initialStatus

```typescript
// УДАЛИТЬ:
interface TaskOptions extends CreateTaskOptions {
    // ...
    initialStatus?: "active" | "delegated" | "completed"  // <- удалить
}

// В конструкторе:
this.initialStatus = initialStatus  // <- удалить

// В saveClineMessages:
initialStatus: this.initialStatus,  // <- удалить
```

#### Правка 4: `src/core/task/Task.ts` — debouncedEmitTokenUsage.cancel()

```typescript
// В dispose(), ПОСЛЕ cancelCurrentRequest:
this.debouncedEmitTokenUsage.cancel()
```

#### Правка 5: `src/core/webview/ClineProvider.ts` — delegateParentAndOpenChild

```typescript
// 1. Убрать initialStatus из createTask
const child = await this.createTask(message, undefined, parent as any, {
	initialTodos,
	// initialStatus: "active",  <- УДАЛИТЬ
	startTask: false,
})

// 2. Сохранить child initial status отдельно
await this.updateTaskHistory(
	{
		id: child.taskId,
		ts: Date.now(),
		task: message,
		number: child.taskNumber,
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		status: "active",
		parentTaskId: parentTaskId,
		rootTaskId: child.rootTaskId,
		workspace: this.cwd,
	} as HistoryItem,
	{ broadcast: false },
)

// 3. Обработать случай, когда parent нет в globalState
let parentHistory: HistoryItem
try {
	parentHistory = (await this.getTaskWithId(parentTaskId)).historyItem
} catch (err) {
	parentHistory = {
		id: parentTaskId,
		ts: Date.now(),
		task: parentMetadata.task ?? "",
		number: parentMetadata.taskNumber ?? 0,
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		workspace: this.cwd,
	} as HistoryItem
}
```

#### Правка 6: `src/core/task-persistence/delegationMeta.ts` (НОВЫЙ ФАЙЛ)

```typescript
// Per-task delegation metadata file persistence
// Resolves globalState eviction race condition

export interface DelegationMeta {
	status: "active" | "delegated" | "completed"
	awaitingChildId: string | null
	delegatedToId: string | undefined
	childIds: string[] | undefined
	completedByChildId: string | undefined
	completionResultSummary: string | undefined
}

export async function saveDelegationMeta(params: {
	taskId: string
	globalStoragePath: string
	meta: DelegationMeta
}): Promise<void> {
	// Save delegation meta to per-task file
	// ...
}

export async function readDelegationMeta(params: {
	taskId: string
	globalStoragePath: string
}): Promise<DelegationMeta | null> {
	// Read delegation meta from per-task file
	// ...
}
```

---

## 6. Сводка рисков

| Риск                            | Описание                                                   | Вероятность                   |
| ------------------------------- | ---------------------------------------------------------- | ----------------------------- |
| Race condition globalState      | Child `saveClineMessages` перезаписывает parent delegation | 🟡 Средняя                    |
| GPT-5 subtask loss              | `previous_response_id` ломает контекст subtask result      | 🔴 Высокая (всегда для GPT-5) |
| Zombie callbacks                | `debouncedEmitTokenUsage` выполняется после dispose        | 🟡 Средняя                    |
| Parent state loss               | `getTaskWithId` падает если parent не в globalState        | 🔴 Высокая                    |
| `presentAssistantMessage` crash | Unhandled rejection обрывает делегацию                     | 🟢 Низкая (только при ошибке) |

---

## 7. Рекомендация

**Выполнить cherry-pick всех 10 коммитов в порядке возрастания зависимости, начиная с самых безопасных.** Приоритет:

1. `d06d97020` — GPT-5 fix (4 строки, безрисковый)
2. `e742511d9` — infinite loop fix
3. `115d6c5fc` — serialize taskHistory writes
4. `edd7cc098` — flush before delegation
5. `b1765361d` — defer new_task result
6. `b2a8c5c7b` — parent hang fix + per-mode API switch
7. `d2d311e50` — race condition in new_task
8. `70775f0ec` — delegation-aware removeClineFromStack
9. `6826e20da` — parent state loss
10. `b7857bcd6` — mega-fix (может потребовать разрешения конфликтов)
11. Создать `delegationMeta.ts` (отсутствует в BUILD)
