<div align="center">
<sub>

[English](../../CONTRIBUTING.md) • [Català](../ca/CONTRIBUTING.md) • [Deutsch](../de/CONTRIBUTING.md) • [Español](../es/CONTRIBUTING.md) • [Français](../fr/CONTRIBUTING.md) • [हिंदी](../hi/CONTRIBUTING.md) • [Bahasa Indonesia](../id/CONTRIBUTING.md) • [Italiano](../it/CONTRIBUTING.md) • [日本語](../ja/CONTRIBUTING.md)

</sub>
<sub>

[한국어](../ko/CONTRIBUTING.md) • [Nederlands](../nl/CONTRIBUTING.md) • <b>Polski</b> • [Português (BR)](../pt-BR/CONTRIBUTING.md) • [Русский](../ru/CONTRIBUTING.md) • [Türkçe](../tr/CONTRIBUTING.md) • [Tiếng Việt](../vi/CONTRIBUTING.md) • [简体中文](../zh-CN/CONTRIBUTING.md) • [繁體中文](../zh-TW/CONTRIBUTING.md)

</sub>
</div>

# Wkład w Zoo Code

Zoo Code to projekt społecznościowy i głęboko cenimy każdy wkład. Aby usprawnić współpracę, działamy w oparciu o [podejście „najpierw zgłoszenie”](#podejście-najpierw-zgłoszenie), co oznacza, że wszystkie [żądania ściągnięcia (PR)](#przesyłanie-żądania-ściągnięcia) muszą być najpierw połączone ze zgłoszeniem na GitHubie. Prosimy o uważne zapoznanie się z tym przewodnikiem.

## Spis treści

- [Zanim zaczniesz wnosić wkład](#zanim-zaczniesz-wnosić-wkład)
- [Znajdowanie i planowanie swojego wkładu](#znajdowanie-i-planowanie-swojego-wkładu)
- [Proces rozwoju i przesyłania](#proces-rozwoju-i-przesyłania)
- [Oczekiwania dotyczące żądań ściągnięcia](#oczekiwania-dotyczące-żądań-ściągnięcia)
- [Wkłady wspomagane przez AI](#wkłady-wspomagane-przez-ai)
- [Kwestie prawne](#kwestie-prawne)

## Zanim zaczniesz wnosić wkład

### 1. Kodeks postępowania

Wszyscy współtwórcy muszą przestrzegać naszego [Kodeksu postępowania](./CODE_OF_CONDUCT.md).

### 2. Mapa drogowa projektu

Nasza mapa drogowa wyznacza kierunek projektu. Dostosuj swój wkład do tych kluczowych celów:

### Niezawodność na pierwszym miejscu

- Zapewnij, że edycja różnic i wykonywanie poleceń są niezawodne.
- Zmniejsz punkty tarcia, które zniechęcają do regularnego użytkowania.
- Zagwarantuj płynne działanie we wszystkich lokalizacjach i na wszystkich platformach.
- Rozszerz solidne wsparcie dla szerokiej gamy dostawców i modeli sztucznej inteligencji.

### Ulepszone wrażenia użytkownika

- Usprawnij interfejs użytkownika/doświadczenie użytkownika dla jasności i intuicyjności.
- Ciągle ulepszaj przepływ pracy, aby sprostać wysokim oczekiwaniom, jakie programiści mają wobec narzędzi codziennego użytku.

### Lider w wydajności agentów

- Ustanów kompleksowe wzorce oceny (ewaluacje) w celu pomiaru rzeczywistej produktywności.
- Ułatw wszystkim łatwe uruchamianie i interpretowanie tych ewaluacji.
- Dostarczaj ulepszenia, które wykazują wyraźny wzrost wyników ewaluacji.

Wspomnij o dostosowaniu do tych obszarów w swoich PR-ach.

### 3. Dołącz do społeczności Zoo Code

- **Discord:** Dołącz do naszego [Discorda](https://discord.gg/VxfP4Vx3gX).
- **Reddit:** Dołącz do naszego [Reddita](https://www.reddit.com/r/ZooCode/).

## Znajdowanie i planowanie swojego wkładu

### Rodzaje wkładu

- **Poprawki błędów:** rozwiązywanie problemów z kodem.
- **Nowe funkcje:** dodawanie funkcjonalności.
- **Dokumentacja:** ulepszanie przewodników i przejrzystości.

### Podejście „najpierw zgłoszenie”

Wszystkie wkłady zaczynają się od zgłoszenia na GitHubie przy użyciu naszych uproszczonych szablonów.

- **Sprawdź istniejące zgłoszenia**: Przeszukaj [zgłoszenia na GitHubie](https://github.com/Zoo-Code-Org/Zoo-Code/issues).
- **Utwórz zgłoszenie**, używając:
    - **Ulepszenia:** szablon „Prośba o ulepszenie” (prosty język skoncentrowany na korzyściach dla użytkownika).
    - **Błędy:** szablon „Zgłoszenie błędu” (minimalna reprodukcja + oczekiwane a rzeczywiste + wersja).
- **Chcesz nad tym popracować?** Skomentuj „Zgłaszam się” w zgłoszeniu i wyślij wiadomość prywatną do głównego zespołu na [Discordzie](https://discord.gg/VxfP4Vx3gX), aby zostać przypisanym. Przypisanie zostanie potwierdzone w wątku.
- **PR-y muszą być połączone ze zgłoszeniem.** Niepołączone PR-y mogą zostać zamknięte.

### Decydowanie, nad czym pracować

- Sprawdź [stronę GitHub Issues](https://github.com/Zoo-Code-Org/Zoo-Code/issues), aby znaleźć issues.
- Aby uzyskać dokumentację, odwiedź [dokumentację Zoo Code](https://github.com/Zoo-Code-Org/Zoo-Code-Docs).

### Zgłaszanie błędów

- Najpierw sprawdź istniejące raporty.
- Utwórz nowy błąd, używając szablonu [„Zgłoszenie błędu”](https://github.com/Zoo-Code-Org/Zoo-Code/issues/new/choose) z:
    - Jasnymi, ponumerowanymi krokami reprodukcji
    - Oczekiwanym a rzeczywistym wynikiem
    - Wersją Zoo Code (wymagane); dostawcą/modelem sztucznej inteligencji, jeśli ma to zastosowanie
- **Problemy z bezpieczeństwem**: Zgłoś je prywatnie za pośrednictwem [zaleceń dotyczących bezpieczeństwa](https://github.com/Zoo-Code-Org/Zoo-Code/security/advisories/new).

## Proces rozwoju i przesyłania

### Konfiguracja środowiska programistycznego

1. **Sforkuj i sklonuj:**

```
git clone https://github.com/YOUR_USERNAME/Zoo-Code.git
```

2. **Zainstaluj zależności:**

```
pnpm install
```

3. **Debugowanie:** Otwórz za pomocą VS Code (`F5`).

### Wytyczne dotyczące pisania kodu

- Jeden skoncentrowany PR na funkcję lub poprawkę.
- Przestrzegaj najlepszych praktyk ESLint i TypeScript.
- Pisz jasne, opisowe commity odwołujące się do zgłoszeń (np. `Naprawia #123`).
- Zapewnij dokładne testy (`npm test`).
- Zrób rebase na najnowszą gałąź `main` przed przesłaniem.

### Przesyłanie żądania ściągnięcia

- Zacznij jako **wersja robocza PR**, jeśli szukasz wczesnej opinii.
- Jasno opisz swoje zmiany, postępując zgodnie z szablonem żądania ściągnięcia.
- Połącz zgłoszenie w opisie/tytule PR (np. „Naprawia #123”).
- Udostępnij zrzuty ekranu/filmy wideo dotyczące zmian w interfejsie użytkownika.
- Wskaż, czy konieczne są aktualizacje dokumentacji.

### Polityka dotycząca żądań ściągnięcia

- Musi odnosić się do przypisanego zgłoszenia na GitHubie. Aby zostać przypisanym: skomentuj „Zgłaszam się” w zgłoszeniu i wyślij wiadomość prywatną do głównego zespołu na [Discordzie](https://discord.gg/VxfP4Vx3gX). Przypisanie zostanie potwierdzone w wątku.
- Niepołączone PR-y mogą zostać zamknięte.
- PR-y muszą przejść testy CI, być zgodne z mapą drogową i mieć przejrzystą dokumentację.

### Proces przeglądu

- **Codzienna selekcja:** Szybkie sprawdzanie przez opiekunów.
- **Cotygodniowy dogłębny przegląd:** Kompleksowa ocena.
- **Szybko iteruj** w oparciu o opinie.

### Oczekiwania dotyczące żądań ściągnięcia

Żądania ściągnięcia powinny być możliwe do przejrzenia, przetestowane i łatwe w utrzymaniu. Przed otwarciem PR upewnij się, że:

- Zmiana jest ograniczona do konkretnego zgłoszenia, błędu lub ulepszenia.
- Możesz wyjaśnić, co robi zmiana i dlaczego jest poprawna.
- Przetestowałeś zmianę lokalnie tam, gdzie jest to praktyczne.
- Jesteś gotowy do odpowiadania na opinie z przeglądu i wprowadzania rozsądnych zmian następczych.
- PR nie wymaga od opiekunów zasadniczego przepisania, przeprojektowania ani przejęcia własności implementacji przed scaleniem.

Opiekunowie mogą zamykać PR, które są niekompletne, zbyt szerokie, nieaktywne, niezgodne z kierunkiem projektu lub tworzące nieproporcjonalne obciążenie przeglądem lub konserwacją. Zamknięcie PR nie jest oceną współtwórcy; jest to decyzja opiekunów, że zmiana nie może zostać zaakceptowana w jej obecnej postaci.

### Wkłady wspomagane przez AI

Korzystanie z narzędzi AI jest dozwolone, ale współtwórcy pozostają w pełni odpowiedzialni za swoje zgłoszenia.

Jeśli używasz narzędzi AI do pomocy przy tworzeniu PR, musisz:

- Przejrzeć i zrozumieć każdą istotną zmianę.
- Być w stanie wyjaśnić implementację i kompromisy własnymi słowami.
- Samodzielnie przetestować zmianę. Jeśli testy nie są praktyczne w Twoim środowisku, wyjaśnij dlaczego w opisie PR i opisz, jak recenzenci mogą zweryfikować zmianę.
- Zweryfikować, że wygenerowany kod jest poprawny, konieczny i zgodny z licencją projektu.
- Rozważ ujawnienie pomocy AI w opisie PR, gdy istotnie wpłynęła na kod, testy lub projekt — pomaga to recenzentom udzielać lepszych opinii.

Prosimy o nieprzesyłanie zmian wygenerowanych przez AI, których nie rozumiesz lub których nie możesz utrzymać podczas przeglądu. Opiekunowie mogą zamykać PR, które wydają się w istotnym stopniu wspomagane przez AI, ale brakuje im weryfikacji człowieka, jasnego uzasadnienia lub kontynuacji przeglądu.

## Kwestie prawne

Przesyłając wkład, zgadzasz się, że Twoje wkłady będą licencjonowane na podstawie licencji Apache 2.0, zgodnie z licencją Zoo Code.
