<p align="center">
          <a href="https://marketplace.visualstudio.com/items?itemName=ZooCodeOrganization.zoo-code"><img src="https://img.shields.io/badge/VS_Code_Marketplace-007ACC?style=flat&logo=visualstudiocode&logoColor=white" alt="VS Code Marketplace"></a>
          <a href="https://x.com/ZooCodeDev"><img src="https://img.shields.io/badge/ZooCode-000000?style=flat&logo=x&logoColor=white" alt="X"></a>
          <a href="https://discord.gg/VxfP4Vx3gX"><img src="https://img.shields.io/badge/Join%20Discord-5865F2?style=flat&logo=discord&logoColor=white" alt="Join Discord"></a>
          <a href="https://www.reddit.com/r/ZooCode/"><img src="https://img.shields.io/badge/Join%20r%2FZooCode-FF4500?style=flat&logo=reddit&logoColor=white" alt="Join r/ZooCode"></a>
          <a href="https://github.com/Zoo-Code-Org/Zoo-Code/issues"><img src="https://img.shields.io/badge/GitHub-Issues-181717?style=flat&logo=github&logoColor=white" alt="GitHub Issues"></a>
        </p>
        <p align="center">
          <em>Schnelle Hilfe → <a href="https://discord.gg/VxfP4Vx3gX">Discord beitreten</a> • Lieber asynchron? → <a href="https://www.reddit.com/r/ZooCode/">r/ZooCode beitreten</a></em>
        </p>

        # Zoo Code

        > Dein KI-gestütztes Dev-Team – direkt in deinem Editor

        ## Wir sind Zoo Code

