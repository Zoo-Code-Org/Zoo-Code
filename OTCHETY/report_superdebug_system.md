# Отчёт: Инструментирование системных компонентов супер-логгером

**Дата:** 2026-06-03
**Версия:** 1.0

## Обзор

Добавлена централизованная отладка (superDebug-логгер) в 4 системных компонента Zoo-Code.
Модуль логгера: `src/core/tools/ref/superDebug.ts`

---

## 1. NativeToolCallParser.ts

**Файл:** `src/core/assistant-message/NativeToolCallParser.ts`
**Импорт:** `import { info, warn, error } from "../tools/ref/superDebug"`

| #   | Контекст | Уровень | Точка логирования                                           |
| --- | -------- | ------- | ----------------------------------------------------------- |
| 1   | PARSER   | `info`  | `createPartialToolUse()` — частичный tool use при стриминге |
| 2   | PARSER   | `warn`  | `processStreamingChunk()` — ошибка парсинга partial JSON    |
| 3   | PARSER   | `warn`  | `parseToolCall()` — невалидное имя инструмента              |
| 4   | PARSER   | `info`  | `parseToolCall()` — refMeta обнаружен                       |
| 5   | PARSER   | `info`  | `parseToolCall()` — успешный парсинг tool call              |
| 6   | PARSER   | `error` | `parseToolCall()` — ошибка парсинга (catch)                 |
| 7   | PARSER   | `error` | `parseDynamicMcpTool()` — ошибка парсинга MCP (catch)       |

---

## 2. Task.ts

**Файл:** `src/core/task/Task.ts`
**Импорт:** `import { info, warn, error, initDebugLog } from "../tools/ref/superDebug"`

| #   | Контекст    | Уровень        | Точка логирования                                    |
| --- | ----------- | -------------- | ---------------------------------------------------- |
| 1   | TASK        | `initDebugLog` | `startTask()` — инициализация логгера                |
| 2   | TASK        | `info`         | `startTask()` — задача запущена                      |
| 3   | TASK        | `warn`         | `abortTask()` — задача прервана                      |
| 4   | TASK        | `info`         | `dispose()` — задача уничтожена                      |
| 5   | TASK:STREAM | `info`         | `recursivelyMakeClineRequests()` — стрим запущен     |
| 6   | TASK:STREAM | `error`        | `recursivelyMakeClineRequests()` — ошибка стрима     |
| 7   | TASK        | `warn`         | `attemptApiRequest()` — превышение контекстного окна |
| 8   | TASK        | `info`         | `recursivelyMakeClineRequests()` — retry с историей  |

---

## 3. presentAssistantMessage.ts

**Файл:** `src/core/assistant-message/presentAssistantMessage.ts`
**Импорт:** `import { info, warn, error } from "../tools/ref/superDebug"`

| #   | Контекст | Уровень | Точка логирования                                   |
| --- | -------- | ------- | --------------------------------------------------- |
| 1   | PRESENT  | `info`  | Вход в функцию `presentAssistantMessage()`          |
| 2   | PRESENT  | `error` | Блок try-catch клонирования block                   |
| 3   | PRESENT  | `info`  | Перед `switch (block.name)` при обработке tool call |
| 4   | PRESENT  | `info`  | После успешного сохранения checkpoint               |
| 5   | PRESENT  | `error` | Ошибка сохранения checkpoint                        |

---

## 4. base-provider.ts

**Файл:** `src/api/providers/base-provider.ts`
**Импорт:** `import { info, warn, error } from "../../core/tools/ref/superDebug"`

| #   | Контекст | Уровень | Точка логирования                     |
| --- | -------- | ------- | ------------------------------------- |
| 1   | PROVIDER | `info`  | Вход в `convertToolSchemaForOpenAI()` |
| 2   | PROVIDER | `info`  | Сохранение CRT-параметров (required)  |
| 3   | PROVIDER | `error` | Ошибка конвертации схемы (try-catch)  |

---

## Проверка TypeScript

Все 4 файла прошли проверку `cd src && npx tsc --noEmit` без новых ошибок.
Существующие ошибки (в `selector.ts`, `BaseTool.ts`) не связаны с инструментированием.

## Git Status

```diff
 M src/api/providers/base-provider.ts
 M src/core/assistant-message/NativeToolCallParser.ts
 M src/core/assistant-message/presentAssistantMessage.ts
 M src/core/task/Task.ts
```

## Итог

- **Файлов инструментировано:** 4
- **Точек логирования добавлено:** 23
- **Новых ошибок TypeScript:** 0
- **Изменений логики:** 0 (только добавление логирования)
