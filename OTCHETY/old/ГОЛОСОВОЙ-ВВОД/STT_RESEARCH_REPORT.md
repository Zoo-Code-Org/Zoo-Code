# Отчет: Идеальная архитектура STT (Voice Input) для Roo-Code — V3

**Дата**: 2026-05-01
**Статус**: Исследование завершено (Optimized Stack)
**Методология**: Research Analyst + Search Specialist + Rust Architect.

---

## 1. Концепция: "Тонкий клиент, мощный API"

Система разделяется на два слоя:

1.  **Rust Audio Core (Локально)**: Захват, очистка (Noise Suppression), VAD (Silence Removal). Работает строго в RAM (In-Memory).
2.  **External API (Groq/Whisper)**: Транскрибация аудио в текст.
3.  **External TTS API**: Озвучивание ответа.

---

## 2. Почему Rust Micro-Module?

- **In-Memory Processing**: В отличие от Node.js, Rust гарантирует отсутствие неожиданных записей на диск и дает полный контроль над памятью (`Vec<u8>`).
- **Эффективность**: Алгоритмы из `audio_level_monitor.c` (RMS) и `audio.py` (многопоточность) легко портируются на Rust с минимальными накладными расходами.
- **Zero-Copy**: Использование `cpal` позволяет обрабатывать сэмплы "на лету" прямо в коллбэке.

---

## 3. Технологический стек (Optimized)

| Компонент         | Технология                  | Роль                                                     | Вес    |
| :---------------- | :-------------------------- | :------------------------------------------------------- | :----- | -------------- |
| **Capture**       | `cpal` (Rust)               | Захват аудио (Pulse/ALSA/WASAPI).                        | 150 KB |
| **NS + VAD**      | `nnnoiseless`               | Noise Suppression + VAD (`vad_prob` из `process_frame`). | 160 KB |
| **Wake Word**     | `Rustpotter` (tiny)         | Детекция wake word.                                      | 150 KB |
| **STT API**       | **External** (Groq/Whisper) | Транскрибация (OpenAI-compatible).                       | —      |
| **TTS API**       | **External**                | Озвучка ответа.                                          | —      |
| **Orchestration** | Node.js (Extension Host)    | Управление потоком, UI, Echo Guard.                      | —      |
| **ИТОГО**         |                             |                                                          |        | **~460 KB** ✅ |

---

## 4. Поток данных (In-Memory)

1.  **Mic** -> `cpal` (Rust) -> `Buffer (RAM)`.
2.  **Rust**: Применяет `Silence Removal` (отбрасывает тишину) и `Noise Suppression`.
3.  **Rust -> Node.js**: Передает очищенный буфер (через N-API или Pipe).
4.  **Node.js**: Отправляет буфер на **External STT API** (Groq/Whisper).
5.  **API**: Возвращает текст -> Вставляется в чат.
6.  **TTS**: При ответе ассистента, Node.js отправляет текст на **External TTS API**, получает аудио и проигрывает его, активируя `Echo Guard` (Mute Mic).

---

## 5. Спецификация Rust-модуля (Кратко)

Полная спецификация находится в `OTCHETY/RUST_AUDIO_CORE_SPEC.md`.

- **Вход**: Поток сэмплов от микрофона.
- **Обработка**:
    - `nnnoiseless::DenoiseState::process_frame` возвращает `vad_probability` (0.0 - 1.0).
    - Если `vad_prob` > порога (0.9) -> аудио сохраняется, иначе отбрасывается (Zero Disk).
    - Одновременно выполняется Noise Suppression.
- **Выход**: Чистый `Vec<f32>` или `Vec<u8>` в памяти.
- **Примечание**: Финальный вес ядра ~460KB (< 500KB лимит).

---

## 6. Интеграция с RooCode

- **Файл**: `src/services/stt/SttService.ts` управляет Rust-модулем.
- **Файл**: `src/services/stt/echo-guard.ts` отключает микрофон (через Rust или системно) при проигрывании TTS.
- **UI**: `ChatTextArea.tsx` активирует процесс.

---

## Заключение

Переход на Rust для аудио-препроцессинга и использование внешних API для STT/TTS — это идеальный баланс. Мы получаем "супер-фильтрацию" и конфиденциальность (In-Memory) от Rust, и мощность нейросетей от облачных API, сохраняя при этом легкость основного расширения RooCode.