> Zoo Code führt die Entwicklung dieses Projekts fort, nachdem das Roo-Team
> die aktive Arbeit an Roo Code eingestellt hat, um sich auf
> [Roomote](https://roomote.dev/) zu konzentrieren. Danke an das Roo-Team für
> alles, was sie aufgebaut haben.
>
> Das Kernteam besteht aus Entwicklern, die zuvor zu Roo beigetragen haben und
> dieses Plugin sehr schätzen. Wir werden weiterhin Modelle aktualisieren,
> Fehler beheben und neue Funktionen veröffentlichen, und wir haben vor,
> genau auf die Community zu hören, die dieses Plugin so besonders gemacht
> hat. Schließ dich uns an auf
> [Discord](https://discord.gg/VxfP4Vx3gX),
> [Reddit](https://www.reddit.com/r/ZooCode), oder
> [eröffne eine PR oder ein Issue](https://github.com/Zoo-Code-Org/Zoo-Code).
>
> _-Zoo Code Team_

## Migration von Roo Code zu Zoo Code

Eine kurze Anleitung für den Wechsel von Roo Code zu Zoo Code findest du im [Roo→Zoo-Migrationsleitfaden](https://docs.zoocode.dev/roo-to-zoo-migration). Wir wollen Nutzer beim Umstieg so gut wie möglich unterstützen, und genau dafür sind unser [Reddit](https://www.reddit.com/r/ZooCode) und [Discord](https://discord.gg/VxfP4Vx3gX) da. Wenn du Probleme hast oder Fragen auftauchen, komm vorbei und frag nach.

## Was Zoo Code seit Roo Code hinzugefügt hat

Zoo Code baut auf dem von Roo Code geschaffenen Fundament auf und erweitert es fortlaufend um:

- **Semble-Codebasisintelligenz** — schnelle semantische Codesuche bei Bedarf, mit automatischer Einrichtung und ohne separaten Indizierungsablauf.
- **Stärkere Orchestrator-Workflows** — sicherere Delegation, parallele Aufgabenkoordination, zuverlässige Wiederherstellung von über- und untergeordneten Aufgaben sowie bessere Isolierung zwischen Unteraufgaben und Anbieterprofilen.
- **Längere autonome Läufe mit Destructive Command Guard (DCG)** — gefährliche Befehle werden automatisch blockiert, während vertrauenswürdige Arbeit ohne wiederholte Genehmigungsaufforderungen weiterläuft.
- **Die neuesten Modelle** — fortlaufende Unterstützung für neue Modellfamilien von Claude, GPT, Gemini, Kimi, GLM, Grok, MiniMax und weiteren.
- **Mehr Verbindungsmöglichkeiten** — neue und erweiterte Anbieter, darunter Zoo Gateway, Moonshot, Kimi Code, Kenari, Friendli, OpenCode Go und viele mehr.
- **Zuverlässigere Terminal- und Bearbeitungsabläufe** — Korrekturen für vorzeitige Terminalabschlüsse, Race Conditions beim Aufgabenstatus, Kontextverwaltung, diff-Bearbeitung und anbieterspezifische Tool-Nutzung.
- **Mehr Kontrolle über deinen Workspace** — Regelverwaltung, MCP-Beschränkungen pro Modus, Pfadsteuerung für Multi-Root-Workspaces, Reasoning-Optionen für Modelle und Aktionen zur Prüfung von Änderungen nach Abschluss.

## Neu in v3.78.0

- **Drei bedeutende neue Modelle sind da** — nutze die brandneuen Modelle Gemini 3.7 Flash, GLM 5.3 und Qwen3.8 Max sowie aktualisiertes Reasoning, Preise und Anbieterabdeckung für DeepSeek V4.
- **Verbinde dich mit NanoGPT** — nutze dynamische Modellerkennung, Streaming und Prompt-Vervollständigung sowie Routing-Einstellungen für Geschwindigkeit, Preis, Latenz, Durchsatz, Tool-Unterstützung und Caching.
- **Zuverlässigere Anbieter und Aufgaben** — Korrekturen verbessern die Einrichtung von Azure-OpenAI-Endpunkten, Kimi-Code-Ausgabelimits, die Beibehaltung von Titeln im Aufgabenverlauf sowie den Import und Export von Zoo-Einstellungen.
- Destructive Command Guard unterstützt jetzt Intel-basierte Macs.
- Sicherheitsupdates beheben Schwachstellen in `undici` und Mermaid.

## Was kann Zoo Code für DICH tun?

- Code aus natürlichsprachlichen Beschreibungen generieren
- Anpassung mit Modi: Code, Architekt, Fragen, Debuggen und benutzerdefinierte Modi
- Bestehenden Code refaktorisieren & debuggen
- Dokumentation schreiben & aktualisieren
- Fragen zu deiner Codebasis beantworten
- Wiederkehrende Aufgaben automatisieren
- MCP-Server nutzen

## Modi

Zoo Code passt sich an deine Arbeitsweise an, nicht umgekehrt:

- Code-Modus: tägliches Codieren, Bearbeitungen und Dateioperationen
- Architekten-Modus: Systeme, Spezifikationen und Migrationen planen
- Fragen-Modus: schnelle Antworten, Erklärungen und Dokumentationen
- Debug-Modus: Probleme aufspüren, Protokolle hinzufügen, Ursachen isolieren
- Benutzerdefinierte Modi: erstelle spezialisierte Modi für dein Team oder deinen Workflow

Mehr erfahren: [Modi verwenden](https://docs.zoocode.dev/basic-usage/using-modes) • [Benutzerdefinierte Modi](https://docs.zoocode.dev/advanced-usage/custom-modes)

## Ressourcen

- **[Dokumentation](https://docs.zoocode.dev):** Die offizielle Anleitung zur Installation, Konfiguration und Beherrschung von Zoo Code.
- **[Discord-Server](https://discord.gg/VxfP4Vx3gX):** Tritt der Community bei für Echtzeit-Hilfe und Diskussionen.
- **[Reddit-Community](https://www.reddit.com/r/ZooCode):** Teile deine Erfahrungen und sieh, was andere bauen.
- **[GitHub Issues](https://github.com/Zoo-Code-Org/Zoo-Code/issues):** Melde Fehler und verfolge die Entwicklung.
- **[Feature-Anfragen](https://github.com/Zoo-Code-Org/Zoo-Code/discussions/categories/feature-requests?discussions_q=is%3Aopen+category%3A%22Feature+Requests%22+sort%3Atop):** Hast du eine Idee? Teile sie mit den Entwicklern.

---

## Lokales Setup & Entwicklung

1. **Klone** das Repo:

```sh
git clone https://github.com/Zoo-Code-Org/Zoo-Code.git
```

2. **Installiere die Abhängigkeiten**:

```sh
pnpm install
```

3. **Führe die Erweiterung aus**:

Es gibt mehrere Möglichkeiten, die Zoo Code-Erweiterung auszuführen:

### Entwicklungsmodus (F5)

Für die aktive Entwicklung verwende das integrierte Debugging von VSCode:

Drücke `F5` (oder gehe zu **Ausführen** → **Debuggen starten**) in VSCode. Dies öffnet ein neues VSCode-Fenster mit der laufenden Zoo Code-Erweiterung.

- Änderungen an der Webview werden sofort angezeigt.
- Änderungen an der Kern-Erweiterung werden ebenfalls automatisch per Hot-Reload neu geladen.

### Automatisierte VSIX-Installation

Um die Erweiterung als VSIX-Paket zu erstellen und direkt in VSCode zu installieren:

```sh
pnpm install:vsix [-y] [--editor=<command>]
```

Dieser Befehl wird:

- Fragen, welcher Editor-Befehl verwendet werden soll (code/cursor/code-insiders) - standardmäßig 'code'
- Jede vorhandene Version der Erweiterung deinstallieren.
- Das neueste VSIX-Paket erstellen.
- Das neu erstellte VSIX installieren.
- Dich auffordern, VS Code neu zu starten, damit die Änderungen wirksam werden.

Optionen:

- `-y`: Alle Bestätigungsaufforderungen überspringen und Standardwerte verwenden
- `--editor=<command>`: Gib den Editor-Befehl an (z. B. `--editor=cursor` oder `--editor=code-insiders`)

### Manuelle VSIX-Installation

Wenn du das VSIX-Paket lieber manuell installieren möchtest:

1.  Erstelle zuerst das VSIX-Paket:
    ```sh
    pnpm vsix
    ```
2.  Eine `.vsix`-Datei wird im `bin/`-Verzeichnis generiert (z. B. `bin/zoo-code-<version>.vsix`).
3.  Installiere sie manuell mit der VSCode-Befehlszeilenschnittstelle:
    ```sh
    code --install-extension bin/zoo-code-<version>.vsix
    ```

---

Wir verwenden [changesets](https://github.com/changesets/changesets) für die Versionierung und Veröffentlichung. Schau in unsere `CHANGELOG.md` für Versionshinweise.

---

## Haftungsausschluss

**Bitte beachte**, dass Zoo Code **keine** Zusicherungen oder Garantien in Bezug auf Code, Modelle oder andere Werkzeuge gibt, die in Verbindung mit Zoo Code, zugehörigen Drittanbieter-Werkzeugen oder den daraus resultierenden Ergebnissen bereitgestellt oder zugänglich gemacht werden. Du übernimmst **alle Risiken**, die mit der Nutzung solcher Werkzeuge oder Ergebnisse verbunden sind; diese Werkzeuge werden auf einer **"WIE BESEHEN"**- und **"WIE VERFÜGBAR"**-Basis bereitgestellt. Solche Risiken können unter anderem die Verletzung von geistigem Eigentum, Cyber-Schwachstellen oder -Angriffe, Voreingenommenheit, Ungenauigkeiten, Fehler, Defekte, Viren, Ausfallzeiten, Eigentumsverluste oder -schäden und/oder Personenschäden umfassen. Du bist allein verantwortlich für deine Nutzung solcher Werkzeuge oder Ergebnisse (einschließlich, aber nicht beschränkt auf deren Rechtmäßigkeit, Angemessenheit und Ergebnisse).

---

## Mitwirken

Wir lieben Community-Beiträge! Lies unsere [CONTRIBUTING.md](CONTRIBUTING.md), um loszulegen.

---

## Lizenz

[Apache 2.0 © 2025 Zoo Code Org](../../LICENSE)

---

**Viel Spaß mit Zoo Code!** Egal, ob du ihn an der kurzen Leine hältst oder autonom losziehen lässt, wir freuen uns darauf zu sehen, was du baust. Wenn du Fragen oder Ideen für Funktionen hast, eröffne ein [Issue](https://github.com/Zoo-Code-Org/Zoo-Code/issues) oder starte eine [Diskussion](https://github.com/Zoo-Code-Org/Zoo-Code/discussions). Viel Spaß beim Coden!
