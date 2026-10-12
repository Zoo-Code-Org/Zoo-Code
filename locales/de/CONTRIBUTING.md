<div align="center">
<sub>

[English](../../CONTRIBUTING.md) • [Català](../ca/CONTRIBUTING.md) • <b>Deutsch</b> • [Español](../es/CONTRIBUTING.md) • [Français](../fr/CONTRIBUTING.md) • [हिंदी](../hi/CONTRIBUTING.md) • [Bahasa Indonesia](../id/CONTRIBUTING.md) • [Italiano](../it/CONTRIBUTING.md) • [日本語](../ja/CONTRIBUTING.md)

</sub>
<sub>

[한국어](../ko/CONTRIBUTING.md) • [Nederlands](../nl/CONTRIBUTING.md) • [Polski](../pl/CONTRIBUTING.md) • [Português (BR)](../pt-BR/CONTRIBUTING.md) • [Русский](../ru/CONTRIBUTING.md) • [Türkçe](../tr/CONTRIBUTING.md) • [Tiếng Việt](../vi/CONTRIBUTING.md) • [简体中文](../zh-CN/CONTRIBUTING.md) • [繁體中文](../zh-TW/CONTRIBUTING.md)

</sub>
</div>

<a id="contributing-to-zoo-code"></a>

# Zu Zoo Code beitragen

