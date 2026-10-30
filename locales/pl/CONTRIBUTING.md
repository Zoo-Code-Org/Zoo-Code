<div align="center">
<sub>

[English](../../CONTRIBUTING.md) • [Català](../ca/CONTRIBUTING.md) • [Deutsch](../de/CONTRIBUTING.md) • [Español](../es/CONTRIBUTING.md) • [Français](../fr/CONTRIBUTING.md) • [हिंदी](../hi/CONTRIBUTING.md) • [Bahasa Indonesia](../id/CONTRIBUTING.md) • [Italiano](../it/CONTRIBUTING.md) • [日本語](../ja/CONTRIBUTING.md)

</sub>
<sub>

[한국어](../ko/CONTRIBUTING.md) • [Nederlands](../nl/CONTRIBUTING.md) • <b>Polski</b> • [Português (BR)](../pt-BR/CONTRIBUTING.md) • [Русский](../ru/CONTRIBUTING.md) • [Türkçe](../tr/CONTRIBUTING.md) • [Tiếng Việt](../vi/CONTRIBUTING.md) • [简体中文](../zh-CN/CONTRIBUTING.md) • [繁體中文](../zh-TW/CONTRIBUTING.md)

</sub>
</div>

<a id="contributing-to-zoo-code"></a>

# Współtworzenie Zoo Code

