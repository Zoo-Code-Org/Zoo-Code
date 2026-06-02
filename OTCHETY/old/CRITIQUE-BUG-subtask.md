# CRITIQUE: BUG-subtask-completion-flow.md

**Критик:** Research Analyst Elite  
**Дата:** 2026-06-02  
**Вердикт:** ⚠️ ЧАСТИЧНО КОРРЕКТЕН (PARTIALLY CORRECT)

---

## 1. Общий вердикт

| Аспект                | Оценка                          |
| --------------------- | ------------------------------- |
| Диагноз проблемы      | ⚠️ Частично верен               |
| Понимание архитектуры | ✅ Хорошее                      |
| Анализ кода           | ⚠️ Содержит фактические ошибки  |
| Корневая причина      | ❌ Неверна                      |
| Рекомендации          | ❌ Неприменимы к реальному коду |

---

## 2. Постатейная проверка утверждений

### 2.1. Схема потока (Нормальный поток) — ✅ КОРРЕКТНО

Схема на линиях 30-69 корректно описывает нормальный поток делегации:

```
attempt_completion → delegateToParent() → askFinishSubTaskApproval() → reopenParentFromDelegation()
```

Это соответствует коду:

- [`AttemptCompletionTool.ts:86-145`](src/core/tools/AttemptCompletionTool.ts:86) — проверка `parentTaskId`
- [`AttemptCompletionTool.ts:109-115`](src/core/tools/AttemptCompletionTool.ts:109) — вызов `delegateToParent()`
- [`AttemptCompletionTool.ts:178-183`](src/core/tools/AttemptCompletionTool.ts:178) — `askFinishSubTaskApproval()` внутри `delegateToParent`
- [`AttemptCompletionTool.ts:185-189`](src/core/tools/AttemptCompletionTool.ts:185) — `reopenParentFromDelegation()`

### 2.2. Схема потока (С вмешательством) — ✅ КОРРЕКТНО

Схема на линиях 72-105 корректно показывает, что пользовательское сообщение обрабатывается через `handleWebviewAskResponse` внутри чайлда.

### 2.3. Problem 1 (Race condition) — ❌ НЕВЕРНО

**Утверждение (строка 141-145):**

> 1. Под-агент вызывает attempt_completion → ask("completion_result") → ждёт ответа
> 2. Пользователь пишет сообщение → handleWebviewAskResponse("messageResponse") → ask завершается
> 3. Под-агент получает фидбек, продолжает работу, снова вызывает attempt_completion
> 4. Пользователь нажимает "Yes" → handleWebviewAskResponse("yesButtonClicked")
> 5. BUT: если между шагами 3 и 4 пользователь успел написать ещё одно сообщение, lastMessageTs изменится...

**Реальность:** ❌ Делегационный путь НЕ вызывает `task.ask("completion_result")`.

Фактический код в [`AttemptCompletionTool.ts:83-145`](src/core/tools/AttemptCompletionTool.ts:83):

```typescript
// Строка 83: say — не ask! Это неблокирующий вывод результата
await task.say("completion_result", result, undefined, false)

// Строка 86-145: проверка parentTaskId и делегация
if (task.parentTaskId) {
    // ... проверки статуса ...
    const delegation = await this.delegateToParent(...)
    if (delegation === "delegated") {
        this.emitTaskCompleted(task)
    }
    if (delegation !== "continue") return  // ← выход, ask("completion_result") НЕ вызывается!
}

// Строка 147: ask("completion_result") — ДОСТИГАЕТСЯ ТОЛЬКО если:
// - НЕТ parentTaskId (не подзадача)
// - ИЛИ delegation вернул "continue" (родитель больше не ждёт)
const { response, text, images } = await task.ask("completion_result", "", false)
```

**Важное различие:**

- `task.say("completion_result", ...)` — неблокирующий, выводит результат в UI (строка 83)
- `task.ask("completion_result", ...)` — блокирующий, ждёт ответа пользователя (строка 147)

В делегационном пути `attempt_completion` вызывает:

1. `say("completion_result")` — показать результат (НЕ блокирует)
2. `delegateToParent()` → `askFinishSubTaskApproval()` → `askApproval("tool")` → `cline.ask("tool")` — **ЭТО единственный блокирующий ask**

### 2.4. Problem 2 (askFinishSubTaskApproval использует askApproval("tool")) — ✅ КОРРЕКТНО

**Утверждение (строки 148-160):** `askFinishSubTaskApproval` использует `askApproval("tool")`, а не отдельный тип ask.

