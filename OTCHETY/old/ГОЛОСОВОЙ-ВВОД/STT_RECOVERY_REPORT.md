# ОТЧЕТ ПО ВОССТАНОВЛЕНИЮ МОДИФИКАЦИИ SPEECH-TO-TEXT (STT)

**Дата создания отчета:** 01.05.2026
**Статус:** Восстановлено из истории git (коммит `f33d9ba`)

Ру сказал
Отлично! Мы нашли конкретную реализацию. Судя по снимку страницы коммита f33d9ba, это полноценный PR с кодом, а не просто предложение.

Что мы видим в коде (из снимка):

src/services/stt/SttService.ts — основной сервис для Speech-to-Text (Singleton паттерн, работа с AssemblyAI через WebSocket, управление токенами).
src/services/stt/capture-server.ts — локальный сервер для захвата аудио.
src/services/stt/capture-page.html — HTML страница для записи через браузер.
webview-ui/src/components/chat/ChatTextArea.tsx — интеграция кнопки микрофона в чат.
webview-ui/src/components/settings/SttSettings.tsx — UI настроек для STT.
src/shared/WebviewMessage.ts и ExtensionMessage.ts — типы сообщений для связи WebView и Extension.
Как это притянуть в локальный репозиторий:

Поскольку мы нашли ссылку на ветку feature/stt-dictation (элемент 1131 в снимке) и roomote-v0, попробуем выполнить git fetch для этих веток.

---

## 1. ИСТОЧНИК И ПРЕДЫСТОРИЯ

### Откуда притянуто:

