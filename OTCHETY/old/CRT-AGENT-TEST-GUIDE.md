# CRT (Content Reference Tool) — Инструкция по агентному тестированию

## Что это

CRT — механизм цитирования контента внутри AI-агента. Позволяет мне (агенту) ссылаться на существующий в контексте контент через параметры `ref`/`multi_ref`/`transform` вместо повторной генерации или повторного чтения файлов.

## Структура модуля

```
src/core/tools/ref/
├── index.ts          # resolveRef() — оркестратор
├── selector.ts       # Selector Engine (4 стадии поиска)
├── transform.ts      # Transform Engine (replace→prepend→wrap→append)
└── sources/
    ├── chat.ts       # Цитирование из assistantMessageContent
    ├── file.ts       # Цитирование из файлов на диске
    ├── terminal.ts   # Цитирование из command-output артефактов
    └── tool.ts       # Цитирование из tool_result блоков
```

## План тестирования (выполнять последовательно)

### Фаза 1: chat source — цитирование из моих же сообщений

Я отправляю длинное сообщение с уникальным содержанием, затем в СЛЕДУЮЩЕМ tool call'е
цитирую его через `ref` вместо повторения.

#### Тест 1.1: exact selector (< 60 символов)

```
Шаг 1: ответить текстом "UNIQUE_MARKER_START function helloWorld() { return 'hi'; } UNIQUE_MARKER_END"
Шаг 2: в execute_command использовать:
  execute_command(ref={source:"chat", ref:"-1", selector:"function helloWorld() { return 'hi'; }"})
Ожидание: команда выполнится с content = "function helloWorld() { return 'hi'; }"
```

#### Тест 1.2: anchor pair (> 60 символов)

```
Шаг 1: отправить многострочный код (например, функцию из 10+ строк)
Шаг 2: в write_to_file использовать:
  write_to_file(path="test-output.ts",
    ref={source:"chat", ref:"-1",
      startAnchor:"function bigFunction(",
      endAnchor:"}"})
Ожидание: файл создастся с содержимым между startAnchor и endAnchor
```

#### Тест 1.3: normalized match (разные пробелы/регистр)

```
Шаг 1: отправить "const   API_URL   =   'https://example.com'"
Шаг 2: в execute_command использовать:
  execute_command(ref={source:"chat", ref:"-1", selector:"const api_url = 'https://example.com'"})
Ожидание: matched через normalized stage (confidence 0.9)
```

#### Тест 1.4: fuzzy match (опечатка)

```
Шаг 1: отправить "The quick brown fox jumps over the lazy dog"
Шаг 2: в apply_diff использовать ref с опечаткой:
  apply_diff(path="test.txt",
    ref={source:"chat", ref:"-1", selector:"The quick brwn fox jumps over the lazy doG", ...})
Ожидание: matched через fuzzy stage (confidence 0.7)
```

### Фаза 2: multi_ref — комбинирование из нескольких источников

#### Тест 2.1: multi_ref + join_with

```
Шаг 1: отправить 3 разных фрагмента
Шаг 2: в write_to_file использовать:
  write_to_file(path="combined.txt",
    multi_ref=[
      {source:"chat", ref:"-1", selector:"фрагмент1"},
      {source:"chat", ref:"-2", selector:"фрагмент2"},
      {source:"chat", ref:"-3", selector:"фрагмент3"}
    ],
    transform={join_with:"\n---\n"})
Ожидание: файл содержит 3 фрагмента через "---"
```

#### Тест 2.2: multi_ref + полный transform pipeline

```
Шаг 1: отправить фрагмент кода
Шаг 2: в execute_command использовать:
  execute_command(multi_ref=[{source:"chat", ref:"-1", selector:"npm run"}],
    transform={
      replace:{from:"run", to:"test"},
      prepend:"echo 'STARTING' && ",
      wrap_with:"echo {content}",
      append:" && echo 'DONE'"
    })
Ожидание: команда = "echo 'STARTING' && echo npm test && echo 'DONE'"
```

### Фаза 3: file source — цитирование из файлов

#### Тест 3.1: читать файл через ref

```
Шаг 1: сначала read_file на существующий файл (чтобы он появился в контексте)
Шаг 2: потом execute_command с ref на этот файл:
  execute_command(ref={source:"file", ref:"src/package.json", selector:"\"version\""})
Ожидание: команда выполнится со строкой version из package.json
```

#### Тест 3.2: line range из файла

```
Шаг 1: read_file на существующий файл
Шаг 2: apply_diff с ref на строки:
  apply_diff(path="new-file.ts",
    ref={source:"file", ref:"src/existing.ts", startLine:1, endLine:5})
Ожидание: diff применится с первыми 5 строками файла
```

### Фаза 4: terminal source — цитирование из command-output

#### Тест 4.1: цитирование результата команды

```
Шаг 1: execute_command("echo 'UNIQUE_TEST_OUTPUT_12345'")
Шаг 2: execute_command(ref={source:"terminal", ref:"cmd-xxx.txt", selector:"UNIQUE_TEST_OUTPUT"})
  (где cmd-xxx.txt — артефакт из шага 1)
Ожидание: выполнит команду с output предыдущей команды
```

#### Тест 4.2: content fingerprint matching

```
Шаг 1: execute_command("npm test")
Шаг 2: execute_command(ref={source:"terminal", ref:"",
  startAnchor:"npm test"})
Ожидание: найдёт команду по startAnchor без указания artifact_id
```

### Фаза 5: tool source — цитирование результатов инструментов

#### Тест 5.1: цитирование read_file результата

```
Шаг 1: read_file("src/package.json")
Шаг 2: write_to_file(path="copy.json",
  ref={source:"tool", ref:"read_file", selector:"\"version\""})
Ожидание: создаст copy.json с содержимым из tool результата
```

### Фаза 6: graceful fallback

#### Тест 6.1: ref не найден → fallback к оригинальным параметрам

```
Если ref указывает на несуществующий контент, инструмент выполняется
с оригинальными параметрами без ошибки.
```

### Фаза 7: MCP inline refs ({{ref:...}})

#### Тест 7.1: inline ref в MCP tool

```
В аргументах MCP инструмента можно использовать {{ref:source=chat,ref=-1,selector=...}}
— маркер будет заменён на content.
```

## Критерии успеха

- [ ] exact selector находит точное совпадение (confidence 1.0)
- [ ] anchor pair находит диапазон между двумя якорями
- [ ] normalized match находит несмотря на пробелы/регистр (confidence 0.9)
- [ ] fuzzy match находит несмотря на опечатки (confidence 0.7)
- [ ] multi_ref комбинирует из нескольких источников
- [ ] transform pipeline работает в правильном порядке
- [ ] file source читает и находит контент
- [ ] terminal source находит artifact
- [ ] tool source находит tool_result
- [ ] graceful fallback не ломает выполнение
- [ ] ни одна команда не завершается ошибкой из-за CRT

## Важные заметки

1. **Порядок важен** — ref ссылается на `-1` (последнее сообщение), `-2` (предпоследнее) и т.д.
2. **После каждого теста** — проверять что контент подставился корректно
3. **source:"chat"** — `ref` это отрицательный индекс: `-1` = последнее assistant сообщение
4. **source:"file"** — `ref` это относительный путь от cwd
5. **source:"terminal"** — `ref` это имя artifact файла (`cmd-*.txt`)
6. **source:"tool"** — `ref` это имя инструмента (`read_file`, `execute_command` и т.д.)