Zoo Code ist ein Community-Projekt. Wir schätzen jeden Beitrag. Wir arbeiten nach dem [Issue-First-Ansatz](#issue-first-approach). Jeder [Pull Request (PR)](#submitting-a-pull-request) muss deshalb auf ein GitHub-Issue verweisen. Lies diesen Leitfaden sorgfältig.

<a id="table-of-contents"></a>

## Inhaltsverzeichnis

- [Bevor du beiträgst](#before-you-contribute)
- [Deinen Beitrag finden und planen](#finding--planning-your-contribution)
- [Entwicklung und Einreichung](#development--submission-process)
    - [Anforderungen an Pull Requests](#pull-request-expectations)
    - [KI-gestützte Beiträge](#ai-assisted-contributions)
    - [Schreibstil](#writing-style)
- [Rechtliches](#legal)

<a id="before-you-contribute"></a>

## Bevor du beiträgst

<a id="1-code-of-conduct"></a>

### 1. Verhaltenskodex

Alle Mitwirkenden müssen unseren [Verhaltenskodex](./CODE_OF_CONDUCT.md) befolgen.

<a id="2-project-roadmap"></a>

### 2. Projekt-Roadmap

Unsere Roadmap zeigt die Richtung des Projekts. Richte deine Beiträge an diesen Zielen aus:

<a id="reliability-first"></a>

### Zuverlässigkeit zuerst

- Sorge dafür, dass die Diff-Bearbeitung und die Befehlsausführung jedes Mal zuverlässig funktionieren.
- Beseitige Probleme, die Menschen daran hindern, Zoo Code täglich zu nutzen.
- Sorge dafür, dass Zoo Code in allen Sprachversionen und auf allen Plattformen funktioniert.
- Unterstütze mehr KI-Anbieter und Modelle.

<a id="enhanced-user-experience"></a>

### Bessere Benutzererfahrung

- Gestalte UI und UX klar und einfach bedienbar.
- Verbessere den Arbeitsablauf. Entwickler erwarten einen hohen Standard von den Werkzeugen, die sie täglich nutzen.

<a id="leading-on-agent-performance"></a>

### Führend bei der Agentenleistung

- Erstelle Evaluierungsbenchmarks (evals), die die Produktivität unter realen Bedingungen messen.
- Sorge dafür, dass sich die evals einfach ausführen und lesen lassen.
- Veröffentliche Verbesserungen, die die eval-Ergebnisse deutlich steigern.

Gib in deinen PRs an, welche dieser Bereiche die Änderung unterstützt.

<a id="3-join-the-zoo-code-community"></a>

### 3. Tritt der Zoo Code Community bei

- **Discord:** Tritt unserem [Discord](https://discord.gg/VxfP4Vx3gX) bei.
- **Reddit:** Tritt unserem [Reddit](https://www.reddit.com/r/ZooCode/) bei.

<a id="finding--planning-your-contribution"></a>

## Deinen Beitrag finden und planen

<a id="types-of-contributions"></a>

### Arten von Beiträgen

- **Fehlerbehebungen:** Behebe Probleme im Code.
- **Neue Funktionen:** Füge Funktionen hinzu.
- **Dokumentation:** Verbessere die Anleitungen und mache sie klarer.

<a id="issue-first-approach"></a>

### Issue-First-Ansatz

Jeder Beitrag beginnt mit einem GitHub-Issue. Nutze unsere kurzen Vorlagen.

- **Prüfe vorhandene Issues**: Suche in den [GitHub Issues](https://github.com/Zoo-Code-Org/Zoo-Code/issues).
- **Erstelle ein Issue** mit:
    - **Verbesserungen:** Vorlage "Enhancement Request" (einfache Sprache mit Fokus auf den Nutzen für Anwender).
    - **Fehler:** Vorlage "Bug Report" (minimale Reproduktion, erwartetes und tatsächliches Ergebnis, Version).
- **Schreibe das Issue** nach dem unten beschriebenen [Schreibstil](#writing-style).
- **Möchtest du daran arbeiten?** Kommentiere "Claiming" im Issue. Kontaktiere dann das Kernteam auf [Discord](https://discord.gg/VxfP4Vx3gX), damit es dir das Issue zuweist. Das Kernteam bestätigt die Zuweisung im Thread.
- **PRs müssen auf das Issue verweisen.** Wir können PRs ohne diesen Verweis schließen.

<a id="deciding-what-to-work-on"></a>

### Entscheiden, woran du arbeiten möchtest

- Schau auf die [GitHub-Issues-Seite](https://github.com/Zoo-Code-Org/Zoo-Code/issues).
- Für Dokumentation gehe zu [Zoo Code Docs](https://github.com/Zoo-Code-Org/Zoo-Code-Docs).

<a id="reporting-bugs"></a>

### Fehler melden

- Prüfe zuerst, ob es schon einen Bericht gibt.
- Erstelle einen neuen Fehlerbericht mit der [Vorlage "Bug Report"](https://github.com/Zoo-Code-Org/Zoo-Code/issues/new/choose) und diesen Angaben:
    - Klare, nummerierte Schritte zur Reproduktion
    - Erwartetes und tatsächliches Ergebnis
    - Zoo Code-Version (erforderlich)
    - API-Anbieter und Modell, falls relevant
- **Sicherheitsprobleme**: Melde sie privat über [Security Advisories](https://github.com/Zoo-Code-Org/Zoo-Code/security/advisories/new).

<a id="development--submission-process"></a>

## Entwicklung und Einreichung

<a id="development-setup"></a>

### Entwicklungsumgebung einrichten

1. **Fork erstellen und klonen:**

```
git clone https://github.com/YOUR_USERNAME/Zoo-Code.git
```

2. **Abhängigkeiten installieren:**

```
pnpm install
```

3. **Debugging:** Öffne das Projekt mit VS Code (`F5`).

<a id="writing-code-guidelines"></a>

### Richtlinien für Code

- Ein gezielter PR pro Funktion oder Fehlerbehebung.
- Befolge die bewährten Verfahren für ESLint und TypeScript.
- Schreibe klare, beschreibende Commits mit Verweisen auf Issues (zum Beispiel `Fixes #123`). Befolge den [Schreibstil](#writing-style).
- Teste deine Änderung gründlich (`npm test`).
- Führe vor dem Einreichen einen Rebase auf den neuesten Stand des Branches `main` durch.

<a id="submitting-a-pull-request"></a>

### Einen Pull Request einreichen

- Beginne mit einem **Entwurfs-PR**, wenn du früh Rückmeldungen möchtest.
- Beschreibe deine Änderungen mit dem Pull Request Template. Befolge den [Schreibstil](#writing-style).
- Verlinke das Issue in der PR-Beschreibung oder im Titel (zum Beispiel "Fixes #123").
- Füge für UI-Änderungen Screenshots oder Videos hinzu.
- Gib an, ob die Änderung eine Aktualisierung der Dokumentation erfordert.

<a id="pull-request-policy"></a>

### Regeln für Pull Requests

- Der PR muss auf ein zugewiesenes GitHub-Issue verweisen. Kommentiere dafür "Claiming" im Issue. Kontaktiere dann das Kernteam auf [Discord](https://discord.gg/VxfP4Vx3gX). Das Kernteam bestätigt die Zuweisung im Thread.
- Wir können PRs ohne diesen Verweis schließen.
- Ein PR muss die CI-Tests bestehen, der Roadmap folgen und klare Dokumentation haben.

<a id="review-process"></a>

### Review-Prozess

Ein PR, der für ein Review bereit ist, muss diese Bedingungen erfüllen:

- Er besteht die erforderlichen CI-Prüfungen.
- Er berücksichtigt die Rückmeldungen aus dem Review, die Änderungen erfordern.
- Er erhält eine neue Freigabe von einem Maintainer oder CODEOWNER. Das geschieht nach dem automatisierten Review für den neuesten Commit.

Das automatisierte Review kann einen Kommentar mit Anweisungen und verwaltete Statuslabels hinzufügen. Befolge den nächsten Schritt im Kommentar. Bearbeite die Labels nicht selbst. Neue Commits setzen den Review-Status für den geänderten Code zurück.

Das Label `community-approved` zeigt eine neue Community-Freigabe für den neuesten Commit. Der PR wartet dann auf das Maintainer-Review. Das Label gibt Maintainern einen unverbindlichen Hinweis auf die Priorität. Es ersetzt weder das Maintainer-Review noch eine erforderliche Prüfung. Der Review-Workflow verwaltet das Label.

Automatisierte Reviews helfen Maintainern. Sie ersetzen keine menschliche Freigabe. Externe Mitwirkende können CodeRabbit nicht über Kommentare steuern. Ein Review, das die Voraussetzungen erfüllt, startet nach bestandener erforderlicher CI automatisch neu. Maintainer kümmern sich um Neustarts in Ausnahmefällen. Warnungen sind Hinweise, sofern die Repository-Regeln nichts anderes festlegen. Die erforderlichen GitHub-Prüfungen, CODEOWNER-Regeln und Review-Schutzregeln entscheiden, ob ein PR zusammengeführt werden kann.

- **Tägliche Sichtung:** Maintainer führen kurze Prüfungen durch.
- **Wöchentliches ausführliches Review:** Maintainer prüfen den PR vollständig.
- **Passe den PR schnell an**, wenn du Rückmeldungen bekommst.

<a id="pull-request-expectations"></a>

### Anforderungen an Pull Requests

Ein PR muss leicht zu prüfen, getestet und leicht zu warten sein. Prüfe vor dem Öffnen eines PRs diese Punkte:

- Die Änderung betrifft ein bestimmtes Issue, einen Fehler oder eine Verbesserung.
- Du kannst erklären, was die Änderung bewirkt und warum sie richtig ist.
- Du hast die Änderung auf deinem Computer getestet, soweit möglich.
- Du wirst auf Review-Rückmeldungen antworten und angemessene Folgeänderungen machen.
- Maintainer müssen die Änderung vor dem Zusammenführen nicht umschreiben, neu entwerfen oder übernehmen.

Maintainer können einen PR aus diesen Gründen schließen:

- Er ist unvollständig.
- Er ist zu umfangreich.
- Er ist inaktiv.
- Er folgt nicht der Richtung des Projekts.
- Er verursacht zu viel Review- oder Wartungsarbeit.

Das Schließen eines PRs ist kein Urteil über die Person, die ihn eingereicht hat. Es bedeutet, dass die Maintainer die Änderung so nicht annehmen können.

Ein Bot schließt PRs auch automatisch:

- **60 Tage Inaktivität:** Der Bot markiert einen PR nach 60 Tagen ohne Aktivität als inaktiv. Bleibt er weitere 7 Tage inaktiv, schließt der Bot ihn. Ein neuer Kommentar, Commit oder ein neues Review setzt den Timer zurück.
- **14 Tage Inaktivität des Autors:** Wenn ein Reviewer Änderungen anfordert, fügt der Bot das Label `awaiting-author` hinzu. Aktivität des Autors setzt den Inaktivitätstimer zurück. Bitte den Reviewer um ein neues Review, wenn die Änderungen bereit sind.

Füge das Label `do-not-close`, `pinned` oder `work-in-progress` hinzu, um das automatische Schließen eines PRs zu verhindern.

<a id="ai-assisted-contributions"></a>

### KI-gestützte Beiträge

Du darfst KI-Werkzeuge nutzen. Du bleibst für deine Einreichung vollständig verantwortlich.

Wenn du KI-Werkzeuge beim Erstellen eines PRs nutzt, musst du:

- Jede wichtige Änderung prüfen und verstehen.
- Die Umsetzung sowie Vor- und Nachteile in deinen eigenen Worten erklären.
- Die Änderung selbst testen. Wenn du sie in deiner Umgebung nicht testen kannst, erkläre den Grund in der PR-Beschreibung. Beschreibe auch, wie Reviewer die Änderung prüfen können.
- Sicherstellen, dass der erzeugte Code richtig, nötig und mit der Projektlizenz vereinbar ist.
- Überlegen, ob du die KI-Hilfe in der PR-Beschreibung erwähnst. Tue das, wenn sie Code, Tests oder Design stark verändert hat. Das hilft Reviewern, bessere Rückmeldungen zu geben.

Reiche keine KI-generierten Änderungen ein, die du nicht verstehst. Reiche keine Änderungen ein, die du während des Reviews nicht warten kannst. Maintainer können einen PR schließen, der stark KI-gestützt wirkt. Das ist möglich, wenn menschliche Prüfung, eine klare Begründung oder die weitere Mitarbeit im Review fehlen.

<a id="writing-style"></a>

### Schreibstil

Diese Regeln gelten für englische Texte. Schreibe Issue-Titel, Issue-Texte, PR-Titel, PR-Beschreibungen und Commit-Nachrichten in [Simplified Technical English (ASD-STE100)](https://www.asd-ste100.org/). Die Issue- und PR-Vorlagen enthalten denselben Hinweis.

- Nutze kurze Sätze. Eine Anweisung darf höchstens 20 Wörter haben.
- Nutze einfache Wörter. Schreibe "use", nicht "utilize". Schreibe "start", nicht "commence".
- Nutze die aktive Form. Schreibe "the parser reads the file", nicht "the file is read by the parser".
- Schreibe einen Gedanken pro Satz.
- Nutze keine Kurzformen mit Apostroph, Semikolons oder langen Gedankenstriche.
- Halte den Titel kurz und konkret.
- Ändere keine genauen Logs, Fehlermeldungen, Bezeichner, Befehle oder Belege zur Reproduktion. Füge sie unverändert ein.

Diese Regeln sind Schreibhinweise. Reviewer prüfen keine formale Einhaltung von ASD-STE100. Code, Bezeichner und Befehlssyntax fallen nicht unter diese Regel.

<a id="legal"></a>

## Rechtliches

Mit deinem Beitrag stimmst du zu, dass deine Beiträge die Apache-2.0-Lizenz verwenden. Das ist die Lizenz von Zoo Code.