**Реальность:** ✅ Подтверждается кодом:

[`presentAssistantMessage.ts:531-538`](src/core/assistant-message/presentAssistantMessage.ts:531):

```typescript
const askFinishSubTaskApproval = async () => {
	const toolMessage = JSON.stringify({ tool: "finishTask" })
	return await askApproval("tool", toolMessage)
}
```

[`presentAssistantMessage.ts:494-528`](src/core/assistant-message/presentAssistantMessage.ts:494):

```typescript
const askApproval = async (type, partialMessage?, progressStatus?, isProtected?) => {
    const { response, text, images } = await cline.ask(type, partialMessage, false, ...)
    if (response !== "yesButtonClicked") {
        // Любой не-Yes ответ = denial
        if (text) {
            pushToolResult(formatResponse.toolDeniedWithFeedback(text))
        } else {
            pushToolResult(formatResponse.toolDenied())
        }
        return false
    }
    return true
}
```

### 2.5. Problem 3 (status !== "delegated" в reopenParentFromDelegation) — ✅ КОРРЕКТНО

**Утверждение (строки 162-182):** Проверка `status !== "delegated"` на строке 3405 может прервать делегацию.

**Реальность:** ✅ Подтверждается кодом:

[`ClineProvider.ts:3405-3411`](src/core/webview/ClineProvider.ts:3405):

```typescript
if (historyItem.status !== "delegated" || historyItem.awaitingChildId !== childTaskId) {
	this.log(`[reopenParentFromDelegation] Aborting: parent ${parentTaskId}...`)
	return false
}
```

Но сценарий, описываемый в отчёте (Stop/Clear → cancelTask → смена статуса), обрабатывается через `runDelegationTransition` lock ([`ClineProvider.ts:3388`](src/core/webview/ClineProvider.ts:3388)), что предотвращает race condition между `cancelTask` и `reopenParentFromDelegation`.

### 2.6. Problem 4 (removeClineFromStack вызывается дважды) — ⚠️ КОРРЕКТНО, НО НЕ ПРОБЛЕМА

**Утверждение (строки 183-197):** `removeClineFromStack` вызывается дважды.

**Реальность:** ✅ Действительно вызывается:

1. В [`delegateParentAndOpenChild:3276`](src/core/webview/ClineProvider.ts:3276) — для закрытия родителя при создании чайлда
2. В [`reopenParentFromDelegation:3561`](src/core/webview/ClineProvider.ts:3561) — для закрытия чайлда при возврате к родителю

Оба вызова используют `{ skipDelegationRepair: true }`, что предотвращает повторный ремонт родителя. Это безопасно.

### 2.7. Problem 4 (подзадача закрыта, родитель не переведён в active) — ⚠️ НЕТОЧНО

**Утверждение (строки 195-197):** Если подзадача закрыта, а родитель не был переведён в "active", родитель останется в "delegated" и не сможет быть возобновлён.

**Реальность:** Этот сценарий обрабатывается в [`removeClineFromStack:516-531`](src/core/webview/ClineProvider.ts:516):

```typescript
if (parentTaskId && childTaskId && !options?.skipDelegationRepair) {
	// ремонт родителя: delegated → active
}
```

НО если `skipDelegationRepair: true` (как при вызове из `reopenParentFromDelegation`), ремонт не выполняется. Это ожидаемо, т.к. `reopenParentFromDelegation` сам управляет статусом родителя.

---

## 3. Ключевая ошибка в анализе корневой причины

### Что утверждает отчёт (строки 221-243):

Отчёт описывает сценарий с **двумя подтверждениями**:

1. `ask("completion_result")` — пользователь нажимает "Yes"
2. `askFinishSubTaskApproval()` — пользователь должен нажать "Yes" снова

И утверждает, что проблема в том, что пользователь должен дважды подтверждать.

### Что происходит на самом деле:

**НЕТ двух подтверждений.** В делегационном пути есть только ОДНО подтверждение: `askFinishSubTaskApproval()` → `askApproval("tool")` → `cline.ask("tool")`.

`task.say("completion_result", ...)` — это не `ask()`, это неблокирующий вывод в UI.

### Реальная корневая причина:

**`askFinishSubTaskApproval()` использует `askApproval("tool")`, который преобразует ЛЮБОЙ ответ пользователя, кроме `yesButtonClicked`, в отказ (denial).**

Когда пользователь отправляет текстовое сообщение в чат во время ожидания `askFinishSubTaskApproval`:

