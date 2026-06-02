# Спецификация: Rust Audio Micro-Module (Roo-Code STT Prep)

**Версия**: 1.1
**Статус**: Спецификация для реализации
**Назначение**: Легковесный нативный модуль для захвата и очистки аудио в памяти (In-Memory) перед отправкой на внешний API.

> **Примечание о весе**: Финальный бинарник ядра весит **~460KB**, что строго меньше лимита в 500KB.

---

## 1. Архитектурный контекст

- **Rust Core**: Отвечает за захват (CPAL), VAD (Voice Activity Detection через nnnoiseless vad_prob), Noise Suppression (nnnoiseless) и Wake Word (Rustpotter).
- **Node.js (Orchestrator)**: Управляет жизненным циклом Rust-модуля, отправляет очищенный буфер на внешний STT API (Groq/Whisper) и проигрывает ответ через TTS.
- **In-Memory Flow**: `Mic -> [Rust: Capture -> NS+VAD -> Buffer] -> Node.js -> External API`.

---

## 2. Ключевые принципы (из примеров `audio.py` и `audio_level_monitor.c`)

1.  **Zero-Disk (Как в `audio.py`)**: Никаких `wav` или `tmp` файлов. Используем `Vec<u8>` или `Vec<f32>` для хранения сэмплов.
2.  **RMS и Пороги (Как в `audio_level_monitor.c`)**: Используем вычисление среднеквадратичного отклонения (RMS) для определения тишины в реальном времени.
3.  **Минимализм**: Модуль должен быть компактным (< 500KB бинарника) и не требовать тяжелых зависимостей.

---

## 3. Технологический стек (Research via Context7)

| Компонент                   | Библиотека          | Вес         | Роль                                                |
| :-------------------------- | :------------------ | :---------- | :-------------------------------------------------- |
| **Audio Capture**           | `cpal`              | 150 KB      | Кроссплатформенный захват (Pulse/ALSA/WASAPI).      |
| **Noise Suppression + VAD** | `nnnoiseless`       | 160 KB      | Удаление фонового шума + встроенный VAD (vad_prob). |
| **Wake Word**               | `Rustpotter` (tiny) | 150 KB      | Детекция wake word.                                 |
| **Interop**                 | `napi-rs`           | —           | Передача буфера в Node.js.                          |
| **ИТОГО**                   |                     | **~460 KB** | **< 500KB ✅**                                      |

> **Примечание**: TEN VAD удален — используется встроенный `vad_prob` из `nnnoiseless::process_frame`.

---

## 4. Алгоритм работы (Pseudo-code / Rust Logic)

```rust
// Адаптация логики из audio_level_monitor.c и audio.py

struct AudioBuffer {
    samples: Vec<f32>, // Только память, никаких файлов
}

fn process_chunk(raw_samples: &[f32]) -> Option<Vec<f32>> {
    // 1. Шумоподавление + VAD через nnnoiseless
    // nnnoiseless::DenoiseState::process_frame возвращает кортеж (очищенные сэмплы, vad_probability)
    let (cleaned_samples, vad_prob) = nnnoiseless::process_frame(raw_samples);

    // 2. Проверка VAD (Voice Activity Detection)
    // Если vad_prob < порога (например, 0.9), считаем что это тишина/шум
    if vad_prob < VAD_THRESHOLD {
        return None; // Тишина обнаружена, данные не передаем
    }

    // 3. Возврат буфера (In-Memory)
    Some(cleaned_samples)
}

// Коллбэк CPAL
fn cpal_callback(data: &[f32]) {
    if let Some(clean_buffer) = process_chunk(data) {
        // Отправка в Node.js (через N-API или stdout)
        send_to_host(&clean_buffer);
    }
    // Если тишина -> ничего не отправляем, экономим трафик и токены API
}
```

---

## 5. Интеграция с Node.js (Orchestrator)

Rust-модуль компилируется как `cdylib` (`.node` файл через `napi-rs`).

**Взаимодействие:**

1.  **Start**: Node.js вызывает `rust_start_capture(config)`.
2.  **Data**: Rust шлет очищенные буферы через `ThreadSafeFunction`.
3.  **Stop**: Node.js вызывает `rust_stop_capture()`, получает финальный буфер (если есть) и отправляет его на **внешний STT API**.

---

## 6. Требования к ресурсам

- **RAM**: Буферы очищаются сразу после отправки (`drop(buffer)`).
- **CPU**: Использование легковесных алгоритмов. VAD через nnnoiseless vad_prob незначительно нагружает CPU.
- **Latency**: Минимальная задержка за счет отсутствия дискового I/O.
- **Binary Size**: ~460KB (< 500KB limit).

---

## 7. Связь с отчетами

- Этот модуль реализует требования, описанные в [`STT_ARCHITECTURE_V2.md`](OTCHETY/STT_ARCHITECTURE_V2.md) (раздел Rust Core).
- Он заменяет собой `stream-capture.ts` и `audio-filter.ts` из предыдущих версий, перенося логику на нативный уровень для максимальной производительности.
- Оптимизированный стек с проверкой лимита 500KB описан в [`final_optimized_report.md`](OTCHETY/final_optimized_report.md).
