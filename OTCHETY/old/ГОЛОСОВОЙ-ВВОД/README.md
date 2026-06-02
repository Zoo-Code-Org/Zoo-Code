# База знаний: Голосовой модуль RooCode

## Структура файлов

### 1. Финальные утвержденные документы (Основа для реализации)

- `final_optimized_report.md` — **ГЛАВНЫЙ ДОКУМЕНТ**. Финальный стек: cpal + nnnoiseless + Rustpotter tiny (~460KB < 500KB)
- `context_master_01.json` — Контекст мастер-задачи (JSON для агентов)

### 2. Архитектурные спецификации

- `STT_ARCHITECTURE_V2.md` — Архитектура V4 (Rust Core). Гибридная схема Node.js + Rust с Mermaid диаграммой
- `RUST_AUDIO_CORE_SPEC.md` — Спецификация Rust Micro-Module. Алгоритмы, псевдокод, интеграция с N-API

### 3. Исследовательские отчеты

- `STT_RESEARCH_REPORT.md` — Исследование V3. Концепция "Тонкий клиент, мощный API"
- `RESOURCE_COMPARISON.md` — Сравнение ресурсоемкости. RNNoise vs WebRTC vs Silero
- `STT_RECOVERY_REPORT.md` — История PR f33d9ba (ветка feature/stt-dictation). Справочный материал

### 4. Промежуточные отчеты исследования (Не удалять - содержат детали)

- `report_2026-05-01_context7-research.md` — Context7 данные по cpal, nnnoiseless, RNNoise, webrtc-audio-processing
- `report_2026-05-01_tavily-research.md` — Tavily данные по TEN VAD, Tinyaudio, Rustpotter, DeepFilterNet3
- `report_2026-05-01_systematized.md` — Систематизация по критериям (Вес/RAM/Качество)
- `report_2026-05-01_analysis-existing.md` — Анализ существующих отчетов
- `report_2026-05-01_final.md` — Итоговый отчет (содержит детали сравнений)

### 5. Устаревшие документы

- `final_report.md` — **УСТАРЕЛ**. Содержит TEN VAD (306KB), что превышает лимит 500KB. Использовать только для справки о процессе принятия решений

## Итоговый стек (Утверждено)

- **Audio I/O**: `cpal` (~150KB)
- **Noise Suppression + VAD**: `nnnoiseless` (~160KB, использует vad_prob из process_frame)
- **Wake Word**: `Rustpotter` (~150KB, tiny модели)
- **Итого**: ~460KB < 500KB ✅

## Что не вошло в финальный стек

- TEN VAD (306KB) — слишком тяжелый, заменен на nnnoiseless::vad_prob
- webrtc-audio-processing (>1MB) — слишком тяжелый
- Silero VAD / DeepFilterNet3 (>1MB) — слишком тяжелые
- Tinyaudio — не поддерживает Input (только Output)
- Porcupine — коммерческая лицензия
