# КРИТИКА: Изменение B.1 — Удаление ref/multi_ref/transform из required

**Статус: ⚠️ ISSUES FOUND (АППРОВАЛ С ОГОВОРКАМИ)**

> **Дата проверки**: 2026-06-02  
> **Анализатор**: 🧠 Research Analyst Elite  
> **Объём проверки**: 7 файлов, 7 провайдеров API, 5 точек конвертации схем

---

## 1. Пофайловый разбор

### 1.1 `execute_command.ts` (строка 90)

| Аспект                     | Статус                                                           |
| -------------------------- | ---------------------------------------------------------------- |
| `required` до              | `["command", "cwd", "timeout", "ref", "multi_ref", "transform"]` |
| `required` после           | `["command", "cwd", "timeout"]`                                  |
| `ref` в `properties`       | ✅ Сохранён (стр. 49–64)                                         |
| `multi_ref` в `properties` | ✅ Сохранён (стр. 65–68)                                         |
| `transform` в `properties` | ✅ Сохранён (стр. 69–88)                                         |
| `strict: true`             | ⚠️ Установлен (стр. 33) — см. раздел 4                           |

### 1.2 `write_to_file.ts` (строка 76)

| Аспект                                   | Статус                                                 |
| ---------------------------------------- | ------------------------------------------------------ |
| `required` до                            | `["path", "content", "ref", "multi_ref", "transform"]` |
| `required` после                         | `["path", "content"]`                                  |
| `ref/multi_ref/transform` в `properties` | ✅ Сохранены                                           |
| `strict: true`                           | ⚠️ Установлен (стр. 23) — см. раздел 4                 |

### 1.3 `apply_diff.ts` (строка 71)

| Аспект                                   | Статус                                              |
| ---------------------------------------- | --------------------------------------------------- |
| `required` до                            | `["path", "diff", "ref", "multi_ref", "transform"]` |
| `required` после                         | `["path", "diff"]`                                  |
| `ref/multi_ref/transform` в `properties` | ✅ Сохранены                                        |

### 1.4 `edit.ts` (строка 82)

| Аспект                                   | Статус                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| `required` до                            | `["file_path", "old_string", "new_string", "ref", "multi_ref", "transform"]` |
| `required` после                         | `["file_path", "old_string", "new_string"]`                                  |
| `ref/multi_ref/transform` в `properties` | ✅ Сохранены                                                                 |

### 1.5 `search_replace.ts` (строка 85)

| Аспект                                   | Статус                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| `required` до                            | `["file_path", "old_string", "new_string", "ref", "multi_ref", "transform"]` |
| `required` после                         | `["file_path", "old_string", "new_string"]`                                  |
| `ref/multi_ref/transform` в `properties` | ✅ Сохранены                                                                 |

### 1.6 `edit_file.ts` (строка 106)

| Аспект                                   | Статус                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| `required` до                            | `["file_path", "old_string", "new_string", "ref", "multi_ref", "transform"]` |
| `required` после                         | `["file_path", "old_string", "new_string"]`                                  |
| `ref/multi_ref/transform` в `properties` | ✅ Сохранены                                                                 |

### 1.7 `apply_patch.ts` (строка 95)

| Аспект                                   | Статус                                       |
| ---------------------------------------- | -------------------------------------------- |
| `required` до                            | `["patch", "ref", "multi_ref", "transform"]` |
| `required` после                         | `["patch"]`                                  |
| `ref/multi_ref/transform` в `properties` | ✅ Сохранены                                 |

---

## 2. Проверка на TypeScript

**Результат**: ✅ УСПЕШНО (exit code 0)

```
cd src && npx tsc --noEmit
```

Типизация `satisfies OpenAI.Chat.ChatCompletionTool` не нарушена, т.к. `required` в типе `OpenAI.Chat.ChatCompletionTool` опционален.

---

## 3. Анализ влияния на провайдеры API (RUNTIME PATH)

Принципиально важно: source-схемы **не отправляются напрямую** ни в один API. Все провайдеры трансформируют их перед отправкой. Ниже — детальный анализ.

### 3.1 Провайдеры, перезаписывающие `required` ✅ SAFE

#### openai-native.ts