1. [`webviewMessageHandler.ts:654-660`](src/core/webview/webviewMessageHandler.ts:654):

    ```
    case "askResponse":
        provider.getCurrentTask()?.handleWebviewAskResponse(message.askResponse!, ...)
    ```

2. [`Task.ts:1355-1401`](src/core/task/Task.ts:1355):
   `handleWebviewAskResponse("messageResponse", text, images)` → устанавливает `askResponse = "messageResponse"`

3. [`Task.ts:1301-1326`](src/core/task/Task.ts:1301): `pWaitFor` завершается, т.к. `askResponse !== undefined`

4. [`presentAssistantMessage.ts:508-518`](src/core/assistant-message/presentAssistantMessage.ts:508):
    ```typescript
    if (response !== "yesButtonClicked") {
    	// messageResponse → сюда!
    	pushToolResult(formatResponse.toolDeniedWithFeedback(text))
    	return false
    }
    ```
5. [`AttemptCompletionTool.ts:178-183`](src/core/tools/AttemptCompletionTool.ts:178):
   `didApprove = false` → `delegateToParent()` возвращает `"denied"`

6. [`AttemptCompletionTool.ts:119`](src/core/tools/AttemptCompletionTool.ts:119):
   `if (delegation !== "continue") return` → **EXIT без возобновления родителя!**

**Результат: parent остаётся в статусе "delegated", пользователь видит сообщение об отказе, оркестратор не возобновляется.**

---

## 4. Дополнительные проблемы, НЕ описанные в отчёте

### 4.1. `say("completion_result")` изменяет `lastMessageTs`

[`Task.ts:1683-1684`](src/core/task/Task.ts:1683):

```typescript
if (!options.isNonInteractive) {
	this.lastMessageTs = sayTs
}
```

`say("completion_result", result, undefined, false)` вызывается без `isNonInteractive: true`, что означает, что `lastMessageTs` обновляется. Если есть активный `ask()` (например, от другого инструмента в той же пачке), он будет прерван с `AskIgnoredError("superseded")`.

### 4.2. Нет защиты от повторного ввода пользователя в `askFinishSubTaskApproval`

В отличие от `ask("completion_result")` (строка 147), где ответ пользователя корректно обрабатывается (Yes → complete, messageResponse → feedback), `askFinishSubTaskApproval` не имеет ветки для `messageResponse`. Любое сообщение = denial.

### 4.3. `submitUserMessage` не очищается при входе в `delegateToParent`

Хотя `ask()` очищает `askResponse = undefined` при создании нового ask (строка 1207), старый `askResponse` мог быть установлен ДО вызова `attempt_completion`. Это нормальный случай, но если `submitUserMessage` был вызван между `say("completion_result")` и `delegateToParent()`, он может оставить stale `askResponse`.

---

## 5. Анализ рекомендаций по фиксу

### Вариант A: Убрать двойное подтверждение — ❌ НЕПРИМЕНИМ

Основан на неверной посылке о двойном подтверждении. `ask("completion_result")` НЕ вызывается в делегационном пути. Изменения в `AttemptCompletionTool.ts` (строки 255-276) не будут иметь эффекта.

### Вариант B: Синхронизировать askFinishSubTaskApproval — ⚠️ ТРЕБУЕТ УТОЧНЕНИЯ

Идея верная, но предложение слишком абстрактное. Конкретная реализация должна:

- Передавать контекст предыдущего ответа пользователя
- Игнорировать `askFinishSubTaskApproval` если пользователь уже явно подтвердил

### Вариант C: Обработать AskIgnoredError — ✅ ПОЛЕЗНО, НО НЕДОСТАТОЧНО

Обработка `AskIgnoredError` в `delegateToParent` — хорошая идея (строки 296-298), но это не решает основную проблему: когда пользователь отправляет `messageResponse` (не `yesButtonClicked`), `AskIgnoredError` НЕ выбрасывается. Ask успешно завершается, но с неверным ответом.

### Вариант D: Таймаут и fallback — ✅ ПОЛЕЗНО

Добавление таймаута и fallback в `reopenParentFromDelegation` может помочь при ошибках статуса.

### Что нужно на самом деле:

**Основной фикс:** `askFinishSubTaskApproval()` или `askApproval()` должны обрабатывать `messageResponse` как "продолжить ожидание" вместо "отказ". Если пользователь отправил сообщение, это не означает, что он отклоняет завершение подзадачи.

