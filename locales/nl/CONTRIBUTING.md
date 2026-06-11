<div align="center">
<sub>

[English](../../CONTRIBUTING.md) • [Català](../ca/CONTRIBUTING.md) • [Deutsch](../de/CONTRIBUTING.md) • [Español](../es/CONTRIBUTING.md) • [Français](../fr/CONTRIBUTING.md) • [हिंदी](../hi/CONTRIBUTING.md) • [Bahasa Indonesia](../id/CONTRIBUTING.md) • [Italiano](../it/CONTRIBUTING.md) • [日本語](../ja/CONTRIBUTING.md)

</sub>
<sub>

[한국어](../ko/CONTRIBUTING.md) • <b>Nederlands</b> • [Polski](../pl/CONTRIBUTING.md) • [Português (BR)](../pt-BR/CONTRIBUTING.md) • [Русский](../ru/CONTRIBUTING.md) • [Türkçe](../tr/CONTRIBUTING.md) • [Tiếng Việt](../vi/CONTRIBUTING.md) • [简体中文](../zh-CN/CONTRIBUTING.md) • [繁體中文](../zh-TW/CONTRIBUTING.md)

</sub>
</div>

# Bijdragen aan Zoo Code

Zoo Code is een door de gemeenschap gedreven project en we waarderen elke bijdrage ten zeerste. Om de samenwerking te stroomlijnen, werken we op basis van een [Issue-First-aanpak](#issue-first-aanpak), wat betekent dat alle [Pull Requests (PR's)](#een-pull-request-indienen) eerst gekoppeld moeten zijn aan een GitHub Issue. Lees deze handleiding zorgvuldig door.

## Inhoudsopgave

- [Voordat je bijdraagt](#voordat-je-bijdraagt)
- [Je bijdrage vinden en plannen](#je-bijdrage-vinden-en-plannen)
- [Ontwikkelings- en indieningsproces](#ontwikkelings-en-indieningsproces)
- [Verwachtingen voor Pull Requests](#verwachtingen-voor-pull-requests)
- [Door AI ondersteunde bijdragen](#door-ai-ondersteunde-bijdragen)
- [Juridisch](#juridisch)

## Voordat je bijdraagt

### 1. Gedragscode

Alle bijdragers moeten zich houden aan onze [Gedragscode](./CODE_OF_CONDUCT.md).

### 2. Projectroadmap

Onze roadmap stuurt de richting van het project. Lijn je bijdragen uit met deze belangrijke doelen:

### Betrouwbaarheid voorop

- Zorg ervoor dat het bewerken van diffs en het uitvoeren van commando's consistent betrouwbaar zijn.
- Verminder wrijvingspunten die regelmatig gebruik ontmoedigen.
- Garandeer een soepele werking in alle locales en op alle platforms.
- Breid robuuste ondersteuning uit voor een breed scala aan AI-providers en -modellen.

### Verbeterde gebruikerservaring

- Stroomlijn de UI/UX voor duidelijkheid en intuïtiviteit.
- Verbeter continu de workflow om te voldoen aan de hoge verwachtingen die ontwikkelaars hebben van dagelijks gebruikte tools.

### Toonaangevend in prestaties van agenten

- Stel uitgebreide evaluatiebenchmarks (evals) op om de productiviteit in de praktijk te meten.
- Maak het voor iedereen gemakkelijk om deze evals uit te voeren en te interpreteren.
- Lever verbeteringen die duidelijke stijgingen in de eval-scores aantonen.

Vermeld de afstemming met deze gebieden in je PR's.

### 3. Word lid van de Zoo Code-community

- **Discord:** Word lid van onze [Discord](https://discord.gg/VxfP4Vx3gX).
- **Reddit:** Word lid van onze [Reddit](https://www.reddit.com/r/ZooCode/).

## Je bijdrage vinden en plannen

### Soorten bijdragen

- **Bugfixes:** het aanpakken van codeproblemen.
- **Nieuwe functies:** het toevoegen van functionaliteit.
- **Documentatie:** het verbeteren van handleidingen en duidelijkheid.

### Issue-First-aanpak

Alle bijdragen beginnen met een GitHub Issue met behulp van onze slanke sjablonen.

- **Controleer bestaande issues**: Zoek in [GitHub Issues](https://github.com/Zoo-Code-Org/Zoo-Code/issues).
- **Maak een issue** aan met:
    - **Verbeteringen:** sjabloon "Verbeteringsverzoek" (eenvoudige taal gericht op gebruikersvoordeel).
    - **Bugs:** sjabloon "Bugrapport" (minimale repro + verwacht vs. feitelijk + versie).
- **Wil je eraan werken?** Reageer met "Claiming" op de issue en stuur een DM naar het kernteam op [Discord](https://discord.gg/VxfP4Vx3gX) om toegewezen te worden. De toewijzing wordt in de thread bevestigd.
- **PR's moeten naar de issue linken.** Niet-gekoppelde PR's kunnen worden gesloten.

### Beslissen waaraan je wilt werken

- Bekijk de [GitHub Issues-pagina](https://github.com/Zoo-Code-Org/Zoo-Code/issues) voor issues.
- Ga voor documentatie naar [Zoo Code Docs](https://github.com/Zoo-Code-Org/Zoo-Code-Docs).

### Bugs rapporteren

- Controleer eerst bestaande rapporten.
- Maak een nieuwe bug aan met het ["Bugrapport"-sjabloon](https://github.com/Zoo-Code-Org/Zoo-Code/issues/new/choose) met:
    - Duidelijke, genummerde reproductiestappen
    - Verwacht vs. feitelijk resultaat
    - Zoo Code-versie (vereist); API-provider/model indien relevant
- **Beveiligingsproblemen**: Rapporteer privé via [beveiligingsadviezen](https://github.com/Zoo-Code-Org/Zoo-Code/security/advisories/new).

## Ontwikkelings- en indieningsproces

### Ontwikkelingsopstelling

1. **Fork & Klonen:**

```
git clone https://github.com/YOUR_USERNAME/Zoo-Code.git
```

2. **Afhankelijkheden installeren:**

```
pnpm install
```

3. **Debuggen:** Openen met VS Code (`F5`).

### Richtlijnen voor het schrijven van code

- Eén gerichte PR per functie of fix.
- Volg de best practices van ESLint en TypeScript.
- Schrijf duidelijke, beschrijvende commits die verwijzen naar issues (bijv. `Fixes #123`).
- Zorg voor grondige tests (`npm test`).
- Rebase naar de nieuwste `main`-tak vóór indiening.

### Een Pull Request indienen

- Begin als een **Concept-PR** als je vroege feedback wilt.
- Beschrijf je wijzigingen duidelijk volgens het Pull Request-sjabloon.
- Koppel de issue in de PR-beschrijving/titel (bijv. "Fixes #123").
- Zorg voor schermafbeeldingen/video's voor UI-wijzigingen.
- Geef aan of documentatie-updates nodig zijn.

### Pull Request-beleid

- Moet verwijzen naar een toegewezen GitHub Issue. Om toegewezen te worden: reageer met "Claiming" op de issue en stuur een DM naar het kernteam op [Discord](https://discord.gg/VxfP4Vx3gX). De toewijzing wordt in de thread bevestigd.
- Niet-gekoppelde PR's kunnen worden gesloten.
- PR's moeten slagen voor CI-tests, in lijn zijn met de roadmap en duidelijke documentatie hebben.

### Beoordelingsproces

- **Dagelijkse triage:** Snelle controles door onderhouders.
- **Wekelijkse diepgaande beoordeling:** Uitgebreide beoordeling.
- **Itereer snel** op basis van feedback.

### Verwachtingen voor Pull Requests

Pull Requests moeten beoordeelbaar, getest en onderhoudbaar zijn. Zorg er voor het openen van een PR voor dat:

- De wijziging beperkt is tot een specifiek issue, bug of verbetering.
- Je kunt uitleggen wat de wijziging doet en waarom het correct is.
- Je de wijziging lokaal hebt getest waar praktisch.
- Je bereid bent om te reageren op reviewfeedback en redelijke vervolgwijzigingen aan te brengen.
- De PR niet vereist dat onderhouders de implementatie wezenlijk herschrijven, herontwerpen of eigenaarschap overnemen voordat deze kan worden samengevoegd.

Onderhouders kunnen PR's sluiten die onvolledig, te breed, inactief, niet in lijn met de projectrichting zijn, of die een onevenredige review- of onderhoudslast creëren. Het sluiten van een PR is geen oordeel over de bijdrager; het is een beslissing van de onderhouders dat de wijziging niet kan worden geaccepteerd in zijn huidige vorm.

### Door AI ondersteunde bijdragen

Het gebruik van AI-tools is toegestaan, maar bijdragers blijven volledig verantwoordelijk voor hun inzendingen.

Als je AI-tools gebruikt om een PR te helpen maken, moet je:

- Elke significante wijziging beoordelen en begrijpen.
- De implementatie en afwegingen in eigen woorden kunnen uitleggen.
- De wijziging zelf testen. Als testen niet praktisch is in jouw omgeving, leg dan in de PR-beschrijving uit waarom en beschrijf hoe reviewers de wijziging kunnen verifiëren.
- Verifiëren dat de gegenereerde code correct, noodzakelijk en compatibel is met de projectlicentie.
- Overweeg AI-hulp te vermelden in de PR-beschrijving wanneer dit de code, tests of het ontwerp wezenlijk heeft beïnvloed — dit helpt reviewers beter feedback te geven.

Dien geen AI-gegenereerde wijzigingen in die je niet begrijpt of die je niet kunt onderhouden tijdens de review. Onderhouders kunnen PR's sluiten die overwegend AI-ondersteund lijken maar geen menselijke verificatie, duidelijke motivatie of review-opvolging hebben.

## Juridisch

Door bij te dragen, ga je ermee akkoord dat je bijdragen onder de Apache 2.0-licentie worden gelicentieerd, in overeenstemming met de licentieverlening van Zoo Code.
