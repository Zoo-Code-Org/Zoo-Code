# BUG: Прерванный под-агент не возвращается к оркестратору

**Дата:** 2026-06-02  
**Статус:** Исследование завершено, корневая причина найдена  
**Серьёзность:** Высокая (потеря результатов подзадач)

---

## 1. Описание бага

### Как воспроизвести

1. Оркестратор (родительская задача) вызывает `new_task` для создания подзадачи
2. Подзадача начинает выполняться
3. Пользователь вмешивается — пишет дополнительное сообщение под-агенту (через чат)
4. Под-агент завершает работу через `attempt_completion`
5. **Ожидание:** результат возвращается к оркестратору, тот продолжает работу
6. **Реальность:** результат НЕ возвращается, оркестратор не возобновляется

### Симптомы

- После завершения подзадачи оркестратор "зависает" — не продолжает работу
- В логах появляется предупреждение: `Parent no longer awaiting child`
- Пользователь видит результат подзадачи, но оркестратор не получает его

---

## 2. Архитектура подзадач — схема потока

```
┌─────────────────────────────────────────────────────────────────────┐
│                        НОРМАЛЬНЫЙ ПОТОК                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Parent Task (Оркестратор)                                          │
│    │                                                                │
│    ├── new_task tool → delegateParentAndOpenChild()                 │
│    │       │                                                        │
│    │       ├── 1. flushPendingToolResultsToHistory()                │
│    │       ├── 2. removeClineFromStack() — закрыть родителя        │
│    │       ├── 3. handleModeSwitch(mode)                            │
│    │       ├── 4. createTask() — создать ребёнка                    │
│    │       ├── 5. updateTaskHistory: status="delegated"             │
│    │       ├── 6. child.start()                                     │
│    │       └── 7. emit(TaskDelegated)                               │
│    │                                                                │
│    │    Parent: status="delegated", awaitingChildId=childId         │
│    │    Child:  status="active"                                     │
│    │                                                                │
│    │    Child Task (Под-агент)                                      │
│    │      │                                                         │
│    │      ├── attempt_completion → delegateToParent()               │
│    │      │       │                                                 │
│    │      │       ├── askFinishSubTaskApproval() ← ждёт пользователя│
│    │      │       ├── reopenParentFromDelegation()                  │
│    │      │       │       │                                         │
│    │      │       │       ├── Проверка: status=="delegated"?        │
│    │      │       │       ├── Инъекция subtask_result в историю     │
│    │      │       │       ├── Обновление метаданных родителя        │
│    │      │       │       ├── removeClineFromStack() — закрыть чаилд│
│    │      │       │       ├── createTaskWithHistoryItem() — ребилд  │
│    │      │       │       └── resumeAfterDelegation()               │
│    │      │       │                                                 │
│    │      │       └── emit(TaskDelegationCompleted)                 │
│    │      │                                                         │
│    │      └── emit(TaskCompleted)                                   │
│    │                                                                │
│    │    Parent: status="active", возобновлён                        │
│    │                                                                │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                    ПОТОК С ВМЕШАТЕЛЬСТВОМ ПОЛЬЗОВАТЕЛЯ              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Parent Task (delegated)                                            │
│    │                                                                │
│    │    Child Task (active)                                         │
│    │      │                                                         │
│    │      ├── [Пользователь пишет сообщение в чат]                  │
│    │      │       │                                                 │
│    │      │       ├── webviewMessageHandler: askResponse            │
│    │      │       │   → getCurrentTask().handleWebviewAskResponse() │
│    │      │       │   → child.handleWebviewAskResponse("messageResponse")│
│    │      │       │                                                 │
│    │      │       └── ⚠️ ЭТО СООБЩЕНИЕ ПОПАДАЕТ В ЧАЙЛД, А НЕ В РОДИТЕЛЯ│
│    │      │                                                         │
│    │      ├── [Пользователь нажимает "Yes" на completion_result]    │
│    │      │       │                                                 │
│    │      │       ├── askFinishSubTaskApproval()                    │
│    │      │       │   → askApproval("tool", {tool:"finishTask"})    │
│    │      │       │   → child.ask("tool", ...)                      │
│    │      │       │                                                 │
│    │      │       └── ⚠️ НО: если пользователь уже ответил на       │
│    │      │           completion_result через "messageResponse"     │
│    │      │           (своё сообщение), то askTs уже изменился!     │
│    │      │                                                         │
│    │      └── attempt_completion → delegateToParent()               │
│    │              │                                                 │
│    │              └── reopenParentFromDelegation()                  │
│    │                      │                                         │
│    │                      └── Проверка: status=="delegated"?        │
│    │                          └── ✅ Да → продолжаем               │
│    │                                                                │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. Найденные проблемы в коде

### Проблема 1: Race condition между пользовательским сообщением и `attempt_completion`

**Файл:** [`src/core/task/Task.ts:1300-1333`](src/core/task/Task.ts:1300)  
**Метод:** `ask()`

```typescript
// Строка 1301-1326: pWaitFor ждёт askResponse или изменения lastMessageTs
await pWaitFor(
	() => {
		if (this.askResponse !== undefined || this.lastMessageTs !== askTs) {
			return true
		}
		// ...
		return false
	},
	{ interval: 100 },
)

