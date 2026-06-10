<div align="center">
<sub>

[English](../../CONTRIBUTING.md) • [Català](../ca/CONTRIBUTING.md) • <b>Deutsch</b> • [Español](../es/CONTRIBUTING.md) • [Français](../fr/CONTRIBUTING.md) • [हिंदी](../hi/CONTRIBUTING.md) • [Bahasa Indonesia](../id/CONTRIBUTING.md) • [Italiano](../it/CONTRIBUTING.md) • [日本語](../ja/CONTRIBUTING.md)

</sub>
<sub>

[한국어](../ko/CONTRIBUTING.md) • [Nederlands](../nl/CONTRIBUTING.md) • [Polski](../pl/CONTRIBUTING.md) • [Português (BR)](../pt-BR/CONTRIBUTING.md) • [Русский](../ru/CONTRIBUTING.md) • [Türkçe](../tr/CONTRIBUTING.md) • [Tiếng Việt](../vi/CONTRIBUTING.md) • [简体中文](../zh-CN/CONTRIBUTING.md) • [繁體中文](../zh-TW/CONTRIBUTING.md)

</sub>
</div>

# Beitrag zu Zoo Code

Zoo Code ist ein von der Community getragenes Projekt, und wir schätzen jeden Beitrag sehr. Um die Zusammenarbeit zu optimieren, arbeiten wir nach dem [Issue-First-Ansatz](#issue-first-ansatz), was bedeutet, dass alle [Pull Requests (PRs)](#einen-pull-request-einreichen) zuerst mit einem GitHub-Issue verknüpft sein müssen. Bitte lies diesen Leitfaden sorgfältig durch.

## Inhaltsverzeichnis

- [Bevor du beiträgst](#bevor-du-beiträgst)
- [Deinen Beitrag finden und planen](#deinen-beitrag-finden-und-planen)
- [Entwicklungs- und Einreichungsprozess](#entwicklungs-und-einreichungsprozess)
- [Anforderungen an Pull Requests](#anforderungen-an-pull-requests)
- [KI-gestützte Beiträge](#ki-gestützte-beiträge)
- [Rechtliches](#rechtliches)

## Bevor du beiträgst

### 1. Verhaltenskodex

Alle Mitwirkenden müssen sich an unseren [Verhaltenskodex](./CODE_OF_CONDUCT.md) halten.

### 2. Projekt-Roadmap

Unsere Roadmap gibt die Richtung des Projekts vor. Richte deine Beiträge an diesen Hauptzielen aus:

### Zuverlässigkeit an erster Stelle

- Stelle sicher, dass die Diff-Bearbeitung und die Befehlsausführung durchweg zuverlässig sind.
- Reduziere Reibungspunkte, die von der regelmäßigen Nutzung abhalten.
- Gewährleiste einen reibungslosen Betrieb in allen Gebietsschemata und auf allen Plattformen.
- Erweitere die robuste Unterstützung für eine Vielzahl von KI-Anbietern und -Modellen.

### Verbesserte Benutzererfahrung

- Optimiere die UI/UX für Klarheit und Intuitivität.
- Verbessere kontinuierlich den Arbeitsablauf, um den hohen Erwartungen gerecht zu werden, die Entwickler an täglich genutzte Werkzeuge haben.

### Führend in der Agentenleistung

- Etabliere umfassende Bewertungsmaßstäbe (evals), um die Produktivität in der Praxis zu messen.
- Mache es für jeden einfach, diese Bewertungen auszuführen und zu interpretieren.
- Liefere Verbesserungen, die klare Steigerungen der Bewertungsergebnisse zeigen.

Erwähne die Ausrichtung auf diese Bereiche in deinen PRs.

### 3. Tritt der Zoo Code Community bei

- **Discord:** Tritt unserem [Discord](https://discord.gg/VxfP4Vx3gX) bei.
- **Reddit:** Tritt unserem [Reddit](https://www.reddit.com/r/ZooCode/) bei.

## Deinen Beitrag finden und planen

### Arten von Beiträgen

- **Fehlerbehebungen:** Behebung von Code-Problemen.
- **Neue Funktionen:** Hinzufügen von Funktionalität.
- **Dokumentation:** Verbesserung von Anleitungen und Klarheit.

### Issue-First-Ansatz

Alle Beiträge beginnen mit einem GitHub-Issue unter Verwendung unserer schlanken Vorlagen.

- **Überprüfe bestehende Issues**: Suche in den [GitHub Issues](https://github.com/Zoo-Code-Org/Zoo-Code/issues).
- **Erstelle ein Issue** mit:
    - **Verbesserungen:** Vorlage „Verbesserungsvorschlag“ (einfache Sprache mit Fokus auf den Nutzen für den Benutzer).
    - **Fehler:** Vorlage „Fehlerbericht“ (minimale Reproduktion + erwartet vs. tatsächlich + Version).
- **Möchtest du daran arbeiten?** Kommentiere „Claiming“ im Issue und schreibe dem Core-Team eine DM auf [Discord](https://discord.gg/VxfP4Vx3gX), um zugewiesen zu werden. Die Zuweisung wird im Thread bestätigt.
- **PRs müssen auf das Issue verweisen.** Nicht verknüpfte PRs können geschlossen werden.

### Entscheiden, woran du arbeiten möchtest

- Prüfe die [GitHub-Issues-Seite](https://github.com/Zoo-Code-Org/Zoo-Code/issues) auf Issues.
- Für Dokumentation besuche [Zoo Code Docs](https://github.com/Zoo-Code-Org/Zoo-Code-Docs).

### Fehler melden

- Überprüfe zuerst, ob bereits Berichte vorhanden sind.
- Erstelle einen neuen Fehler mit der [Vorlage „Fehlerbericht“](https://github.com/Zoo-Code-Org/Zoo-Code/issues/new/choose) mit:
    - Klaren, nummerierten Reproduktionsschritten
    - Erwartetes vs. tatsächliches Ergebnis
    - Zoo Code-Version (erforderlich); API-Anbieter/Modell, falls relevant
- **Sicherheitsprobleme**: Melde sie privat über [Sicherheitshinweise](https://github.com/Zoo-Code-Org/Zoo-Code/security/advisories/new).

## Entwicklungs- und Einreichungsprozess

### Entwicklungseinrichtung

1. **Fork & Klonen:**

```
git clone https://github.com/YOUR_USERNAME/Zoo-Code.git
```

2. **Abhängigkeiten installieren:**

```
pnpm install
```

3. **Debugging:** Mit VS Code öffnen (`F5`).

### Richtlinien zum Schreiben von Code

- Ein fokussierter PR pro Funktion oder Fehlerbehebung.
- Befolge die Best Practices von ESLint und TypeScript.
- Schreibe klare, beschreibende Commits mit Verweis auf Issues (z. B. `Fixes #123`).
- Stelle gründliche Tests bereit (`npm test`).
- Rebase auf den neuesten `main`-Zweig vor der Einreichung.

### Einen Pull Request einreichen

- Beginne als **Entwurfs-PR**, wenn du frühzeitig Feedback einholen möchtest.
- Beschreibe deine Änderungen klar und deutlich gemäß der Pull-Request-Vorlage.
- Verknüpfe das Issue in der PR-Beschreibung/Titel (z. B. „Fixes #123“).
- Stelle Screenshots/Videos für UI-Änderungen bereit.
- Gib an, ob Dokumentationsaktualisierungen erforderlich sind.

### Pull-Request-Richtlinie

- Muss auf ein zugewiesenes GitHub-Issue verweisen. Um zugewiesen zu werden: Kommentiere „Claiming“ im Issue und schreibe dem Core-Team eine DM auf [Discord](https://discord.gg/VxfP4Vx3gX). Die Zuweisung wird im Thread bestätigt.
- Nicht verknüpfte PRs können geschlossen werden.
- PRs müssen die CI-Tests bestehen, mit der Roadmap übereinstimmen und eine klare Dokumentation haben.

### Überprüfungsprozess

- **Tägliche Triage:** Schnelle Überprüfungen durch die Betreuer.
- **Wöchentliche ausführliche Überprüfung:** Umfassende Bewertung.
- **Iteriere umgehend** basierend auf dem Feedback.

### Anforderungen an Pull Requests

Pull Requests müssen überprüfbar, getestet und wartbar sein. Stelle vor dem Öffnen eines PRs sicher, dass:

- Die Änderung auf ein bestimmtes Issue, einen Bug oder eine Verbesserung beschränkt ist.
- Du erklären kannst, was die Änderung bewirkt und warum sie korrekt ist.
- Du die Änderung lokal getestet hast, soweit praktisch möglich.
- Du bereit bist, auf Review-Feedback zu antworten und angemessene Folgeanpassungen vorzunehmen.
- Der PR nicht erfordert, dass Betreuer die Implementierung vor dem Mergen wesentlich umschreiben, neu gestalten oder übernehmen.

Betreuer können PRs schließen, die unvollständig, zu umfangreich, inaktiv, nicht mit der Projektrichtung abgestimmt sind oder einen unverhältnismäßigen Review- oder Wartungsaufwand verursachen. Das Schließen eines PRs ist kein Urteil über den Beitragenden; es ist eine Entscheidung der Betreuer, dass die Änderung in ihrer aktuellen Form nicht akzeptiert werden kann.

### KI-gestützte Beiträge

Die Verwendung von KI-Tools ist erlaubt, aber Beitragende tragen die volle Verantwortung für ihre Einreichungen.

Wenn du KI-Tools zur Erstellung eines PRs verwendest, musst du:

- Jede wesentliche Änderung überprüfen und verstehen.
- Die Implementierung und die Kompromisse in eigenen Worten erklären können.
- Die Änderung selbst testen. Wenn Tests in deiner Umgebung nicht praktisch durchführbar sind, erkläre warum in der PR-Beschreibung und beschreibe, wie Reviewer die Änderung stattdessen überprüfen können.
- Sicherstellen, dass der generierte Code korrekt, notwendig und mit der Projektlizenz kompatibel ist.
- Erwäge, KI-Unterstützung in der PR-Beschreibung offenzulegen, wenn sie den Code, die Tests oder das Design wesentlich beeinflusst hat — das hilft Reviewern, besseres Feedback zu geben.

Bitte reiche keine KI-generierten Änderungen ein, die du nicht verstehst oder die du nicht durch den Review-Prozess pflegen kannst. Betreuer können PRs schließen, die überwiegend KI-gestützt erscheinen, aber keine menschliche Überprüfung, klare Begründung oder Review-Nachverfolgung aufweisen.

## Rechtliches

Indem du einen Beitrag leistest, stimmst du zu, dass deine Beiträge unter der Apache-2.0-Lizenz lizenziert werden, die mit der Lizenzierung von Zoo Code übereinstimmt.