- **GitHub Issue:** [#8852](https://github.com/RooCodeInc/Roo-Code/issues/8852) — "[ENHANCEMENT] Speech-to-Text Dictation for Chat"
- **Автор:** `hannesrudolph` (через аккаунт `roomote` / `Roo Code Team`)
- **Исходная ветка:** `feature/stt-dictation` (на момент отчета удалена с GitHub)
- **Коммит:** `f33d9ba2b` (сообщение: "feat: Add Speech-to-Text dictation capability (WIP)")
- **Дата коммита:** 26 октября 2025 года

### Контекст задачи:

Пользователи хотели диктовать сообщения в чат Roo Code вместо печати. Основная проблема заключалась в том, что WebView в VS Code — это песочница (sandbox), которая не дает прямой доступ к микрофону через `getUserMedia`. Решение было найдено через использование внешнего браузера и WebSocket-стриминга.

---

## 2. ЧТО БЫЛО РЕАЛИЗОВАНО (СОСТАВ ИЗМЕНЕНИЙ)

В коммите `f33d9ba` было изменено **14 файлов**, добавлено **1374 строки** кода.

### А. Основные сервисы (Backend)

1.  **`src/services/stt/SttService.ts`** (176 строк)

    - Синглтон-сервис для управления STT.
    - Поддержка провайдеров: `assemblyai` и `openai-whisper`.
    - Генерация временных токенов для безопасного доступа (чтобы не светить API ключи в браузере).
    - Интеграция с `capture-server`.

2.  **`src/services/stt/capture-server.ts`** (92 строки)

    - Локальный HTTP-сервер на Node.js.
    - Отдает HTML-страницу захвата и обрабатывает коллбэки.

3.  **`src/services/stt/capture-page.html`** (424 строки)

    - Страница для открытия в браузере пользователя.
    - Использует WebSockets для стриминга аудио в AssemblyAI (`wss://streaming.assemblyai.com/v3/ws`).
    - Записывает аудио через `getUserMedia` и отправляет его на сервер.

4.  **`src/services/stt/__tests__/SttService.spec.ts`** (306 строк)
    - Тесты для `SttService` (vitest).

### Б. UI компоненты (Frontend)

5.  **`webview-ui/src/components/settings/SttSettings.tsx`** (179 строк)

    - Секция настроек в панели Roo Code.
    - Переключатель включения STT.
    - Выбор провайдера (AssemblyAI / OpenAI Whisper).
    - Поля для ввода API ключей (`assemblyAiApiKey`, `openAiWhisperApiKey`).
    - Настройки таймаута автостопа и автоотправки.

6.  **`webview-ui/src/components/chat/ChatTextArea.tsx`**
    - Добавлена кнопка микрофона (`Mic` / `MicOff` из `lucide-react`).
    - Обработка сообщений `sttTranscript` (вставка текста в поле ввода) и `sttError`.

### В. Типы и интеграция

7.  **`packages/types/src/global-settings.ts`**

    - Добавлены поля: `sttEnabled`, `sttProvider`, `sttAutoStopTimeout`, `sttAutoSend`.
    - Добавлены ключи в `GLOBAL_SECRET_KEYS` (`assemblyAiApiKey`, `openAiWhisperApiKey`).

8.  **`packages/types/src/provider-settings.ts`**

    - Добавлены поля STT для конкретных провайдеров (Anthropic, OpenAI Native, Roo и др.).

9.  **`src/core/webview/ClineProvider.ts`**

    - Инициализация `SttService` при старте провайдера.
    - Метод `getSttService()` для доступа к сервису.

10. **`src/core/webview/webviewMessageHandler.ts`**

    - Обработка команд `startSttCapture` и `stopSttCapture` от WebView.
    - Открытие внешнего URL через `vscode.env.openExternal`.

11. **`src/activate/handleUri.ts`**

    - Обработка URI схемы `vscode://.../stt/transcript` для получения результатов диктовки из браузера.

12. **`src/shared/WebviewMessage.ts`** и **`src/shared/ExtensionMessage.ts`**

    - Новые типы сообщений: `startSttCapture`, `stopSttCapture`, `sttTranscript`, `sttError`, `sttCaptureStarted`.

13. **`webview-ui/src/components/settings/SettingsView.tsx`**
    - Добавлена вкладка "stt" с иконкой `Mic`.

---

## 3. ТЕХНИЧЕСКИЕ ДЕТАЛИ

- **Провайдер:** AssemblyAI (основной), OpenAI Whisper (заглушка).
- **Поток данных:**
    1. Пользователь жмет кнопку "Микрофон" в чате.
    2. `SttService` запускает локальный сервер (`capture-server`) и генерирует токен.
    3. Открывается браузер с `capture-page.html`, передаются параметры (токен, коллбэк URI).
    4. Страница запрашивает доступ к микрофону и шлет аудио через WebSocket в AssemblyAI.
    5. AssemblyAI возвращает текст, страница редиректит пользователя на `vscode://...` с текстом в параметрах.
    6. `handleUri` в расширении ловит этот URI и отправляет текст в WebView чата.

---

## 4. СТАТУС СЛИЯНИЯ (MERGE STATUS)

При попытке выполнить "примерочное слияние" (dry-run merge) с текущей веткой `main` выявлены **конфликты в 6 файлах**:

1. `packages/types/src/global-settings.ts`
2. `packages/types/src/provider-settings.ts`
3. `src/core/webview/ClineProvider.ts`
4. `src/core/webview/webviewMessageHandler.ts`
5. `src/shared/WebviewMessage.ts`
6. `webview-ui/src/components/chat/ChatTextArea.tsx`
7. `webview-ui/src/components/settings/SettingsView.tsx`

**Причина конфликтов:** Код был написан в октябре 2025 года. С тех пор структура `ClineProvider`, типы настроек и UI компоненты в `main` значительно изменились.

---

## 5. ГДЕ НАХОДИТСЯ КОД СЕЙЧАС

- **Ветка:** `review/stt-dictation-wip` (создана локально для изучения).
- **Ветка восстановления:** `stt-recovery` (указывает на коммит `f33d9ba2b`).
- **Текущая ветка:** `review/stt-dictation-wip`.

---

## 6. ВЫВОД

Реализация была **продвинутой и близкой к завершению** (WIP), но была отклонена (Not Planned) из-за архитектурных сложностей (песочница WebView) и решения команды перейти на облачный продукт (Roomote). Код не содержит грубых ошибок, но требует серьезного ребейза (rebase) под текущую структуру `main` из-за множественных конфликтов в типах и провайдерах.

**Рекомендация:** Использовать этот код как справочный материал (reference), а не пытаться слить его напрямую, так как API AssemblyAI и структура настроек с тех пор изменились.
