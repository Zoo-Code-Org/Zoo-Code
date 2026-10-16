<div align="center">
<sub>

[English](../../CONTRIBUTING.md) • <b>Català</b> • [Deutsch](../de/CONTRIBUTING.md) • [Español](../es/CONTRIBUTING.md) • [Français](../fr/CONTRIBUTING.md) • [हिंदी](../hi/CONTRIBUTING.md) • [Bahasa Indonesia](../id/CONTRIBUTING.md) • [Italiano](../it/CONTRIBUTING.md) • [日本語](../ja/CONTRIBUTING.md)

</sub>
<sub>

[한국어](../ko/CONTRIBUTING.md) • [Nederlands](../nl/CONTRIBUTING.md) • [Polski](../pl/CONTRIBUTING.md) • [Português (BR)](../pt-BR/CONTRIBUTING.md) • [Русский](../ru/CONTRIBUTING.md) • [Türkçe](../tr/CONTRIBUTING.md) • [Tiếng Việt](../vi/CONTRIBUTING.md) • [简体中文](../zh-CN/CONTRIBUTING.md) • [繁體中文](../zh-TW/CONTRIBUTING.md)

</sub>
</div>

<a id="contributing-to-zoo-code"></a>

# Contribuir a Zoo Code

Zoo Code és un projecte comunitari. Valorem cada contribució. Treballem amb l'enfocament de [primer la incidència](#issue-first-approach). Cada [Pull Request (PR)](#submitting-a-pull-request) ha d'enllaçar a una incidència de GitHub. Llegeix aquesta guia amb atenció.

<a id="table-of-contents"></a>

## Taula de continguts