Zoo Code to projekt społeczności. Cenimy każdy wkład. Działamy zgodnie z podejściem [Issue-First](#issue-first-approach). Oznacza to, że każdy [Pull Request (PR)](#submitting-a-pull-request) musi zawierać link do zgłoszenia w GitHub. Przeczytaj uważnie ten przewodnik.

<a id="table-of-contents"></a>

## Spis treści

- [Zanim zaczniesz](#before-you-contribute)
- [Wybór i planowanie wkładu](#finding--planning-your-contribution)
- [Praca nad zmianą i jej przesłanie](#development--submission-process)
    - [Oczekiwania wobec Pull Requestów](#pull-request-expectations)
    - [Wkład z pomocą AI](#ai-assisted-contributions)
    - [Styl pisania](#writing-style)
- [Kwestie prawne](#legal)

<a id="before-you-contribute"></a>

## Zanim zaczniesz

<a id="1-code-of-conduct"></a>

### 1. Kodeks postępowania

Wszyscy współtwórcy muszą przestrzegać naszego [kodeksu postępowania](./CODE_OF_CONDUCT.md).

<a id="2-project-roadmap"></a>

### 2. Plan rozwoju projektu

Plan rozwoju pokazuje kierunek projektu. Dostosuj swój wkład do tych celów:

<a id="reliability-first"></a>

### Niezawodność przede wszystkim

- Zadbaj, aby edycja przez diff i wykonywanie poleceń działały niezawodnie za każdym razem.
- Usuń problemy, które przeszkadzają w codziennym korzystaniu z Zoo Code.
- Zadbaj, aby Zoo Code działało we wszystkich wersjach językowych i na wszystkich platformach.
- Dodaj obsługę większej liczby dostawców i modeli AI.

<a id="enhanced-user-experience"></a>

### Lepsze doświadczenie użytkownika

- Spraw, aby UI i UX były jasne i łatwe w użyciu.
- Usprawnij przepływ pracy. Programiści oczekują wysokiej jakości od narzędzi, których używają codziennie.

<a id="leading-on-agent-performance"></a>

### Nacisk na wydajność agentów

- Twórz benchmarki oceny (evals), które mierzą rzeczywistą produktywność.
- Zadbaj, aby evals były łatwe do uruchomienia i czytania.
- Dostarczaj ulepszenia, które wyraźnie podnoszą wyniki evals.

W swoich PR-ach wskaż, które z tych obszarów wspiera zmiana.

<a id="3-join-the-zoo-code-community"></a>

### 3. Dołącz do społeczności Zoo Code

- **Discord:** Dołącz do naszego [Discorda](https://discord.gg/VxfP4Vx3gX).
- **Reddit:** Dołącz do naszego [Reddita](https://www.reddit.com/r/ZooCode/).

<a id="finding--planning-your-contribution"></a>

## Wybór i planowanie wkładu

<a id="types-of-contributions"></a>

### Rodzaje wkładu

- **Poprawki błędów:** Naprawiaj problemy w kodzie.
- **Nowe funkcje:** Dodawaj funkcje.
- **Dokumentacja:** Ulepszaj przewodniki i zwiększaj ich czytelność.

<a id="issue-first-approach"></a>

### Podejście Issue-First

Każdy wkład zaczyna się od zgłoszenia w GitHub. Używaj naszych krótkich szablonów.

- **Sprawdź istniejące zgłoszenia**: Przeszukaj [GitHub Issues](https://github.com/Zoo-Code-Org/Zoo-Code/issues).
- **Utwórz zgłoszenie**, korzystając z:
    - **Ulepszenia:** Szablonu "Enhancement Request" (prosty język, skupiony na korzyści dla użytkownika).
    - **Błędy:** Szablonu "Bug Report" (minimalny przykład odtworzenia, oczekiwany i rzeczywisty wynik, wersja).
- **Napisz zgłoszenie** zgodnie z opisanym niżej [stylem pisania](#writing-style).
- **Chcesz się tym zająć?** Dodaj komentarz "Claiming" w zgłoszeniu. Następnie skontaktuj się z głównym zespołem na [Discordzie](https://discord.gg/VxfP4Vx3gX), aby otrzymać przydział. Zespół potwierdza przydział w wątku.
- **PR-y muszą zawierać link do zgłoszenia.** Możemy zamknąć PR bez linku.

<a id="deciding-what-to-work-on"></a>

### Wybór zadania

- Sprawdź [stronę GitHub Issues](https://github.com/Zoo-Code-Org/Zoo-Code/issues).
- W sprawie dokumentacji przejdź do [Zoo Code Docs](https://github.com/Zoo-Code-Org/Zoo-Code-Docs).

<a id="reporting-bugs"></a>

### Zgłaszanie błędów

- Najpierw sprawdź istniejące zgłoszenia.
- Zgłoś nowy błąd za pomocą [szablonu "Bug Report"](https://github.com/Zoo-Code-Org/Zoo-Code/issues/new/choose) i podaj:
    - Jasne, ponumerowane kroki odtworzenia błędu
    - Oczekiwany i rzeczywisty wynik
    - Wersję Zoo Code (wymagana)
    - Dostawcę API i model, jeśli mają znaczenie
- **Problemy z bezpieczeństwem**: Zgłaszaj je prywatnie przez [security advisories](https://github.com/Zoo-Code-Org/Zoo-Code/security/advisories/new).

<a id="development--submission-process"></a>

## Praca nad zmianą i jej przesłanie

<a id="development-setup"></a>

### Przygotowanie środowiska

1. **Utwórz fork i sklonuj:**

```
git clone https://github.com/YOUR_USERNAME/Zoo-Code.git
```

2. **Zainstaluj zależności:**

```
pnpm install
```

3. **Debugowanie:** Otwórz w VS Code (`F5`).

<a id="writing-code-guidelines"></a>

### Wskazówki dotyczące kodu

- Przygotuj jeden skupiony PR na funkcję lub poprawkę.
- Stosuj dobre praktyki ESLint i TypeScript.
- Pisz jasne, opisowe commity z odniesieniem do zgłoszeń (na przykład `Fixes #123`). Stosuj [styl pisania](#writing-style).
- Dokładnie przetestuj zmianę (`npm test`).
- Przed przesłaniem wykonaj rebase na najnowszą gałąź `main`.

<a id="submitting-a-pull-request"></a>

### Przesłanie Pull Requesta

- Zacznij od **Draft PR**, jeśli chcesz otrzymać wczesne uwagi.
- Opisz zmiany za pomocą Pull Request Template. Stosuj [styl pisania](#writing-style).
- Dodaj link do zgłoszenia w opisie lub tytule PR-a (na przykład "Fixes #123").
- Do zmian UI dodaj zrzuty ekranu lub filmy.
- Wskaż, czy zmiana wymaga aktualizacji dokumentacji.

<a id="pull-request-policy"></a>

### Zasady dotyczące Pull Requestów

- PR musi odnosić się do przydzielonego zgłoszenia w GitHub. Aby otrzymać przydział, dodaj komentarz "Claiming" w zgłoszeniu. Następnie skontaktuj się z głównym zespołem na [Discordzie](https://discord.gg/VxfP4Vx3gX). Zespół potwierdza przydział w wątku.
- Możemy zamknąć PR bez linku.
- PR musi przejść testy CI, być zgodny z planem rozwoju i mieć jasną dokumentację.

<a id="review-process"></a>

### Proces przeglądu

PR gotowy do przeglądu musi spełniać te warunki:

- Przechodzi wymagane kontrole CI.
- Uwzględnia uwagi z przeglądu, które wymagają działania.
- Otrzymuje nowe zatwierdzenie od opiekuna lub CODEOWNER. Następuje to po zakończeniu automatycznego przeglądu najnowszego commita.

Automatyczny przegląd może dodać komentarz ze wskazówkami i zarządzane etykiety stanu. Wykonaj następny krok wskazany w komentarzu. Nie zmieniaj etykiet samodzielnie. Nowe commity resetują stan przeglądu zmienionego kodu.

Etykieta `community-approved` oznacza nowe zatwierdzenie najnowszego commita przez społeczność. PR czeka wtedy na przegląd opiekuna. Etykieta jest wskazówką dla opiekunów przy ustalaniu priorytetów. Nie zastępuje przeglądu opiekuna ani wymaganej kontroli. Etykietą zarządza przepływ przeglądu.

Automatyczny przegląd pomaga opiekunom. Nie zastępuje zatwierdzenia przez człowieka. Zewnętrzni współtwórcy nie mogą wydawać CodeRabbit poleceń w komentarzach. Przegląd spełniający warunki uruchamia się ponownie sam, gdy wymagane CI zakończy się pomyślnie. Opiekunowie obsługują wyjątkowe ponowne uruchomienia. Ostrzeżenia są wskazówkami, chyba że zasady repozytorium stanowią inaczej. Wbudowane wymagane kontrole GitHub, reguły CODEOWNER i zabezpieczenia przeglądu decydują, czy można scalić PR.

- **Codzienna selekcja:** Opiekunowie wykonują szybkie kontrole.
- **Cotygodniowy dokładny przegląd:** Opiekunowie wykonują pełną ocenę.
- **Wprowadzaj poprawki szybko**, gdy otrzymasz uwagi.

<a id="pull-request-expectations"></a>

### Oczekiwania wobec Pull Requestów

PR musi być łatwy do przeglądu, przetestowany i łatwy w utrzymaniu. Zanim otworzysz PR, sprawdź te punkty:

- Zmiana dotyczy jednego konkretnego zgłoszenia, błędu lub ulepszenia.
- Potrafisz wyjaśnić, co robi zmiana i dlaczego jest poprawna.
- Zmiana została przetestowana na twoim komputerze, jeśli było to możliwe.
- Odpowiesz na uwagi z przeglądu i wprowadzisz rozsądne dalsze poprawki.
- Opiekunowie nie muszą przepisywać, przeprojektowywać ani przejmować zmiany przed jej scaleniem.

Opiekunowie mogą zamknąć PR z tych powodów:

- Jest niekompletny.
- Ma zbyt szeroki zakres.
- Jest nieaktywny.
- Nie odpowiada kierunkowi projektu.
- Tworzy zbyt dużo pracy przy przeglądzie lub utrzymaniu.

Zamknięcie PR-a nie jest oceną współtwórcy. Oznacza, że opiekunowie nie mogą przyjąć zmiany w obecnej formie.

Bot również automatycznie zamyka PR-y:

- **60 dni bez aktywności:** Bot oznacza PR jako nieaktywny po 60 dniach bez aktywności. Jeśli przez kolejne 7 dni nadal nie ma aktywności, zamyka PR. Nowy komentarz, commit lub przegląd resetuje licznik.
- **14 dni bez aktywności autora:** Gdy osoba przeglądająca prosi o zmiany, bot dodaje etykietę `awaiting-author`. Aktywność autora resetuje licznik nieaktywności. Gdy zmiany są gotowe, poproś o nowy przegląd.

Aby zatrzymać automatyczne zamknięcie PR-a, dodaj etykietę `do-not-close`, `pinned` lub `work-in-progress`.

<a id="ai-assisted-contributions"></a>

### Wkład z pomocą AI

Możesz używać narzędzi AI. Nadal ponosisz pełną odpowiedzialność za to, co przesyłasz.

Jeśli korzystasz z narzędzi AI przy tworzeniu PR-a, musisz:

- Przejrzeć i zrozumieć każdą ważną zmianę.
- Wyjaśnić implementację i kompromisy własnymi słowami.
- Samodzielnie przetestować zmianę. Jeśli nie możesz wykonać testów w swoim środowisku, wyjaśnij powód w opisie PR-a. Opisz też, jak osoby przeglądające mogą zweryfikować zmianę.
- Sprawdzić, czy wygenerowany kod jest poprawny, potrzebny i zgodny z licencją projektu.
- Rozważyć poinformowanie o pomocy AI w opisie PR-a. Zrób to, gdy AI znacząco zmieniło kod, testy lub projekt rozwiązania. Pomaga to osobom przeglądającym przekazać lepsze uwagi.

Nie przesyłaj zmian wygenerowanych przez AI, których nie rozumiesz. Nie przesyłaj zmian, których nie możesz utrzymywać podczas przeglądu. Opiekunowie mogą zamknąć PR, który wygląda na przygotowany z dużą pomocą AI. Mogą to zrobić, jeśli brakuje weryfikacji przez człowieka, jasnego powodu lub dalszej współpracy przy przeglądzie.

<a id="writing-style"></a>

### Styl pisania

Te zasady dotyczą tylko tekstów w języku angielskim. Pisz tytuły i treść zgłoszeń, tytuły i opisy PR-ów oraz wiadomości commitów w Simplified Technical English (ASD-STE100). Zobacz [ASD-STE100](https://www.asd-ste100.org/). Szablony zgłoszeń i PR-ów zawierają takie samo przypomnienie.

- Używaj krótkich zdań. Instrukcja powinna mieć najwyżej 20 słów.
- Używaj prostych słów. Pisz "use", nie "utilize". Pisz "start", nie "commence".
- Używaj strony czynnej. Pisz "the parser reads the file", nie "the file is read by the parser".
- W każdym zdaniu przedstawiaj jedną myśl.
- Nie używaj form skróconych, średników ani długich myślników.
- Tytuł powinien być krótki i konkretny.
- Nie zmieniaj dokładnych logów, komunikatów błędów, identyfikatorów, poleceń ani dowodów odtworzenia problemu. Wklejaj je bez zmian.

Te zasady to wskazówki dotyczące pisania po angielsku. Osoby przeglądające nie sprawdzają formalnej zgodności z ASD-STE100. Kod, identyfikatory i składnia poleceń nie podlegają tej zasadzie.

<a id="legal"></a>

## Kwestie prawne

Wnosząc wkład, zgadzasz się na objęcie go licencją Apache 2.0. To licencja Zoo Code.
