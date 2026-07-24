"""Add unknownEventCount key to all locale dashboard.json files."""
import json
import os

locales_dir = "webview-ui/src/i18n/locales"

translations = {
    "ko": "{{count}}개의 API 호출 (캐시 데이터 미상)",
    "ja": "{{count}}件のAPI呼び出し（キャッシュデータ不明）",
    "zh-CN": "{{count}} 次 API 调用（缓存数据未知）",
    "zh-TW": "{{count}} 次 API 呼叫（快取資料未知）",
    "de": "{{count}} API-Aufrufe mit unbekannten Cache-Daten",
    "fr": "{{count}} appels API avec données de cache inconnues",
    "es": "{{count}} llamadas API con datos de caché desconocidos",
    "pt-BR": "{{count}} chamadas API com dados de cache desconhecidos",
    "it": "{{count}} chiamate API con dati cache sconosciuti",
    "ru": "{{count}} вызовов API с неизвестными данными кеша",
    "tr": "{{count}} API çağrısı (bilinmeyen önbellek verisi)",
    "vi": "{{count}} cuộc gọi API (dữ liệu bộ nhớ đệm không xác định)",
    "pl": "{{count}} wywołań API z nieznanymi danymi pamięci podręcznej",
    "nl": "{{count}} API-oproepen met onbekende cachegegevens",
    "ca": "{{count}} crides API amb dades de memòria cau desconegudes",
    "hi": "{{count}} API कॉल (अज्ञात कैश डेटा)",
    "id": "{{count}} panggilan API dengan data cache tidak diketahui",
}

for locale, value in translations.items():
    path = os.path.join(locales_dir, locale, "dashboard.json")
    if not os.path.exists(path):
        print(f"SKIP {locale}: file not found")
        continue
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    if "summary" not in data:
        print(f"SKIP {locale}: no summary section")
        continue

    if "unknownEventCount" in data["summary"]:
        print(f"SKIP {locale}: already has key")
        continue

    data["summary"]["unknownEventCount"] = value

    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent="\t")
        f.write("\n")

    print(f"OK {locale}")

print("Done!")