```typescript
ensureAllRequired(schema) {
    // ...
    result.required = Object.keys(result.properties) // ← перезапись
    // ...
}
// Вызов:
parameters: isMcp
    ? ensureAdditionalPropertiesFalse(tool.function.parameters)
    : ensureAllRequired(tool.function.parameters), // ← native tools сюда
strict: !isMcp,  // ← true для native tools
```

**Источник**: `src/api/providers/openai-native.ts` (стр. 235–269, 389)  
**Вывод**: ✅ Изменение не влияет — `required` перезаписывается всеми ключами `properties`

#### openai-codex.ts

Аналогичная функция `ensureAllRequired` (стр. 223–253), поведение идентично.  
**Вывод**: ✅ Изменение не влияет

#### base-provider.ts → convertToolSchemaForOpenAI()

```typescript
if (result.properties) {
	const allKeys = Object.keys(result.properties)
	result.required = allKeys // ← перезапись
}
```

**Источник**: `src/api/providers/base-provider.ts` (стр. 63–106)  
**Вызов**: xai.ts, и все классы, наследующие `BaseProvider` и использующие `convertToolsForOpenAI()`  
**Вывод**: ✅ Изменение не влияет

### 3.2 Провайдеры, использующие normalizeToolSchema() ✅ SAFE

#### normalizeToolSchema() (json-schema.ts, стр. 294–304)

```typescript
// NormalizedToolSchemaInternal.transform() (стр. 202-211):
if (properties) {
	result.properties = properties
	if (required) {
		const propertyKeys = Object.keys(properties)
		const filteredRequired = required.filter((key) => propertyKeys.includes(key))
		if (filteredRequired.length > 0) {
			result.required = filteredRequired
		}
	}
}
```

**Характер**: Сохраняет существующий `required`, НЕ добавляет туда все `properties`.  
**Используется в**: Bedrock (через `normalizeToolSchema`), VSCode LM (через `normalizeToolSchema`)
**Вывод**: ✅ Изменение безопасно — `normalizeToolSchema` не требует всех полей в `required`

### 3.3 Провайдеры, передающие схемы напрямую ✅ SAFE

#### Anthropic (convertOpenAIToolToAnthropic)

```typescript
input_schema: tool.function.parameters as Anthropic.Tool.InputSchema
```

**Источник**: `src/core/prompts/tools/native-tools/converters.ts` (стр. 37)  
**Характер**: Anthropic не имеет strict mode, `required` опционален.  
**Используется в**: AnthropicHandler, AnthropicVertexHandler, MiniMaxHandler  
**Вывод**: ✅ Изменение безопасно

#### Gemini (sanitizeSchemaForGemini)

```typescript
// Сохраняет required как есть, с мержем allOf
result.required = [...existing, ...value.filter(...)]
```

**Источник**: `src/api/providers/gemini.ts` (стр. 147–153)  
**Характер**: Gemini не навязывает strict mode.  
**Вывод**: ✅ Изменение безопасно

#### Mistral (convertToolsForMistral)

```typescript
parameters: (tool.function.parameters as Record<string, unknown>) || {}
```

**Источник**: `src/api/providers/mistral.ts` (стр. 180)  
**Вывод**: ✅ Изменение безопасно

#### Ollama (convertToolsToOllama)

**Вывод**: ✅ Изменение безопасно (проверено по тестам)

---

## 4. Проблемы с `strict: true` в source-схемах

### ⚠️ Проблема: Несоответствие strict mode семантике

Два файла имеют `strict: true` в исходном коде:

- `execute_command.ts` (стр. 33)
- `write_to_file.ts` (стр. 23)

Согласно **OpenAI документации** (Context7 + официальный источник):

> "All fields in properties must be marked as required" — при `strict: true`

Это контринтуитивно, но **фактически проблема де-факто не существует**, потому что:

1. `openai-native.ts` и `openai-codex.ts` вызывают `ensureAllRequired()`, который **перезаписывает** `required = Object.keys(properties)` в runtime
2. `base-provider.ts` делает то же через `convertToolSchemaForOpenAI()`
3. У провайдеров, не использующих strict mode (Anthropic, Bedrock, Gemini и т.д.), `strict: true` в source-схеме **игнорируется**

