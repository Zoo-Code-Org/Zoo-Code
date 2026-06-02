# Отчет по исследованию Rust библиотек аудио обработки (Context7 + Web)

**Дата**: 2026-05-01  
**Источники**: Context7 MCP (`/websites/rs_cpal_0_17_0_cpal`, `/jneem/nnnoiseless`, `/xiph/rnnoise`), Tavily Web Search.  
**Цель**: Оценка библиотек для голосового модуля RooCode (вес ядра < 500KB, In-Memory режим).

---

## 1. CPAL (Cross-Platform Audio Library)

| Характеристика            | Значение                                                               |
| :------------------------ | :--------------------------------------------------------------------- |
| **Library ID (Context7)** | `/websites/rs_cpal_0_17_0_cpal`                                        |
| **Версия (документация)** | 0.17.0                                                                 |
| **Вес (бинарник)**        | В составе ядра (чистый Rust, минимальный оверхед)                      |
| **RAM usage**             | Минимально (зависит от буфера, рекомендуется `BufferSize::Fixed(256)`) |
| **CPU load**              | Низкий (зависит от `BufferSize`, меньший буфер = выше CPU)             |
| **Качество**              | N/A (захват/плебек, не обработка)                                      |
| **VAD / NS**              | Нет (только I/O)                                                       |
| **In-Memory**             | Да (потоковая обработка через callback)                                |

**Возможности**:

- Кроссплатформа (Windows, macOS, Linux, WebAssembly).
- Поддержка `wasm-bindgen` для Web.
- Низкая латентность при `BufferSize::Fixed`.
- Поддержка форматов: F32, I16, U16.

**Пример (In-Memory capture)**:

```rust
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
let host = cpal::default_host();
let device = host.default_input_device().unwrap();
let config = device.default_input_config().unwrap().config();
let stream = device.build_input_stream(&config, |data: &[f32], _| {
    // Обработка данных в памяти (например, передача в DenoiseState)
}, |err| eprintln!("{}", err), None).unwrap();
stream.play().unwrap();
```

---

## 2. nnnoiseless (Rust port of RNNoise)

| Характеристика            | Значение                               |
| :------------------------ | :------------------------------------- |
| **Library ID (Context7)** | `/jneem/nnnoiseless`                   |
| **Версия**                | 0.2.1+ (актуально 2025-2026)           |
| **Вес (бинарник)**        | ~100 KB (код) + **~60 KB (модель)**    |
| **RAM usage**             | ~5-10 MB (состояние нейросети)         |
| **CPU load**              | Средний (RNN на 480 сэмплов)           |
| **Качество (шкала 1-10)** | **9** (нейросеть, GRU архитектура)     |
| **VAD**                   | Да (возвращает вероятность `vad_prob`) |
| **Noise Suppression**     | Да (RNNoise алгоритм)                  |
| **Wake Word**             | Нет                                    |
| **In-Memory**             | Да                                     |

**Особое внимание: `from_static_bytes`**:
Библиотека поддерживает загрузку модели напрямую из памяти без аллокаций, что критично для In-Memory режима.

```rust
use nnnoiseless::{DenoiseState, RnnModel};

// Загрузка модели в compile-time (без аллокаций в рантайме)
static MODEL_WEIGHTS: &[u8] = include_bytes!("../weights.rnn");
let model = RnnModel::from_static_bytes(MODEL_WEIGHTS).expect("Invalid model");
let mut denoise = DenoiseState::from_model(model);

// Обработка кадра (480 сэмплов = 10мс при 48кГц)
let input: [f32; 480] = [0.0; 480];
let mut output = [0.0f32; 480];
let vad_prob = denoise.process_frame(&mut output, &input);
```

**Примечание**: Вес модели действительно составляет около **60KB** (подтверждено Context7 и crates.io).

---

## 3. RNNoise (Original C Library)