// Строка 1328-1333: если lastMessageTs изменился — ask отменяется
if (this.lastMessageTs !== askTs) {
	throw new AskIgnoredError("superseded")
}
```

**Суть проблемы:** Когда пользователь пишет сообщение в чат во время ожидания `ask("completion_result")`, вызывается `handleWebviewAskResponse("messageResponse", text, images)`, который устанавливает `this.askResponse = "messageResponse"`. Это нормально — под-агент получает фидбек и продолжает работу.

**НО:** если пользователь пишет сообщение ДО того, как под-агент вызвал `attempt_completion`, это сообщение попадает в под-агента как `user_feedback`, и под-агент продолжает работу. Это ожидаемое поведение.

**Проблема возникает, когда:**

1. Под-агент вызывает `attempt_completion` → `ask("completion_result")` → ждёт ответа
2. Пользователь пишет сообщение → `handleWebviewAskResponse("messageResponse")` → ask завершается
3. Под-агент получает фидбек, продолжает работу, снова вызывает `attempt_completion`
4. Пользователь нажимает "Yes" → `handleWebviewAskResponse("yesButtonClicked")`
5. **BUT:** если между шагами 3 и 4 пользователь успел написать ещё одно сообщение, `lastMessageTs` изменится, и ask будет отменён с `AskIgnoredError("superseded")`

### Проблема 2: `askFinishSubTaskApproval` использует `askApproval("tool")`, а не отдельный тип

**Файл:** [`src/core/assistant-message/presentAssistantMessage.ts:531-538`](src/core/assistant-message/presentAssistantMessage.ts:531)

```typescript
const askFinishSubTaskApproval = async () => {
	const toolMessage = JSON.stringify({ tool: "finishTask" })
	return await askApproval("tool", toolMessage)
}
```

**Суть проблемы:** `askFinishSubTaskApproval` вызывает `askApproval("tool", ...)`, что в конечном итоге вызывает `cline.ask("tool", ...)`. Это создаёт **новый ask**, который ждёт ответа пользователя.

Если пользователь уже ответил на `completion_result` через "Yes" (`yesButtonClicked`), то `handleWebviewAskResponse` уже был вызван. Но `askFinishSubTaskApproval` создаёт **новый** ask с новым `askTs`, и если пользователь не успеет ответить на этот новый ask, он может быть перезаписан другим сообщением.

### Проблема 3: Проверка `parentHistory.status !== "delegated"` в `reopenParentFromDelegation`

**Файл:** [`src/core/webview/ClineProvider.ts:3405`](src/core/webview/ClineProvider.ts:3405)

```typescript
if (historyItem.status !== "delegated" || historyItem.awaitingChildId !== childTaskId) {
	this.log(
		`[reopenParentFromDelegation] Aborting: parent ${parentTaskId} is no longer delegated to child ${childTaskId} ` +
			`(status=${historyItem.status}, awaitingChildId=${historyItem.awaitingChildId})`,
	)
	return false
}
```

**Суть проблемы:** Если родительская задача была каким-то образом переведена в статус "active" (например, через `removeClineFromStack` → `runDelegationTransition`), то `reopenParentFromDelegation` вернёт `false`, и делегация не завершится.

Это может произойти, если:

1. Пользователь нажимает "Stop" или "Clear" во время выполнения подзадачи
2. `cancelTask()` вызывается для подзадачи
3. `cancelTask()` → `runDelegationTransition` → родитель переводится в "active"
4. Подзадача завершается → `reopenParentFromDelegation` → проверка не проходит → `return false`

### Проблема 4: `removeClineFromStack` вызывается ДВАжды при завершении подзадачи

**Файл:** [`src/core/webview/ClineProvider.ts:3559-3562`](src/core/webview/ClineProvider.ts:3559)

```typescript
const current = this.getCurrentTask()
if (current?.taskId === childTaskId) {
	await this.removeClineFromStack({ skipDelegationRepair: true })
}
```

**Суть проблемы:** `removeClineFromStack` вызывается из `reopenParentFromDelegation` для закрытия подзадачи. Но если подзадача уже была закрыта (например, пользователь нажал "Stop"), то `getCurrentTask()` вернёт не подзадачу, и этот код не выполнится. Это нормально.

**НО:** если подзадача закрыта, а родитель не был переведён в "active" (например, из-за ошибки в `runDelegationTransition`), то родитель останется в статусе "delegated" и не сможет быть возобновлён.

---

## 4. Конкретные файлы и строки

| Файл                                                                                                             | Строки    | Описание                                                      |
| ---------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------- |
| [`src/core/tools/NewTaskTool.ts`](src/core/tools/NewTaskTool.ts)                                                 | 112-122   | Создание подзадачи через `delegateParentAndOpenChild`         |
| [`src/core/tools/AttemptCompletionTool.ts`](src/core/tools/AttemptCompletionTool.ts)                             | 86-145    | Проверка `parentTaskId` и вызов `delegateToParent`            |
| [`src/core/tools/AttemptCompletionTool.ts`](src/core/tools/AttemptCompletionTool.ts)                             | 171-201   | Метод `delegateToParent` — вызов `reopenParentFromDelegation` |
| [`src/core/webview/ClineProvider.ts`](src/core/webview/ClineProvider.ts)                                         | 3218-3377 | `delegateParentAndOpenChild` — создание подзадачи             |
| [`src/core/webview/ClineProvider.ts`](src/core/webview/ClineProvider.ts)                                         | 3382-3619 | `reopenParentFromDelegation` — возобновление родителя         |
| [`src/core/webview/ClineProvider.ts`](src/core/webview/ClineProvider.ts)                                         | 3405      | Проверка `status !== "delegated"` — точка отказа              |
| [`src/core/webview/ClineProvider.ts`](src/core/webview/ClineProvider.ts)                                         | 471-542   | `removeClineFromStack` — закрытие задачи                      |
| [`src/core/task/Task.ts`](src/core/task/Task.ts)                                                                 | 1118-1353 | Метод `ask()` — ожидание ответа пользователя                  |
| [`src/core/task/Task.ts`](src/core/task/Task.ts)                                                                 | 1300-1333 | `pWaitFor` с проверкой `lastMessageTs !== askTs`              |
| [`src/core/task/Task.ts`](src/core/task/Task.ts)                                                                 | 1355-1402 | `handleWebviewAskResponse` — обработка ответа                 |
| [`src/core/task/Task.ts`](src/core/task/Task.ts)                                                                 | 1439-1483 | `submitUserMessage` — отправка пользовательского сообщения    |
| [`src/core/assistant-message/presentAssistantMessage.ts`](src/core/assistant-message/presentAssistantMessage.ts) | 531-538   | `askFinishSubTaskApproval` — запрос подтверждения завершения  |
| [`src/core/webview/webviewMessageHandler.ts`](src/core/webview/webviewMessageHandler.ts)                         | 654-661   | Обработка `askResponse` от WebView                            |

---

## 5. Корневая причина

**Главная корневая причина — отсутствие синхронизации между пользовательским вмешательством и процессом завершения подзадачи.**

Когда пользователь пишет сообщение под-агенту во время ожидания `attempt_completion`:

1. `attempt_completion` вызывает `task.ask("completion_result", "", false)` — создаёт ask с `askTs = T1`
2. Пользователь пишет сообщение → `handleWebviewAskResponse("messageResponse", text)` → `askResponse = "messageResponse"`
3. `pWaitFor` завершается, `ask()` возвращает `{ response: "messageResponse", text }`
4. Под-агент обрабатывает фидбек, продолжает работу
5. Под-агент снова вызывает `attempt_completion` → `task.ask("completion_result", "", false)` — создаёт ask с `askTs = T2`
6. Пользователь нажимает "Yes" → `handleWebviewAskResponse("yesButtonClicked")` → `askResponse = "yesButtonClicked"`
7. `pWaitFor` завершается, `ask()` возвращает `{ response: "yesButtonClicked" }`
8. `AttemptCompletionTool` вызывает `delegateToParent()` → `askFinishSubTaskApproval()`
9. `askFinishSubTaskApproval()` вызывает `askApproval("tool", ...)` → `cline.ask("tool", ...)` — создаёт ask с `askTs = T3`
10. **Пользователь должен нажать "Yes" ещё раз** на запрос "finishTask"

**Проблема в шаге 10:** Пользователь уже нажал "Yes" на `completion_result`, но система требует ЕЩЁ ОДНО подтверждение через `askFinishSubTaskApproval`. Если пользователь не нажимает "Yes" на этот второй запрос (или если его сообщение перезаписывает ask), то:

- `askFinishSubTaskApproval` получает `response !== "yesButtonClicked"`
- `delegateToParent` возвращает `"denied"`
- `pushToolResult(formatResponse.toolDenied())` — результат НЕ передаётся родителю
- Родитель остаётся в статусе "delegated" и не возобновляется

---

## 6. Рекомендации по фиксу

### Вариант A: Убрать двойное подтверждение (рекомендуется)

**Идея:** Если пользователь уже подтвердил `completion_result` через "Yes", то `askFinishSubTaskApproval` не должен запрашивать подтверждение повторно.

**Изменения в** [`src/core/tools/AttemptCompletionTool.ts`](src/core/tools/AttemptCompletionTool.ts):

```typescript
// В методе execute, после получения response === "yesButtonClicked":
if (response === "yesButtonClicked") {
	if (task.parentTaskId) {
		// Пользователь уже подтвердил — сразу делегируем без доп. подтверждения
		const provider = task.providerRef.deref() as DelegationProvider | undefined
		if (provider) {
			const didReopen = await provider.reopenParentFromDelegation({
				parentTaskId: task.parentTaskId,
				childTaskId: task.taskId,
				completionResultSummary: result,
			})
			if (didReopen) {
				this.emitTaskCompleted(task)
				return
			}
		}
	}
	this.emitTaskCompleted(task)
	return
}
```

### Вариант B: Синхронизировать `askFinishSubTaskApproval` с предыдущим ask

**Идея:** Передавать контекст предыдущего подтверждения в `askFinishSubTaskApproval`, чтобы он не запрашивал подтверждение повторно, если пользователь уже ответил "Yes".

### Вариант C: Обработать `AskIgnoredError` в `delegateToParent`

**Идея:** Если `askFinishSubTaskApproval` получает `AskIgnoredError` (ask был перезаписан), то считать это автоматическим подтверждением.

**Изменения в** [`src/core/tools/AttemptCompletionTool.ts:171-201`](src/core/tools/AttemptCompletionTool.ts:171):

```typescript
private async delegateToParent(...): Promise<"delegated" | "denied" | "continue"> {
    try {
        const didApprove = await askFinishSubTaskApproval()
        if (!didApprove) {
            pushToolResult(formatResponse.toolDenied())
            return "denied"
        }
    } catch (error) {
        if (error instanceof AskIgnoredError) {
            // Ask был перезаписан — считаем автоматическим подтверждением
            console.warn("[delegateToParent] AskIgnoredError — treating as approved")
        } else {
            throw error
        }
    }
    // ... продолжить с reopenParentFromDelegation
}
```

### Вариант D: Добавить таймаут и fallback в `reopenParentFromDelegation`

**Идея:** Если `reopenParentFromDelegation` возвращает `false` из-за несоответствия статуса, добавить механизм автоматического восстановления.

---

## 7. Тесты для проверки фикса

1. **Тест на двойное подтверждение:** Проверить, что после "Yes" на `completion_result` подзадача завершается без дополнительного подтверждения
2. **Тест на пользовательское сообщение:** Проверить, что сообщение пользователя во время `attempt_completion` не ломает делегацию
3. **Тест на race condition:** Проверить, что быстрые последовательные сообщения пользователя не приводят к потере результата
4. **Тест на отмену подзадачи:** Проверить, что отмена подзадачи корректно восстанавливает родителя

---

## 8. Связанные тесты

- [`src/core/task/__tests__/new-task-isolation.spec.ts`](src/core/task/__tests__/new-task-isolation.spec.ts) — изоляция `new_task`
- [`src/core/task/__tests__/flushPendingToolResultsToHistory.spec.ts`](src/core/task/__tests__/flushPendingToolResultsToHistory.spec.ts) — сброс tool results
- [`src/core/tools/__tests__/attemptCompletionTool.spec.ts`](src/core/tools/__tests__/attemptCompletionTool.spec.ts) — тесты `attempt_completion`
- [`src/core/webview/__tests__/ClineProvider.spec.ts`](src/core/webview/__tests__/ClineProvider.spec.ts) — тесты провайдера