### ⚠️ Риск: Косметический обман

Если другой разработчик (или агент) прочитает `execute_command.ts` и подумает "эта схема идёт напрямую в OpenAI с `strict: true`" — это введёт в заблуждение. Source-схема семантически неправильна для strict mode.

**Рекомендация**: Удалить `strict: true` из source-схем `execute_command.ts` и `write_to_file.ts`, перенеся ответственность за strict mode в провайдеры, где это и происходит.

---

## 5. Риски изменения B.1

| Риск                                    | Серьёзность | Вероятность  | Описание                                                                                                                         |
| --------------------------------------- | ----------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| **R1**: Несоответствие strict mode spec | Низкая      | Низкая       | strict: true требует все properties в required. Runtime-митигация через ensureAllRequired                                        |
| **R2**: Прямая отправка схем в OpenAI   | Высокая     | Очень низкая | Сейчас ни один провайдер не шлёт source-схемы напрямую. Всё трансформируется                                                     |
| **R3**: Gemini баг                      | Низкая      | Низкая       | `sanitizeSchemaForGemini` мержит required из allOf; без allOf проблем нет                                                        |
| **R4**: Bedrock/VSCode LM               | Низкая      | Низкая       | `normalizeToolSchema` корректно обрабатывает partially-filled required                                                           |
| **R5**: Будущий провайдер               | Средняя     | Низкая       | Если новый провайдер будет брать source-схему напрямую, ref/multi_ref/transform станут необязательными — что **и было задумано** |

---

## 6. Рекомендации

### Обязательно

1. **Убрать `strict: true`** из `execute_command.ts` и `write_to_file.ts` — это source-схемы, а не API-пейлоады. Strict mode должен устанавливаться только в провайдерах.

### Опционально

2. **Тесты**: Добавить тест для `normalizeToolSchema()`, проверяющий, что удаление ключей из `required` корректно обрабатывается
3. **Документация**: Добавить comment в заголовок каждого файла: `// Source schema — runtime transform applied by providers`

---

## 7. Источники

| Источник                          | URL / Файл                                                                                                | Суть                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| OpenAI Strict Mode                | [Context7](https://developers.openai.com/api/docs/guides/function-calling) (через MCP)                    | "All fields in properties must be marked as required" |
| OpenAI Community                  | [Strict=True and Required Fields](https://community.openai.com/t/strict-true-and-required-fields/1131075) | Подтверждает требование                               |
| OpenAI Tool JSON Schema Explained | [Medium](https://medium.com/@laurentkubaski/openai-tool-schema-explained-05a5ce0e80f8)                    | Strict mode требует все поля в required               |
| `ensureAllRequired()`             | `src/api/providers/openai-native.ts:235`                                                                  | Runtime-защита: перезаписывает required               |
| `ensureAllRequired()`             | `src/api/providers/openai-codex.ts:223`                                                                   | Runtime-защита: перезаписывает required               |
| `convertToolSchemaForOpenAI()`    | `src/api/providers/base-provider.ts:63`                                                                   | Runtime-защита: перезаписывает required               |
| `normalizeToolSchema()`           | `src/utils/json-schema.ts:294`                                                                            | Сохраняет required как есть                           |
| `convertOpenAIToolToAnthropic()`  | `src/core/prompts/tools/native-tools/converters.ts:28`                                                    | Передаёт параметры без трансформации required         |

---

## 8. Итоговый вердикт

**Статус: ⚠️ ISSUES FOUND**

Изменение **безопасно в runtime** благодаря слою трансформации во всех провайдерах. Однако `strict: true` в source-схемах `execute_command.ts` и `write_to_file.ts` теперь **дезинформирует** — он конфликтует с удалёнными полями из `required`. Рекомендуется удалить `strict: true` из source-схем.

### Score

- **Корректность изменений**: 10/10 (все реф/мульти_реф/трансформ корректно убраны)
- **Runtime безопасность**: 9/10 (митигировано всеми провайдерами)
- **Чистота кода**: 6/10 (strict: true вводит в заблуждение)
- **Общая оценка**: ✅ APPROVED с одной рекомендацией по strict: true