```typescript
// Примерная логика фикса:
const askFinishSubTaskApproval = async () => {
	while (true) {
		const { response, text, images } = await cline.ask("tool", finishTaskMessage, false)
		if (response === "yesButtonClicked") {
			return true
		}
		if (response === "messageResponse") {
			// Пользователь отправил сообщение — применить фидбек и переспросить
			if (text) {
				await cline.say("user_feedback", text, images)
			}
			// Продолжить цикл (заново показать подтверждение)
			continue
		}
		// noButtonClicked или другое — отказ
		pushToolResult(formatResponse.toolDenied())
		return false
	}
}
```

---

## 6. Исправленный поток с вмешательством пользователя

```
Parent Task (delegated)
  │
  └── Child Task (active)
        │
        ├── [Пользователь пишет сообщение в чат]
        │   → submitUserMessage() → handleWebviewAskResponse("messageResponse")
        │   → askResponse = "messageResponse" (устанавливается, но pWaitFor нет)
        │
        ├── [LLM генерирует ответ и вызывает attempt_completion]
        │
        ├── attempt_completion.execute()
        │   ├── say("completion_result", result, ...) — НЕ БЛОКИРУЕТ
        │   ├── parentTaskId check → delegation path
        │   ├── delegateToParent()
        │   │   ├── askFinishSubTaskApproval()
        │   │   │   ├── askApproval("tool", finishTask)
        │   │   │   │   ├── ask() → askResponse = undefined (очистка), askTs = T1
        │   │   │   │   └── pWaitFor ждёт ответа
        │   │   │   │
        │   │   │   └── [❗ ЕСЛИ пользователь пишет сообщение ЗДЕСЬ:]
        │   │   │       → handleWebviewAskResponse("messageResponse")
        │   │   │       → askResponse = "messageResponse"
        │   │   │       → pWaitFor выходит
        │   │   │       → response !== "yesButtonClicked"
        │   │   │       → ❌ askApproval возвращает false (denied!)
        │   │   │
        │   │   └── didApprove = false
        │   │       → pushToolResult(toolDenied())
        │   │       → return "denied"
        │   │
        │   └── delegation !== "continue" → return ❌
        │       → Parent НЕ возобновлён!
        │
        └── [РЕЗУЛЬТАТ: Parent остаётся в "delegated"]
```

---

## 7. Исправление: что НА САМОМ ДЕЛЕ нужно менять

### Первичный фикс: `askFinishSubTaskApproval` в `presentAssistantMessage.ts`

[`src/core/assistant-message/presentAssistantMessage.ts:531-538`](src/core/assistant-message/presentAssistantMessage.ts:531)

Добавить цикл повторного ask при `messageResponse`:

```typescript
const askFinishSubTaskApproval = async () => {
	const toolMessage = JSON.stringify({ tool: "finishTask" })
	while (true) {
		const didApprove = await askApproval("tool", toolMessage)
		if (didApprove) return true
		// Если пользователь отправил фидбек (messageResponse), а не отказался (noButtonClicked),
		// продолжаем цикл — спрашиваем снова
		// askApproval уже обработал фидбек через pushToolResult
		if (askApprovalWasDeniedDueToUserMessage) {
			continue // переспрашиваем
		}
		return false // реальный отказ
	}
}
```

**НО** это сложно, т.к. `askApproval` не различает `messageResponse` и `noButtonClicked`.

### Более простой фикс: изменить `askApproval`

[`src/core/assistant-message/presentAssistantMessage.ts:508-518`](src/core/assistant-message/presentAssistantMessage.ts:508)

Вместо:

```typescript
if (response !== "yesButtonClicked") {
	pushToolResult(formatResponse.toolDenied())
	return false
}
```

Сделать:

```typescript
if (response === "yesButtonClicked") {
	return true
}
// Для остальных ответов — ошибка/отказ
pushToolResult(formatResponse.toolError("Expected yes/no approval, got message response"))
return false
```

Но это всё равно не решает проблему — `askFinishSubTaskApproval` никак не обрабатывает отличие.

### Действительно правильный фикс:

Использовать отдельный тип ask для завершения подзадачи, который корректно обрабатывает `messageResponse` как "применить фидбек и продолжить":

[`src/core/task/Task.ts`](src/core/task/Task.ts) — добавить тип `"finish_subtask"` или аналогичный.

ИЛИ (проще): [`AttemptCompletionTool.ts:86-145`](src/core/tools/AttemptCompletionTool.ts:86) — вызывать `reopenParentFromDelegation` напрямую без `askFinishSubTaskApproval`, если статус подзадачи уже "active" и родитель ждёт:

