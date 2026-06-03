# Super Debug Logger — Руководство

## Что это

Супер-отладочный логгер для Zoo-Code, который пишет ВСЕ внутренние
коммуникации компонентов в лог-файлы в корне проекта.

## Лог-файлы

- `{cwd}/crt-debug.log` — только CRT-специфичные сообщения ([CALL], [SUCCESS|ERROR], [EXECUTE])
- `{cwd}/debug-log/zoo-debug.log` — ВСЕ системные логи (info, warn, error, console.\*)

## Как включить

### Способ 1: Переменная окружения (рекомендуется)

```bash
# При запуске VSCode
ZOO_DEBUG=1 code .
# Или в терминале перед запуском
export ZOO_DEBUG=1
```

### Способ 2: Настройка VSCode (TODO)

В будущем: `zoo-code.debug = true` в settings.json

### Способ 3: Программно (для разработчиков)

```typescript
import { initDebugLog, setDebugEnabled } from "./superDebug"
initDebugLog(task.cwd, true)
setDebugEnabled(false) // выключить на лету
```

## Как выключить

- Убрать `ZOO_DEBUG=1` из окружения
- Или вызвать `setDebugEnabled(false)`

## Компоненты и их контексты

| Контекст      | Компонент                  | Что логирует                                |
| ------------- | -------------------------- | ------------------------------------------- |
| BASE_TOOL     | BaseTool.ts                | CRT: CALL/SUCCESS/ERROR/EXECUTE             |
| CRT           | ref/index.ts               | resolveRef, multi_ref, inline refs          |
| SELECTOR      | selector.ts                | exact/normalized/fuzzy/anchor matching      |
| TRANSFORM     | transform.ts               | applyTransform pipeline                     |
| CHAT          | sources/chat.ts            | chat message resolution                     |
| FILE          | sources/file.ts            | file reading and matching                   |
| TERMINAL      | sources/terminal.ts        | terminal artifact resolution                |
| TOOL          | sources/tool.ts            | tool result resolution                      |
| PARSER        | NativeToolCallParser.ts    | tool call parsing (success, error, refMeta) |
| TASK          | Task.ts                    | task lifecycle (start, abort, dispose)      |
| TASK:STREAM   | Task.ts                    | streaming events and errors                 |
| PRESENT       | presentAssistantMessage.ts | message presentation                        |
| PROVIDER      | base-provider.ts           | tool schema conversion                      |
| CONSOLE:LOG   | Patched console.log        | все console.log вызовы в проекте            |
| CONSOLE:WARN  | Patched console.warn       | все console.warn вызовы                     |
| CONSOLE:ERROR | Patched console.error      | все console.error вызовы                    |

## Пример лога

```
[2026-06-03T12:30:00.000Z] [INFO] [BASE_TOOL] Tool "write_to_file" initiated
  {"refMeta":{"ref":{"source":"file","ref":"src/utils.ts","focus":"safeWriteJson"}}}

[2026-06-03T12:30:00.001Z] [CRT:SUCCESS] [BASE_TOOL] ref resolved
  {"source":"file:src/utils.ts","method":"exact","confidence":1.0,"contentLength":28}

[2026-06-03T12:30:00.002Z] [CRT:EXECUTE] [BASE_TOOL] write_to_file
  {"params":{"path":"test.ts","content":"async function safeWriteJson(...)"}}
```

## Архитектура

```
[Компонент] → superDebug.info/warn/error
                  ↓
      ┌──────────────────────────┐
      │  superDebug.ts           │
      │  ┌────────────────────┐  │
      │  │  crt-debug.log     │  │  — только CRT (в корне проекта)
      │  └────────────────────┘  │
      │  ┌────────────────────┐  │
      │  │  debug-log/        │  │  — ВСЕ логи (в корне проекта)
      │  │  zoo-debug.log     │  │
      │  └────────────────────┘  │
      │  ┌────────────────────┐  │
      │  │  console.* (patch)  │  │  — дублируется в zoo-debug.log
      │  └────────────────────┘  │
      └──────────────────────────┘
```

## Тестирование

Логгер не должен влиять на работу приложения:

- Если `ZOO_DEBUG` не установлен — логгер не инициализируется (0 overhead)
- При ошибке записи лога — тихий fallback (приложение не падает)
- `restoreConsole()` восстанавливает оригинальные console.\* (для тестов)
