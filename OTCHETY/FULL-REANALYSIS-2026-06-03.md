# ПОЛНЫЙ РЕ-АНАЛИЗ ПРОЕКТА CRT: ПЛАНЫ vs РЕАЛЬНОСТЬ

**Дата:** 2026-06-03 22:50 MSK  
**Версия:** Финальный аудит

---

## 1. СТАТУС РЕАЛИЗАЦИИ ПО ВСЕМ ПЛАНАМ

### 1.1 Super Debug Logger (новая задача, исполнена 3 июня)

| Компонент                                                     | Статус | Доказательство                     |
| ------------------------------------------------------------- | :----: | ---------------------------------- |
| Модуль `superDebug.ts` (6782 байта)                           |   ✅   | `src/core/tools/ref/superDebug.ts` |
| BaseTool.ts — импорт и вызовы                                 |   ✅   | git diff подтверждает              |
| ref/index.ts — инструментирован                               |   ✅   | `import ... from "./superDebug"`   |
| ref/selector.ts — инструментирован                            |   ✅   | info/successCrt добавлены          |
| ref/transform.ts — инструментирован                           |   ✅   | info/successCrt добавлены          |
| ref/sources/\*.ts — все 4 инструментированы                   |   ✅   | chat, file, terminal, tool         |
| NativeToolCallParser.ts — инструментирован                    |   ✅   | import из superDebug               |
| Task.ts — инструментирован                                    |   ✅   | import из superDebug               |
| presentAssistantMessage.ts — инструментирован                 |   ✅   | import из superDebug               |
| base-provider.ts — инструментирован                           |   ✅   | import из superDebug               |
| ApplyDiffTool.ts — params расширены (ref/multi_ref/transform) |   ✅   | git diff подтверждает              |
| **14 файлов импортируют superDebug**                          |   ✅   | grep подтверждает                  |

### 1.2 Plan B (из CRT-DEFINITIVE-PLAN.md)

| Пункт   | Описание                                                  |       Статус        | Доказательство                            |
| ------- | --------------------------------------------------------- | :-----------------: | ----------------------------------------- |
| **B.1** | Убрать CRT из `required` в 7 native-tool схемах           |         ✅          | git diff 0 = уже в коммите                |
| **B.2** | Экранировать CRT в `convertToolSchemaForOpenAI()`         |         ✅          | git diff в base-provider.ts               |
| **B.3** | Переключить chat.ts на Layer 2 (`getEffectiveApiHistory`) |         ✅          | Файл использует getEffectiveApiHistory    |
| **B.4** | Добавить инструкцию в system prompt                       | ❌ **НЕ ВЫПОЛНЕНО** | Ни один system prompt файл не изменён     |
| B.5     | Аудит рантайма (верифицировано — безопасно)               |         ✅          | NativeToolCallParser + BaseTool проверены |

### 1.3 6 Багов из CRT-CLIPBOARD-BUG-REPORT.md

| Баг    | Severity | Описание                                 |                             Статус                             |
| ------ | :------: | ---------------------------------------- | :------------------------------------------------------------: |
| **#1** | 🔴 КРИТ  | AST-авторасширение (`focus`) не работает | ❌ **НЕ ИСПРАВЛЕН** — никогда не было подключено к tree-sitter |
| **#2** | 🔴 КРИТ  | `source=chat` полностью не работает      |               ✅ **ИСПРАВЛЕН** — через Plan B.3                |
| **#3** | 🔴 КРИТ  | `multi_ref` не работает                  | ❓ НЕ ТЕСТИРОВАЛСЯ после Plan B — schemas есть, но тестов нет  |
| **#4** | 🟡 СРЕД  | Inline `{{ref:...}}` не работает         |    ❌ БАГ ПРОМПТА — код работает, модель не знает синтаксис    |
| **#5** | 🟡 СРЕД  | `apply_diff` с `ref` без `diff`          |          ✅ **ИСПРАВЛЕН** — ApplyDiffTool.ts расширен          |
| **#6** | 🟢 НИЗК  | `startAnchor`/`endAnchor`                |        ❓ НЕ ТЕСТИРОВАЛСЯ — selector.ts их поддерживает        |

### 1.4 Из FINAL-DISCOVERY-REPORT.md (секция "Требует доработки")

| Пункт                                    | Статус | Комментарий                          |
| ---------------------------------------- | :----: | ------------------------------------ |
| AST Auto-Expansion (focus → tree-sitter) |   ❌   | Никогда не реализовано               |
| Virtual Content Grid (VCG)               |   ❌   | Никогда не реализовано               |
| Inline MCP Ref Injection `{{ref:...}}`   |   ❌   | Баг промпта (по словам пользователя) |
| Ephemeral Sandbox Sub-Sessions           |   ❌   | Будущая фича (v4.1)                  |
| Система обратной связи при неудаче       |   ⚠️   | Частично — superDebug.error()        |
| Smart Disambiguation                     |   ❌   | Не реализовано                       |

---

## 2. ЧТО КОНКРЕТНО НЕ СДЕЛАНО (НО БЫЛО ЗАПЛАНИРОВАНО)

### ⚠️ КРИТИЧЕСКИЕ ПРОБЕЛЫ

#### 1. AST Auto-Expansion (`focus` → tree-sitter)