```typescript
// Если подзадача active и родитель delegated — не спрашиваем подтверждения
// Пользователь уже мог подтвердить через ask("completion_result") или другим способом
if (parentHistory?.status === "delegated" && parentHistory?.awaitingChildId === task.taskId) {
    const didReopen = await provider.reopenParentFromDelegation({...})
    if (didReopen) {
        this.emitTaskCompleted(task)
        return
    }
}
```

Этот подход используется в Варианте A из отчёта, но **с другой мотивацией**: не "убрать двойное подтверждение" (которого нет), а "не спрашивать подтверждение, которое может быть перезаписано пользовательским сообщением".

---

## 8. Исправленный перечень файлов и строк

| Файл                                                                                                             | Строки    | Роль в баге                                                      |
| ---------------------------------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------- |
| [`src/core/tools/AttemptCompletionTool.ts`](src/core/tools/AttemptCompletionTool.ts)                             | 86-145    | Точка входа в делегацию; вызывает `delegateToParent`             |
| [`src/core/tools/AttemptCompletionTool.ts`](src/core/tools/AttemptCompletionTool.ts)                             | 171-201   | `delegateToParent` — вызывает `askFinishSubTaskApproval`         |
| [`src/core/assistant-message/presentAssistantMessage.ts`](src/core/assistant-message/presentAssistantMessage.ts) | 494-528   | `askApproval` — преобразует `messageResponse` в отказ            |
| [`src/core/assistant-message/presentAssistantMessage.ts`](src/core/assistant-message/presentAssistantMessage.ts) | 531-538   | `askFinishSubTaskApproval` — обёртка над `askApproval("tool")`   |
| [`src/core/task/Task.ts`](src/core/task/Task.ts)                                                                 | 1300-1333 | `pWaitFor` — ожидание ответа, проверка `lastMessageTs !== askTs` |
| [`src/core/task/Task.ts`](src/core/task/Task.ts)                                                                 | 1355-1401 | `handleWebviewAskResponse` — установка ответа                    |
| [`src/core/task/Task.ts`](src/core/task/Task.ts)                                                                 | 1439-1483 | `submitUserMessage` — отправка сообщения пользователя            |
| [`src/core/webview/webviewMessageHandler.ts`](src/core/webview/webviewMessageHandler.ts)                         | 654-661   | Маршрутизация `askResponse` от WebView в текущий Task            |
| [`src/core/webview/ClineProvider.ts`](src/core/webview/ClineProvider.ts)                                         | 3382-3619 | `reopenParentFromDelegation` — возобновление родителя            |
| [`src/core/webview/ClineProvider.ts`](src/core/webview/ClineProvider.ts)                                         | 3405-3411 | `status !== "delegated"` — защитная проверка                     |

---

## 9. Настоящая корневая причина

**`askFinishSubTaskApproval()` использует `askApproval("tool")`, который не различает "пользователь отправил сообщение" (messageResponse) и "пользователь явно отказался" (noButtonClicked).**

Когда пользователь пишет сообщение в чат во время ожидания подтверждения завершения подзадачи:

1. `handleWebviewAskResponse("messageResponse", text)` прерывает `pWaitFor`
2. `askApproval` получает `response = "messageResponse"`, а не `"yesButtonClicked"`
3. Это интерпретируется как отказ
4. `delegateToParent()` возвращает `"denied"`
5. `attempt_completion` выходит без возобновления родителя

**Отягчающий фактор:** Вся логика требует, чтобы пользователь нажал "Yes" на диалоге `askFinishSubTaskApproval`. Если пользователь не знаком с этим UI (или не видит его из-за других сообщений), он может написать текстовое сообщение, что приведёт к сбою делегации.

---

## 10. Заключение

Отчёт [`BUG-subtask-completion-flow.md`](OTCHETY/BUG-subtask-completion-flow.md) содержит полезный анализ архитектуры делегации и верно идентифицирует несколько проблем в коде. Однако **корневая причина определена неверно**: отчёт ошибочно предполагает, что `attempt_completion` вызывает `ask("completion_result")` (блокирующий) в делегационном пути, хотя на самом деле вызывается `say("completion_result")` (неблокирующий) с последующим `delegateToParent()` → `askFinishSubTaskApproval()` → `askApproval("tool")`.

**Вердикт: ⚠️ ЧАСТИЧНО КОРРЕКТЕН (PARTIALLY CORRECT).** Архитектурное понимание и многие детали верны, но ключевой вывод о коренной причине и рекомендации по фиксу основаны на неверной предпосылке.
