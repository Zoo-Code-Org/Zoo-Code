# Архитектура голосового ассистента Roo-Code (STT + TTS) — V4 (Rust Core)

**Дата**: 2026-05-01
**Статус**: Финализировано (Optimized Stack < 500KB)
**Автор**: Agent (Code/Architect)

> ⚠️ **Примечание о весе**: Финальное ядро весит **~460KB**, что строго меньше лимита 500KB.

---

## 1. Концепция: Гибридная архитектура (Node.js + Rust)

Для достижения максимальной производительности и минимального потребления ресурсов, критические узлы обработки аудио выносятся в отдельный **Rust Micro-Module**.

- **Node.js (Orchestrator)**: Управление состоянием, UI (WebView), взаимодействие с API (Groq/Whisper), логика TTS и Echo Guard.
- **Rust (Audio Core)**: Захват аудио (CPAL), VAD (nnnoiseless vad_prob), Noise Suppression (RNNoise), Wake Word (Rustpotter). Работает строго в памяти (In-Memory).

---

## 2. Схема потоков данных (Mermaid)

```mermaid
flowchart TD
    subgraph User_Device [Устройство пользователя]
        Mic[Микрофон]
    end

    subgraph Rust_Core [Rust Audio Core < 500KB (~460KB)]
        CPAL[cpal: Захват аудио]
        NN[nnnoiseless: NS + VAD vad_prob]
        WW[Rustpotter: Wake Word tiny]
        Buffer[In-Memory Buffer]
    end

    subgraph Node_Orchestrator [Node.js Оркестратор]
        API_Client[API Client: Groq/Whisper]
        UI[VS Code UI]
        EchoGuard[Echo Guard]
    end

    Mic -->|"Raw Audio"| CPAL
    CPAL -->|"Samples"| NN
    NN -->|"VAD Probability > 0.9?"| WW
    WW -->|"Wake Word Detected"| NN
    NN -->|"Clean Audio"| Buffer
    Buffer -->|"Base64/Int16"| API_Client
    API_Client -->|"Text"| UI
    UI -->|"ttsStart/ttsStop"| EchoGuard
    EchoGuard -->|"Mute/Unmute"| CPAL
```

---

## 3. Rust Micro-Module: Спецификация

### 3.1. Назначение

Высокопроизводительный, кроссплатформенный аудио-процессор.

- **In-Memory**: Никаких файлов. Все буферы (`Vec<u8>`, `Vec<f32>`) живут в RAM и очищаются через RAII (Drop).
- **Zero-Copy**: По возможности используем ссылки на данные из коллбэков CPAL.

### 3.2. Ключевые библиотеки (Final Stack < 500KB)

- **cpal** (150KB): Кроссплатформенный захват аудио (Linux/PipeWire, Windows, macOS).
- **nnnoiseless** (160KB): Noise Suppression (RNNoise) + VAD (`vad_prob` от `process_frame`). Заменяет TEN VAD и webrtc-audio-processing.
- **Rustpotter** (150KB, tiny models): Wake Word detection.

> ⚠️ **Итого: ~460KB** (< 500KB лимит соблюден)

### 3.3. Алгоритм работы (Optimized)

1.  **Capture**: Поток CPAL отдает `&[f32]` (сэмплы).
2.  **NS + VAD**: `nnnoiseless::DenoiseState::process_frame` возвращает `(denoised_samples, vad_probability)`.
3.  **Wake Word**: Если `vad_prob > 0.9` -> Проверка через Rustpotter (tiny модели).
4.  **Buffer**: При детекции Wake Word -> Буферизация чистого аудио.
5.  **Output**: Чистый буфер отправляется в Node.js (через N-API или stdin/stdout).

---

## 4. Интеграция с RooCode

### 4.1. Способ взаимодействия

- **Вариант А (Рекомендуемый)**: Rust собирается как `cdylib` (shared library) и вызывается из Node.js через **N-API** (neon-bindings). Это обеспечивает минимальную задержку.
- **Вариант Б**: Rust как отдельный процесс (Sidecar), общение через `stdin/stdout` (JSON-RPC или бинарный протокол).

### 4.2. Echo Guard (TTS Duplexing)

Rust-модуль предоставляет метод `set_mute(bool)`.

- При событии `ttsStart` из Node.js -> `rust_core.set_mute(true)`.
- Микрофон перестает слать данные, предотвращая самозахват.

---

## 5. Файлы для реализации

| Файл                                              | Действие | Описание                                          |
| :------------------------------------------------ | :------- | :------------------------------------------------ |
| `src/services/stt/SttService.ts`                  | **Edit** | Оркестрация Rust-модуля.                          |
| `src/services/stt/echo-guard.ts`                  | **New**  | Mute/Unmute (вызов Rust).                         |
| `native/audio-core/Cargo.toml`                    | **New**  | Rust проект (cpal, nnnoiseless, rustpotter-tiny). |
| `native/audio-core/src/lib.rs`                    | **New**  | Логика захвата, NS+VAD и Wake Word.               |
| `webview-ui/src/components/chat/ChatTextArea.tsx` | **Edit** | UI.                                               |

---

## 6. Резюме

Переход на Rust позволяет реализовать "Супер-фильтр" и "In-Memory" обработку на уровне, недоступном чистому Node.js. Это решение элегантно встраивается в RooCode, обеспечивая конфиденциальность (нет записи на диск) и высокую точность распознавания.