- [Abans de contribuir](#before-you-contribute)
- [Trobar i planificar la teva contribució](#finding--planning-your-contribution)
- [Procés de desenvolupament i enviament](#development--submission-process)
    - [Expectatives dels Pull Requests](#pull-request-expectations)
    - [Contribucions amb ajuda d'IA](#ai-assisted-contributions)
    - [Estil d'escriptura](#writing-style)
- [Aspectes legals](#legal)

<a id="before-you-contribute"></a>

## Abans de contribuir

<a id="1-code-of-conduct"></a>

### 1. Codi de conducta

Tots els col·laboradors han de seguir el nostre [codi de conducta](./CODE_OF_CONDUCT.md).

<a id="2-project-roadmap"></a>

### 2. Full de ruta del projecte

El nostre full de ruta mostra la direcció del projecte. Alinea les teves contribucions amb aquests objectius:

<a id="reliability-first"></a>

### La fiabilitat primer

- Fes que l'edició amb diff i l'execució d'ordres siguin fiables sempre.
- Elimina els problemes que impedeixen fer servir Zoo Code cada dia.
- Fes que Zoo Code funcioni en tots els idiomes i plataformes.
- Afegeix suport per a més proveïdors i models d'IA.

<a id="enhanced-user-experience"></a>

### Millor experiència d'usuari

- Fes que la UI i la UX siguin clares i fàcils d'utilitzar.
- Millora el flux de treball. Els desenvolupadors esperen un nivell alt de les eines que fan servir cada dia.

<a id="leading-on-agent-performance"></a>

### Liderar el rendiment dels agents

- Crea proves d'avaluació (evals) que mesurin la productivitat en situacions reals.
- Fes que les evals siguin fàcils d'executar i de llegir.
- Publica millores que augmentin clarament les puntuacions de les evals.

Als teus PRs, indica quines d'aquestes àrees ajuda el canvi.

<a id="3-join-the-zoo-code-community"></a>

### 3. Uneix-te a la comunitat de Zoo Code

- **Discord:** Uneix-te al nostre [Discord](https://discord.gg/VxfP4Vx3gX).
- **Reddit:** Uneix-te al nostre [Reddit](https://www.reddit.com/r/ZooCode/).

<a id="finding--planning-your-contribution"></a>

## Trobar i planificar la teva contribució

<a id="types-of-contributions"></a>

### Tipus de contribucions

- **Correccions d'errors:** Corregeix problemes del codi.
- **Noves funcions:** Afegeix funcions.
- **Documentació:** Millora les guies i fes-les més clares.

<a id="issue-first-approach"></a>

### Primer la incidència

Cada contribució comença amb una incidència de GitHub. Fes servir les nostres plantilles breus.

- **Comprova les incidències existents**: Cerca a [GitHub Issues](https://github.com/Zoo-Code-Org/Zoo-Code/issues).
- **Crea una incidència** amb:
    - **Millores:** La plantilla "Enhancement Request" (llenguatge planer centrat en el benefici per a l'usuari).
    - **Errors:** La plantilla "Bug Report" (reproducció mínima, resultat esperat i real, versió).
- **Escriu la incidència** amb l'[estil d'escriptura](#writing-style) que trobaràs més avall.
- **Hi vols treballar?** Comenta "Claiming" a la incidència. Després contacta amb l'equip principal a [Discord](https://discord.gg/VxfP4Vx3gX) perquè te l'assigni. L'equip principal confirma l'assignació al fil.
- **Els PRs han d'enllaçar a la incidència.** Podem tancar els PRs que no tinguin aquest enllaç.

<a id="deciding-what-to-work-on"></a>

### Decidir en què treballar

- Consulta la [pàgina de GitHub Issues](https://github.com/Zoo-Code-Org/Zoo-Code/issues).
- Per a la documentació, ves a [Zoo Code Docs](https://github.com/Zoo-Code-Org/Zoo-Code-Docs).

<a id="reporting-bugs"></a>

### Informar d'errors

- Primer comprova si ja hi ha informes.
- Crea un informe d'error amb la [plantilla "Bug Report"](https://github.com/Zoo-Code-Org/Zoo-Code/issues/new/choose) i inclou:
    - Passos clars i numerats per reproduir l'error
    - Resultat esperat i resultat real
    - Versió de Zoo Code (obligatòria)
    - Proveïdor d'API i model, si són rellevants
- **Problemes de seguretat**: Informa'n en privat amb els [avisos de seguretat](https://github.com/Zoo-Code-Org/Zoo-Code/security/advisories/new).

<a id="development--submission-process"></a>

## Procés de desenvolupament i enviament

<a id="development-setup"></a>

### Preparar l'entorn de desenvolupament

1. **Fes un fork i clona el repositori:**

```
git clone https://github.com/YOUR_USERNAME/Zoo-Code.git
```

2. **Instal·la les dependències:**

```
pnpm install
```

3. **Depuració:** Obre'l amb VS Code (`F5`).

<a id="writing-code-guidelines"></a>

### Pautes per escriure codi

- Un PR centrat en cada funció o correcció.
- Segueix les bones pràctiques d'ESLint i TypeScript.
- Escriu commits clars i descriptius que facin referència a incidències (per exemple, `Fixes #123`). Segueix l'[estil d'escriptura](#writing-style).
- Prova el canvi a fons (`npm test`).
- Fes rebase sobre la versió més recent de la branca `main` abans d'enviar-lo.

<a id="submitting-a-pull-request"></a>

### Enviar un Pull Request

- Comença amb un **PR en esborrany** si vols comentaris aviat.
- Descriu els canvis amb la plantilla Pull Request Template. Segueix l'[estil d'escriptura](#writing-style).
- Enllaça la incidència a la descripció o al títol del PR (per exemple, "Fixes #123").
- Afegeix captures de pantalla o vídeos si canvies la UI.
- Indica si el canvi necessita actualitzacions de la documentació.

<a id="pull-request-policy"></a>

### Política dels Pull Requests

- El PR ha de fer referència a una incidència de GitHub assignada. Per obtenir l'assignació, comenta "Claiming" a la incidència. Després contacta amb l'equip principal a [Discord](https://discord.gg/VxfP4Vx3gX). L'equip principal confirma l'assignació al fil.
- Podem tancar els PRs que no tinguin aquest enllaç.
- Un PR ha de superar les proves de CI, seguir el full de ruta i tenir documentació clara.

<a id="review-process"></a>

### Procés de revisió

Un PR preparat per a la revisió ha de complir aquestes condicions:

- Supera les comprovacions de CI obligatòries.
- Resol els comentaris de revisió que requereixen accions.
- Rep una nova aprovació d'un mantenidor o CODEOWNER. Això passa després que acabi la revisió automàtica del commit més recent.

La revisió automàtica pot afegir un comentari d'orientació i etiquetes d'estat gestionades. Segueix el pas següent del comentari. No editis les etiquetes pel teu compte. Els commits nous reinicien l'estat de revisió del codi modificat.

L'etiqueta `community-approved` indica una nova aprovació de la comunitat sobre el commit més recent. El PR espera llavors la revisió d'un mantenidor. L'etiqueta orienta els mantenidors sobre la prioritat. No substitueix la revisió d'un mantenidor ni cap comprovació obligatòria. El flux de revisió gestiona l'etiqueta.

La revisió automàtica ajuda els mantenidors. No substitueix l'aprovació humana. Els col·laboradors externs no poden donar instruccions a CodeRabbit amb comentaris. Una revisió que compleix els requisits es reinicia sola quan supera la CI obligatòria. Els mantenidors gestionen els reinicis excepcionals. Els avisos són orientatius, tret que la política del repositori indiqui el contrari. Les comprovacions obligatòries de GitHub, les regles de CODEOWNER i les proteccions de revisió determinen si es pot fusionar un PR.

- **Triatge diari:** Els mantenidors fan comprovacions ràpides.
- **Revisió setmanal a fons:** Els mantenidors fan una avaluació completa.
- **Fes ajustos ràpidament** quan rebis comentaris.

<a id="pull-request-expectations"></a>

### Expectatives dels Pull Requests

Un PR ha de ser fàcil de revisar, estar provat i ser fàcil de mantenir. Abans d'obrir un PR, comprova aquests punts:

- El canvi tracta una incidència, un error o una millora concreta.
- Pots explicar què fa el canvi i per què és correcte.
- Has provat el canvi al teu ordinador sempre que ha estat possible.
- Respondràs als comentaris de revisió i faràs els ajustos raonables que calguin.
- Els mantenidors no han de reescriure, redissenyar ni assumir el canvi abans de poder-lo fusionar.

Els mantenidors poden tancar un PR per aquests motius:

- Està incomplet.
- És massa ampli.
- Està inactiu.
- No segueix la direcció del projecte.
- Genera massa feina de revisió o manteniment.

Tancar un PR no és un judici sobre el col·laborador. Vol dir que els mantenidors no poden acceptar el canvi en la forma actual.

Un bot també tanca PRs automàticament:

- **60 dies d'inactivitat:** El bot marca un PR com a inactiu després de 60 dies sense activitat. Si passen 7 dies més sense activitat, el tanca. Un comentari, commit o revisió nous reinicien el comptador.
- **14 dies d'inactivitat de l'autor:** Quan un revisor demana canvis, el bot afegeix l'etiqueta `awaiting-author`. L'activitat de l'autor reinicia el comptador d'inactivitat. Quan els canvis estiguin preparats, demana una nova revisió al revisor.

Per evitar el tancament automàtic d'un PR, afegeix l'etiqueta `do-not-close`, `pinned` o `work-in-progress`.

<a id="ai-assisted-contributions"></a>

### Contribucions amb ajuda d'IA

Pots fer servir eines d'IA. Continues sent plenament responsable del que envies.

Si fas servir eines d'IA per crear un PR, has de:

- Revisar i entendre cada canvi important.
- Explicar la implementació i els avantatges i inconvenients amb les teves paraules.
- Provar el canvi tu mateix. Si no el pots provar al teu entorn, explica per què a la descripció del PR. Descriu també com els revisors poden comprovar el canvi.
- Comprovar que el codi generat és correcte, necessari i compatible amb la llicència del projecte.
- Valorar si cal indicar l'ajuda de la IA a la descripció del PR. Fes-ho quan aquesta ajuda hagi canviat molt el codi, les proves o el disseny. Això ajuda els revisors a fer comentaris més útils.

No enviïs canvis generats per IA que no entenguis. No enviïs canvis que no puguis mantenir durant la revisió. Els mantenidors poden tancar un PR que sembli tenir molta ajuda d'IA. Poden fer-ho si falta verificació humana, un motiu clar o seguiment durant la revisió.

<a id="writing-style"></a>

### Estil d'escriptura

Aquestes regles s'apliquen als textos en anglès. Escriu els títols i textos d'incidències, els títols i descripcions de PRs i els missatges de commit en [Simplified Technical English (ASD-STE100)](https://www.asd-ste100.org/). Les plantilles d'incidències i PRs inclouen el mateix recordatori.

- Fes frases curtes. Fes servir 20 paraules o menys per a una instrucció.
- Fes servir paraules senzilles. Escriu "use", no "utilize". Escriu "start", no "commence".
- Fes servir la veu activa. Escriu "the parser reads the file", no "the file is read by the parser".
- Escriu una idea per frase.
- No facis servir contraccions, punts i coma ni ratlles llargues.
- Fes que el títol sigui curt i concret.
- No canviïs els registres, missatges d'error, identificadors, ordres ni proves de reproducció exactes. Enganxa'ls tal com són.

Aquestes regles són pautes d'escriptura. Els revisors no comproven el compliment formal d'ASD-STE100. El codi, els identificadors i la sintaxi de les ordres no formen part d'aquesta regla.

<a id="legal"></a>

## Aspectes legals

Quan contribueixes, acceptes que les teves contribucions utilitzin la llicència Apache 2.0. Aquesta és la llicència de Zoo Code.
