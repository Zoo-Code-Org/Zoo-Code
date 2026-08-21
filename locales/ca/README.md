<p align="center">
          <a href="https://marketplace.visualstudio.com/items?itemName=ZooCodeOrganization.zoo-code"><img src="https://img.shields.io/badge/VS_Code_Marketplace-007ACC?style=flat&logo=visualstudiocode&logoColor=white" alt="VS Code Marketplace"></a>
          <a href="https://x.com/ZooCodeDev"><img src="https://img.shields.io/badge/ZooCode-000000?style=flat&logo=x&logoColor=white" alt="X"></a>
          <a href="https://discord.gg/VxfP4Vx3gX"><img src="https://img.shields.io/badge/Join%20Discord-5865F2?style=flat&logo=discord&logoColor=white" alt="Join Discord"></a>
          <a href="https://www.reddit.com/r/ZooCode/"><img src="https://img.shields.io/badge/Join%20r%2FZooCode-FF4500?style=flat&logo=reddit&logoColor=white" alt="Join r/ZooCode"></a>
          <a href="https://github.com/Zoo-Code-Org/Zoo-Code/issues"><img src="https://img.shields.io/badge/GitHub-Issues-181717?style=flat&logo=github&logoColor=white" alt="GitHub Issues"></a>
        </p>
        <p align="center">
          <em>Obtén ajuda ràpid → <a href="https://discord.gg/VxfP4Vx3gX">Uneix-te a Discord</a> • Prefereixes anar al teu ritme? → <a href="https://www.reddit.com/r/ZooCode/">Uneix-te a r/ZooCode</a></em>
        </p>

        # Zoo Code

        > El teu equip de desenvolupament impulsat per IA, directament al teu editor

        ## Som Zoo Code