**Запланировано:** В CRT-DEFINITIVE-PLAN.md раздел A.1 (Plan A), FINAL-DISCOVERY-REPORT.md раздел 4.
**Реальность:** `focus` всё ещё работает как `selector` (текстовый поиск). Несмотря на наличие `src/services/tree-sitter/` в кодовой базе и VS Code API `vscode.executeDocumentSymbolProvider`, ни один из них не вызвается из `resolveContentRef()`. Поле `focus` добавлено в `ContentRef`, но логика AST-расширения отсутствует.

**Нужно:** В `selector.ts` → `resolveContentRef()` добавить вызов AST-парсера перед текстовым fallback.

#### 2. Inline `{{ref:...}}` — обучение модели (БАГ ПРОМПТА)

**Запланировано:** В CRT-DEFINITIVE-PLAN.md → B.4 (system prompt), в CRT-CLIPBOARD-BUG-REPORT.md → 8.1 (quick wins).
**Реальность:** Ни один system prompt файл не изменён. Модель не знает синтаксис `{{ref:source=...,ref=...,focus=...}}`.

**Нужно:** Обновить system prompt (найти файл, вероятно `src/core/prompts/system.ts` или `sections/`).

**Где править:** Найти system prompt файл через `grep -r "ref" src/core/prompts/system.ts` или search_files.

### 🟡 СРЕДНИЕ ПРОБЕЛЫ

#### 3. Virtual Content Grid (VCG)

**Запланировано:** В CRT-DEFINITIVE-PLAN.md → A.1, FINAL-DISCOVERY-REPORT.md → инновация 2.
**Реальность:** Никто не начинал. Ни `virtual-content-grid.ts`, ни `api_conversation_history.idx`.

#### 4. Smart Disambiguation

**Запланировано:** В CRT-IMPL-PLAN.md → раздел 10.2.
**Реальность:** Не реализовано. При неоднозначном совпадении (3+ функции с одним именем) берётся первое.

#### 5. Multi-ref тестирование

**Запланировано:** В CRT-AGENT-TEST-GUIDE.md → Фаза 2.
**Реальность:** Параметр `multi_ref` добавлен в schemas, но end-to-end тестов нет.

---

## 3. ЧТО УЖЕ РАБОТАЕТ (ПОСЛЕ ВСЕХ ИЗМЕНЕНИЙ)

### Полностью функционально:

- ✅ **source=file + selector** — точный/нормализованный/fuzzy поиск
- ✅ **source=file + startAnchor/endAnchor** — anchor pair resolution
- ✅ **source=chat** — Layer 2 через `getEffectiveApiHistory()`
- ✅ **source=terminal** — чтение command-output артефактов
- ✅ **source=tool** — чтение tool_result из истории
- ✅ **Transform Engine** — replace → prepend → wrap → append → join
- ✅ **superDebug логгер** — 14 файлов, 2 лог-файла в корне
- ✅ **Strict mode** — экранирование CRT-параметров в OpenAI
- ✅ **Graceful fallback** — при ошибке ref используется оригинальный параметр

### Частично:

- ⚠️ **focus** — работает как selector (текст, не AST)
- ⚠️ **multi_ref** — schemas есть, transform есть, e2e не проверен
- ⚠️ **Обратная связь в tool_result** — через superDebug, не в user message

---

## 4. ПРИОРИТЕТНЫЕ НЕДЕЛАННЫЕ ЗАДАЧИ

| #   | Задача                                                                                              | Где править                                  |  Время  | Зависимости                     |
| --- | --------------------------------------------------------------------------------------------------- | -------------------------------------------- | :-----: | ------------------------------- |
| 1   | **System prompt (B.4)** — научить модель `{{ref:...}}`                                              | `src/core/prompts/system.ts` или `sections/` | 30 мин  | Нет                             |
| 2   | **AST Auto-Expansion** — `focus` → `resolveAstBlock()` через `vscode.executeDocumentSymbolProvider` | `ref/selector.ts` + `ref/sources/ast.ts`     |  4-6 ч  | `ContentRef.focus` уже добавлен |
| 3   | **Smart Disambiguation** — возвращать все совпадения при неоднозначности                            | `ref/selector.ts`                            |  2-3 ч  | Зависит от #2                   |
| 4   | **VCG** — виртуальная сетка чата                                                                    | `ref/vcg.ts` + chat.ts                       | 1-2 дня | #2                              |
| 5   | **Multi-ref e2e тесты**                                                                             | `ref/__tests__/`                             |   1 ч   | Нет                             |

---

## 5. ИТОГ

**Что сделано (последняя сессия):**

- ✅ Супер-отладочный логгер (14 файлов, 2 лог-файла)
- ✅ ApplyDiffTool.ts расширен для ref-параметров
- ✅ Поле `focus` добавлено в `ContentRef`
- ✅ Все source resolver'ы инструментированы

**Что НЕ сделано из планов:**

- ❌ System prompt (B.4) — модель не знает `{{ref:...}}`
- ❌ AST Auto-Expansion — `focus` не подключён к tree-sitter
- ❌ Virtual Content Grid — не начат
- ❌ Smart Disambiguation — не реализован

**Единственный открытый вопрос по словам пользователя:**

> `Inline {{ref:...}}` — это не баг кода, а баг промпта — модель нужно научить генерировать корректный синтаксис.