| Характеристика            | Значение                                                   |
| :------------------------ | :--------------------------------------------------------- |
| **Library ID (Context7)** | `/xiph/rnnoise`                                            |
| **Версия**                | Актуальная (gitlab.xiph.org)                               |
| **Вес (бинарник)**        | ~40-60 KB (C код) + 60 KB (модель)                         |
| **RAM usage**             | ~5-10 MB                                                   |
| **CPU load**              | Средний (оптимизировано под AVX2/SSE4.1)                   |
| **Качество (шкала 1-10)** | **9** (эталон для nnnoiseless)                             |
| **VAD**                   | Да                                                         |
| **Noise Suppression**     | Да                                                         |
| **Wake Word**             | Нет                                                        |
| **In-Memory**             | Да (через `rnnoise_model_from_file` или встроенную модель) |

**Интеграция**:

- Можно использовать через FFI, но `nnnoiseless` (порт на Rust) предпочтительнее для Rust-проекта (безопасность, отсутствие `libclang` зависимостей).
- Поддерживает экспорт модели в бинарный блоб (`weights_blob.bin`).

---

## 4. webrtc-audio-processing (Rust Wrapper)

| Характеристика            | Значение                                         |
| :------------------------ | :----------------------------------------------- |
| **Library ID (Context7)** | Не найден (использовался веб-поиск)              |
| **Crate**                 | `webrtc-audio-processing` (crates.io)            |
| **Версия**                | 2.x (трекинг версий PulseAudio)                  |
| **Вес (бинарник)**        | **> 1 MB** (включает C++ код WebRTC, PulseAudio) |
| **RAM usage**             | > 20 MB (тяжелые структуры данных WebRTC)        |
| **CPU load**              | Средний/Высокий                                  |
| **Качество (шкала 1-10)** | **8** (комплексная обработка)                    |
| **VAD**                   | Да                                               |
| **Noise Suppression**     | Да (NS, AGC, Echo Cancellation)                  |
| **Wake Word**             | Нет                                              |
| **In-Memory**             | Да                                               |

**Сравнение с RNNoise**:

- **Вес**: `webrtc-audio-processing` значительно тяжелее (MB против KB).
- **Качество**: Сравнимо, но WebRTC дает больше функций (эхоподавление, AGC).
- **Ресурсы**: Для задачи "Ядро < 500KB" **не подходит**.

**Сборка**:

```bash
# Требует C++ toolchain, включает весь WebRTC AudioProcessing модуль
cargo build --features bundled
```

---

## 5. Сводная таблица для выбора

| Библиотека                  | Вес (KB)              | RAM (MB) | CPU     | Качество (1-10) | Примечания                                              |
| :-------------------------- | :-------------------- | :------- | :------ | :-------------- | :------------------------------------------------------ |
| **cpal**                    | ~150 (в составе)      | 1-2      | Низкий  | N/A             | Обязательно для захвата                                 |
| **nnnoiseless**             | **~160** (код+модель) | 5-10     | Средний | **9**           | **Лучший выбор** (Rust, In-Memory, `from_static_bytes`) |
| **RNNoise (C)**             | ~100                  | 5-10     | Средний | 9               | Требует FFI, уступает nnnoiseless в интеграции          |
| **webrtc-audio-processing** | **> 1000**            | > 20     | Средний | 8               | Слишком тяжелый для нашей задачи                        |

---

## 6. Выводы

1. **nnnoiseless** — идеальный кандидат. Вес модели ~60KB подтвержден. Поддержка `from_static_bytes` позволяет загружать веса в память на этапе компиляции.
2. **cpal** — стандарт де-факто для кроссплатформенного захвата в Rust.
3. **webrtc-audio-processing** — избыточен по весу для цели < 500KB.
4. **In-Memory режим** полностью реализуем через `cpal` (потоки) + `nnnoiseless` (обработка в памяти).

**Рекомендуемый стек**: `cpal` + `nnnoiseless` (с `from_static_bytes`).