> Zoo Code continua el desenvolupament d'aquest projecte després que l'equip de
> Roo aturés el desenvolupament actiu de Roo Code per centrar-se en
> [Roomote](https://roomote.dev/). Gràcies a l'equip de Roo per tot el que van
> construir.
>
> L'equip principal és un grup de desenvolupadors que ja havien contribuït a
> Roo anteriorment i que valoren profundament aquest plugin. Continuarem
> actualitzant models, corregint errors i publicant funcionalitats, i tenim
> intenció d'escoltar de prop la comunitat que ha fet aquest plugin tan
> especial. Uneix-te a nosaltres a
> [Discord](https://discord.gg/VxfP4Vx3gX),
> [Reddit](https://www.reddit.com/r/ZooCode), o
> [obre una PR o issue](https://github.com/Zoo-Code-Org/Zoo-Code).
>
> _-Zoo Code Team_

## Migració de Roo Code a Zoo Code

Pots trobar una guia ràpida per passar de Roo Code a Zoo Code a la [guia de migració Roo→Zoo](https://docs.zoocode.dev/roo-to-zoo-migration). Volem ajudar tant com puguem durant la transició, i per això tens el nostre [Reddit](https://www.reddit.com/r/ZooCode) i [Discord](https://discord.gg/VxfP4Vx3gX) per a aquest suport. Si tens problemes o algun dubte, entra i pregunta.

## Què ha afegit Zoo Code des de Roo Code

Zoo Code parteix de la base creada per Roo Code i continua ampliant-la amb:

- **Intel·ligència de bases de codi amb Semble** — cerca semàntica de codi ràpida i sota demanda, amb configuració automàtica i sense cap procés d'indexació separat.
- **Fluxos de treball d'Orchestrator més sòlids** — delegació més segura, coordinació de tasques en paral·lel, recuperació fiable de tasques pare/filla i millor aïllament entre subtasques i perfils de proveïdor.
- **Execucions autònomes més llargues amb Destructive Command Guard (DCG)** — bloqueja automàticament les ordres perilloses mentre el treball de confiança continua sense sol·licituds d'aprovació repetides.
- **Els models més recents** — compatibilitat contínua amb les noves famílies de models Claude, GPT, Gemini, Kimi, GLM, Grok, MiniMax i altres.
- **Més maneres de connectar-se** — proveïdors nous i ampliats, com ara Zoo Gateway, Moonshot, Kimi Code, Kenari, Friendli, OpenCode Go i molts més.
- **Fluxos de terminal i edició més fiables** — correccions per a la finalització prematura del terminal, les condicions de cursa en l'estat de les tasques, la gestió del context, l'edició de diff i l'ús d'eines específiques de cada proveïdor.
- **Més control sobre el teu espai de treball** — gestió de regles, restriccions MCP per mode, controls de rutes multiarrel, opcions de raonament dels models i accions per revisar els canvis en completar una tasca.

## Novetats a la v3.78.0

- **Han arribat tres grans models nous** — utilitza els nous Gemini 3.7 Flash, GLM 5.3 i Qwen3.8 Max, a més de millores en el raonament, els preus i la cobertura de proveïdors de DeepSeek V4.
- **Connecta't a NanoGPT** — utilitza el descobriment dinàmic de models, streaming i completions de prompts, i preferències d'encaminament per velocitat, preu, latència, rendiment, compatibilitat amb eines i memòria cau.
- **Proveïdors i tasques més fiables** — les correccions milloren la configuració dels endpoints d'Azure OpenAI, els límits de sortida de Kimi Code, la conservació dels títols de l'historial de tasques i la importació/exportació de configuració de Zoo.
- Destructive Command Guard ara és compatible amb els Mac basats en Intel.
- Les actualitzacions de seguretat solucionen vulnerabilitats a `undici` i Mermaid.

## Què pot fer Zoo Code per TU?

- Generar codi a partir de descripcions en llenguatge natural
- Adaptar-se amb modes: Codi, Arquitecte, Pregunta, Depuració i Modes personalitzats
- Refactoritzar i depurar codi existent
- Escriure i actualitzar documentació
- Respondre preguntes sobre la teva base de codi
- Automatitzar tasques repetitives
- Utilitzar servidors MCP

## Modes

Zoo Code s'adapta a la teva manera de treballar, no a l'inrevés:

- Mode Codi: codificació diària, edicions i operacions de fitxers
- Mode Arquitecte: planificar sistemes, especificacions i migracions
- Mode Pregunta: respostes ràpides, explicacions i documents
- Mode Depuració: rastrejar problemes, afegir registres, aïllar les causes arrel
- Modes personalitzats: crea modes especialitzats per al teu equip o flux de treball

Més informació: [Ús de Modes](https://docs.zoocode.dev/basic-usage/using-modes) • [Modes personalitzats](https://docs.zoocode.dev/advanced-usage/custom-modes)

## Recursos

- **[Documentació](https://docs.zoocode.dev):** La guia oficial per instal·lar, configurar i dominar Zoo Code.
- **[Servidor de Discord](https://discord.gg/VxfP4Vx3gX):** Uneix-te a la comunitat per obtenir ajuda i discutir en temps real.
- **[Comunitat de Reddit](https://www.reddit.com/r/ZooCode):** Comparteix les teves experiències i veu què estan construint altres.
- **[Incidències de GitHub](https://github.com/Zoo-Code-Org/Zoo-Code/issues):** Informa d'errors i segueix el desenvolupament.
- **[Sol·licituds de funcionalitats](https://github.com/Zoo-Code-Org/Zoo-Code/discussions/categories/feature-requests?discussions_q=is%3Aopen+category%3A%22Feature+Requests%22+sort%3Atop):** Tens una idea? Comparteix-la amb els desenvolupadors.

---

## Configuració i desenvolupament local

1. **Clona** el repositori:

```sh
git clone https://github.com/Zoo-Code-Org/Zoo-Code.git
```

2. **Instal·la les dependències**:

```sh
pnpm install
```

3. **Executa l'extensió**:

Hi ha diverses maneres d'executar l'extensió Zoo Code:

### Mode de desenvolupament (F5)

Per al desenvolupament actiu, utilitza la depuració integrada de VSCode:

Prem `F5` (o ves a **Executa** → **Inicia la depuració**) a VSCode. Això obrirà una nova finestra de VSCode amb l'extensió Zoo Code en funcionament.

- Els canvis a la vista web apareixeran immediatament.
- Els canvis a l'extensió principal també es recarregaran automàticament.

### Instal·lació automatitzada de VSIX

Per construir i instal·lar l'extensió com un paquet VSIX directament a VSCode:

```sh
pnpm install:vsix [-y] [--editor=<command>]
```

Aquesta comanda farà el següent:

- Preguntarà quina comanda d'editor utilitzar (code/cursor/code-insiders) - per defecte és 'code'
- Desinstal·larà qualsevol versió existent de l'extensió.
- Construirà l'últim paquet VSIX.
- Instal·larà el VSIX acabat de construir.
- Et demanarà que reiniciïs VS Code perquè els canvis tinguin efecte.

Opcions:

- `-y`: Omet totes les confirmacions i utilitza els valors per defecte
- `--editor=<command>`: Especifica la comanda de l'editor (p. ex., `--editor=cursor` o `--editor=code-insiders`)

### Instal·lació manual de VSIX

Si prefereixes instal·lar el paquet VSIX manualment:

1.  Primer, construeix el paquet VSIX:
    ```sh
    pnpm vsix
    ```
2.  Es generarà un fitxer `.vsix` al directori `bin/` (p. ej., `bin/zoo-code-<versió>.vsix`).
3.  Instal·la'l manualment utilitzant la CLI de VSCode:
    ```sh
    code --install-extension bin/zoo-code-<versió>.vsix
    ```

---

Utilitzem [changesets](https://github.com/changesets/changesets) per al versionat i la publicació. Consulta el nostre `CHANGELOG.md` per a les notes de la versió.

---

## Avís legal

**Tingueu en compte** que Zoo Code, Inc **no** fa cap representació ni garantia pel que fa a cap codi, model o altres eines proporcionades o posades a disposició en relació amb Zoo Code, qualsevol eina de tercers associada, o qualsevol resultat. Assumiu **tots els riscos** associats amb l'ús d'aquestes eines o resultats; aquestes eines es proporcionen **"TAL QUAL"** i **"SEGONS DISPONIBILITAT"**. Aquests riscos poden incloure, sense limitació, infraccions de propietat intel·lectual, vulnerabilitats o atacs cibernètics, biaix, inexactituds, errors, defectes, virus, temps d'inactivitat, pèrdua o dany de propietat i/o lesions personals. Sou l'únic responsable del vostre ús d'aquestes eines o resultats (incloent, sense limitació, la legalitat, idoneïtat i resultats dels mateixos).

---

## Contribucions

Ens encanten les contribucions de la comunitat! Comença llegint el nostre [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Llicència

[Apache 2.0 © 2025 Zoo Code Org](../../LICENSE)

---

**Gaudeix de Zoo Code!** Tant si el portes curt com si el deixes voltar de manera autònoma, tenim moltes ganes de veure què construiràs. Si tens preguntes o idees de funcionalitats, obre una [issue](https://github.com/Zoo-Code-Org/Zoo-Code/issues) o inicia una [discussion](https://github.com/Zoo-Code-Org/Zoo-Code/discussions). Feliç codi!
