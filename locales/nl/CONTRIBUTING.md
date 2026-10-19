<div align="center">
<sub>

[English](../../CONTRIBUTING.md) • [Català](../ca/CONTRIBUTING.md) • [Deutsch](../de/CONTRIBUTING.md) • [Español](../es/CONTRIBUTING.md) • [Français](../fr/CONTRIBUTING.md) • [हिंदी](../hi/CONTRIBUTING.md) • [Bahasa Indonesia](../id/CONTRIBUTING.md) • [Italiano](../it/CONTRIBUTING.md) • [日本語](../ja/CONTRIBUTING.md)

</sub>
<sub>

[한국어](../ko/CONTRIBUTING.md) • <b>Nederlands</b> • [Polski](../pl/CONTRIBUTING.md) • [Português (BR)](../pt-BR/CONTRIBUTING.md) • [Русский](../ru/CONTRIBUTING.md) • [Türkçe](../tr/CONTRIBUTING.md) • [Tiếng Việt](../vi/CONTRIBUTING.md) • [简体中文](../zh-CN/CONTRIBUTING.md) • [繁體中文](../zh-TW/CONTRIBUTING.md)

</sub>
</div>

<a id="contributing-to-zoo-code"></a>

# Bijdragen aan Zoo Code

Zoo Code is een communityproject. We waarderen elke bijdrage. We werken volgens de [Issue-First-aanpak](#issue-first-approach). Elke [Pull Request (PR)](#submitting-a-pull-request) moet dus naar een GitHub Issue verwijzen. Lees deze gids goed.

<a id="table-of-contents"></a>

## Inhoudsopgave

- [Voordat je bijdraagt](#before-you-contribute)
- [Je bijdrage vinden en plannen](#finding--planning-your-contribution)
- [Ontwikkelen en indienen](#development--submission-process)
    - [Verwachtingen voor Pull Requests](#pull-request-expectations)
    - [Bijdragen met AI-hulp](#ai-assisted-contributions)
    - [Schrijfstijl](#writing-style)
- [Juridische zaken](#legal)

<a id="before-you-contribute"></a>

## Voordat je bijdraagt

<a id="1-code-of-conduct"></a>

### 1. Gedragscode

Alle bijdragers moeten onze [gedragscode](./CODE_OF_CONDUCT.md) volgen.

<a id="2-project-roadmap"></a>

### 2. Roadmap van het project

Onze roadmap laat de richting van het project zien. Stem je bijdragen af op deze doelen:

<a id="reliability-first"></a>

### Betrouwbaarheid voorop

- Zorg dat diff-bewerkingen en het uitvoeren van opdrachten elke keer betrouwbaar werken.
- Los de problemen op die mensen verhinderen om Zoo Code dagelijks te gebruiken.
- Laat Zoo Code werken in alle taalregio's en op alle platforms.
- Ondersteun meer AI-aanbieders en modellen.

<a id="enhanced-user-experience"></a>

### Een betere gebruikerservaring

- Maak de UI en UX duidelijk en makkelijk te gebruiken.
- Verbeter de workflow. Ontwikkelaars verwachten veel van de tools die ze dagelijks gebruiken.

<a id="leading-on-agent-performance"></a>

### Vooroplopen met agentprestaties

- Maak evaluatiebenchmarks (evals) die de productiviteit in de praktijk meten.
- Maak de evals makkelijk uit te voeren en te lezen.
- Lever verbeteringen die de evalscores duidelijk verhogen.

Geef in je PR aan welke van deze gebieden de wijziging ondersteunt.

<a id="3-join-the-zoo-code-community"></a>

### 3. Doe mee met de Zoo Code-community

- **Discord:** Doe mee op onze [Discord](https://discord.gg/VxfP4Vx3gX).
- **Reddit:** Doe mee op onze [Reddit](https://www.reddit.com/r/ZooCode/).

<a id="finding--planning-your-contribution"></a>

## Je bijdrage vinden en plannen

<a id="types-of-contributions"></a>

### Soorten bijdragen

- **Bugfixes:** Los problemen in de code op.
- **Nieuwe functies:** Voeg functies toe.
- **Documentatie:** Verbeter de gidsen en maak ze duidelijker.

<a id="issue-first-approach"></a>

### Issue-First-aanpak

Elke bijdrage begint met een GitHub Issue. Gebruik onze korte templates.

- **Controleer bestaande issues**: Zoek in [GitHub Issues](https://github.com/Zoo-Code-Org/Zoo-Code/issues).
- **Maak een issue** met:
    - **Verbeteringen:** De template "Enhancement Request" (gewone taal, gericht op het voordeel voor de gebruiker).
    - **Bugs:** De template "Bug Report" (minimale reproductie, verwacht en werkelijk resultaat, versie).
- **Schrijf het issue** volgens de [schrijfstijl](#writing-style) hieronder.
- **Wil je eraan werken?** Plaats de reactie "Claiming" bij het issue. Neem daarna op [Discord](https://discord.gg/VxfP4Vx3gX) contact op met het kernteam om het issue toegewezen te krijgen. Het kernteam bevestigt de toewijzing in de discussie.
- **PR's moeten naar het issue verwijzen.** We kunnen PR's zonder verwijzing sluiten.

<a id="deciding-what-to-work-on"></a>

### Kiezen waaraan je werkt

- Bekijk de [GitHub Issues-pagina](https://github.com/Zoo-Code-Org/Zoo-Code/issues).
- Ga voor documentatie naar [Zoo Code Docs](https://github.com/Zoo-Code-Org/Zoo-Code-Docs).

<a id="reporting-bugs"></a>

### Bugs melden

- Controleer eerst bestaande meldingen.
- Meld een nieuwe bug met de [template "Bug Report"](https://github.com/Zoo-Code-Org/Zoo-Code/issues/new/choose) en vermeld:
    - Duidelijke, genummerde stappen om de bug te reproduceren
    - Het verwachte en het werkelijke resultaat
    - De Zoo Code-versie (verplicht)
    - De API-aanbieder en het model, als die van belang zijn
- **Beveiligingsproblemen**: Meld ze privé via [security advisories](https://github.com/Zoo-Code-Org/Zoo-Code/security/advisories/new).

<a id="development--submission-process"></a>

## Ontwikkelen en indienen

<a id="development-setup"></a>

### Ontwikkelomgeving instellen

1. **Fork en kloon:**

```
git clone https://github.com/YOUR_USERNAME/Zoo-Code.git
```

2. **Installeer afhankelijkheden:**

```
pnpm install
```

3. **Debuggen:** Open met VS Code (`F5`).

<a id="writing-code-guidelines"></a>

### Richtlijnen voor code

- Maak één gerichte PR per functie of oplossing.
- Volg de best practices van ESLint en TypeScript.
- Schrijf duidelijke, beschrijvende commits die naar issues verwijzen (bijvoorbeeld `Fixes #123`). Volg de [schrijfstijl](#writing-style).
- Test je wijziging volledig (`npm test`).
- Rebase vóór het indienen op de nieuwste `main`-branch.

<a id="submitting-a-pull-request"></a>

### Een Pull Request indienen

- Begin met een **Draft PR** als je vroeg feedback wilt.
- Beschrijf je wijzigingen met de Pull Request Template. Volg de [schrijfstijl](#writing-style).
- Verwijs in de PR-beschrijving of titel naar het issue (bijvoorbeeld "Fixes #123").
- Voeg screenshots of video's toe bij UI-wijzigingen.
- Geef aan of de wijziging updates van de documentatie nodig heeft.

<a id="pull-request-policy"></a>

### Beleid voor Pull Requests

- De PR moet verwijzen naar een toegewezen GitHub Issue. Plaats de reactie "Claiming" bij het issue om het toegewezen te krijgen. Neem daarna contact op met het kernteam op [Discord](https://discord.gg/VxfP4Vx3gX). Het kernteam bevestigt de toewijzing in de discussie.
- We kunnen PR's zonder verwijzing sluiten.
- Een PR moet de CI-tests doorstaan, de roadmap volgen en duidelijke documentatie hebben.

<a id="review-process"></a>

### Reviewproces

Een PR die klaar is voor review moet aan deze voorwaarden voldoen:

- De verplichte CI-controles slagen.
- De reviewfeedback die actie vraagt, is verwerkt.
- Een beheerder of CODEOWNER geeft een nieuwe goedkeuring. Dit gebeurt na de automatische review van de nieuwste commit.

De automatische review kan een reactie met aanwijzingen en beheerde statuslabels toevoegen. Volg de volgende stap in de reactie. Wijzig de labels niet zelf. Nieuwe commits zetten de reviewstatus voor de gewijzigde code terug.

Het label `community-approved` geeft een nieuwe goedkeuring van de community voor de nieuwste commit aan. De PR wacht daarna op een review door een beheerder. Het label helpt beheerders als advies over de prioriteit. Het vervangt geen review door een beheerder of verplichte controle. De reviewworkflow beheert het label.

Automatische review helpt beheerders. Die vervangt geen menselijke goedkeuring. Externe bijdragers kunnen CodeRabbit niet met reacties aansturen. Een review die aan de voorwaarden voldoet, start vanzelf opnieuw nadat de verplichte CI slaagt. Beheerders regelen uitzonderlijke herstarts. Waarschuwingen zijn advies, tenzij het repositorybeleid anders bepaalt. De ingebouwde verplichte GitHub-controles, CODEOWNER-regels en reviewbeveiliging bepalen of een PR kan worden samengevoegd.

- **Dagelijkse triage:** Beheerders doen snelle controles.
- **Wekelijkse diepgaande review:** Beheerders doen een volledige beoordeling.
- **Werk snel bij** wanneer je feedback krijgt.

<a id="pull-request-expectations"></a>

### Verwachtingen voor Pull Requests

Een PR moet makkelijk te reviewen, getest en makkelijk te onderhouden zijn. Controleer deze punten voordat je een PR opent:

- De wijziging behandelt één specifiek issue, één bug of één verbetering.
- Je kunt uitleggen wat de wijziging doet en waarom die klopt.
- Je hebt de wijziging waar mogelijk op je eigen computer getest.
- Je gaat op reviewfeedback reageren en redelijke vervolgwijzigingen maken.
- Beheerders hoeven de wijziging niet te herschrijven, opnieuw te ontwerpen of over te nemen voordat die kan worden samengevoegd.

Beheerders kunnen een PR om deze redenen sluiten:

- Die is onvolledig.
- Die is te breed.
- Die is inactief.
- Die volgt de richting van het project niet.
- Die veroorzaakt te veel review- of onderhoudswerk.

Een PR sluiten is geen oordeel over de bijdrager. Het betekent dat beheerders de wijziging in de huidige vorm niet kunnen accepteren.

Een bot sluit PR's ook automatisch:

- **60 dagen inactiviteit:** De bot markeert een PR als verouderd na 60 dagen zonder activiteit. Als er na nog eens 7 dagen geen activiteit is, sluit de bot de PR. Een nieuwe reactie, commit of review zet de timer terug.
- **14 dagen inactiviteit van de auteur:** Als een reviewer wijzigingen vraagt, voegt de bot het label `awaiting-author` toe. Activiteit van de auteur zet de inactiviteitstimer terug. Vraag de reviewer om een nieuwe review als de wijzigingen klaar zijn.

Voeg het label `do-not-close`, `pinned` of `work-in-progress` toe om te voorkomen dat een PR automatisch sluit.

<a id="ai-assisted-contributions"></a>

### Bijdragen met AI-hulp

Je mag AI-tools gebruiken. Je blijft volledig verantwoordelijk voor wat je indient.

Als je AI-tools gebruikt om een PR te maken, moet je:

- Elke belangrijke wijziging reviewen en begrijpen.
- De implementatie en afwegingen in je eigen woorden uitleggen.
- De wijziging zelf testen. Leg in de PR-beschrijving uit waarom als je niet in je omgeving kunt testen. Beschrijf ook hoe reviewers de wijziging kunnen controleren.
- Controleren dat de gegenereerde code klopt, nodig is en bij de projectlicentie past.
- Overwegen om reviewers in de PR-beschrijving over de AI-hulp te vertellen. Doe dit als de AI-hulp de code, tests of het ontwerp sterk heeft veranderd. Dit helpt reviewers om betere feedback te geven.

Dien geen AI-gegenereerde wijzigingen in die je niet begrijpt. Dien geen wijzigingen in die je tijdens de review niet kunt onderhouden. Beheerders kunnen een PR sluiten die veel AI-hulp lijkt te hebben gebruikt. Ze kunnen dit doen als menselijke controle, een duidelijke reden of opvolging tijdens de review ontbreekt.

<a id="writing-style"></a>

### Schrijfstijl

Deze regels gelden alleen voor Engelse tekst. Schrijf issuetitels, issuetekst, PR-titels, PR-beschrijvingen en commitberichten in Simplified Technical English (ASD-STE100). Zie [ASD-STE100](https://www.asd-ste100.org/). De issue- en PR-templates geven dezelfde herinnering.

- Gebruik korte zinnen. Gebruik maximaal 20 woorden voor een instructie.
- Gebruik gewone woorden. Schrijf "use", niet "utilize". Schrijf "start", niet "commence".
- Gebruik de actieve vorm. Schrijf "the parser reads the file", niet "the file is read by the parser".
- Schrijf één idee per zin.
- Gebruik geen verkorte vormen, puntkomma's of lange gedachtestreepjes.
- Houd de titel kort en specifiek.
- Wijzig geen exacte logs, foutmeldingen, identifiers, opdrachten of bewijs voor de reproductie. Plak ze zoals ze zijn.

Deze regels zijn richtlijnen voor het schrijven in het Engels. Reviewers controleren geen formele naleving van ASD-STE100. Code, identifiers en opdrachtensyntaxis vallen niet onder deze regel.

<a id="legal"></a>

## Juridische zaken

Door bij te dragen, ga je ermee akkoord dat je bijdragen de Apache 2.0 License gebruiken. Dit is de licentie van Zoo Code.
