<p align="center">
          <a href="https://marketplace.visualstudio.com/items?itemName=ZooCodeOrganization.zoo-code"><img src="https://img.shields.io/badge/VS_Code_Marketplace-007ACC?style=flat&logo=visualstudiocode&logoColor=white" alt="VS Code Marketplace"></a>
          <a href="https://x.com/ZooCodeDev"><img src="https://img.shields.io/badge/ZooCode-000000?style=flat&logo=x&logoColor=white" alt="X"></a>
          <a href="https://discord.gg/VxfP4Vx3gX"><img src="https://img.shields.io/badge/Join%20Discord-5865F2?style=flat&logo=discord&logoColor=white" alt="Join Discord"></a>
          <a href="https://www.reddit.com/r/ZooCode/"><img src="https://img.shields.io/badge/Join%20r%2FZooCode-FF4500?style=flat&logo=reddit&logoColor=white" alt="Join r/ZooCode"></a>
          <a href="https://github.com/Zoo-Code-Org/Zoo-Code/issues"><img src="https://img.shields.io/badge/GitHub-Issues-181717?style=flat&logo=github&logoColor=white" alt="GitHub Issues"></a>
        </p>
        <p align="center">
          <em>Hai bisogno di aiuto in fretta → <a href="https://discord.gg/VxfP4Vx3gX">Unisciti a Discord</a> • Preferisci l'asincrono? → <a href="https://www.reddit.com/r/ZooCode/">Unisciti a r/ZooCode</a></em>
        </p>

        # Zoo Code

        > Il tuo team di sviluppo con IA, direttamente nel tuo editor

        ## Siamo Zoo Code

> Zoo Code continua lo sviluppo di questo progetto dopo che il team di Roo
> ha interrotto lo sviluppo attivo di Roo Code per concentrarsi su
> [Roomote](https://roomote.dev/). Grazie al team di Roo per tutto quello
> che hanno costruito.
>
> Il team principale è un gruppo di sviluppatori che avevano già contribuito
> a Roo e che tengono profondamente a questo plugin. Continueremo ad
> aggiornare i modelli, correggere bug e pubblicare funzionalità, e
> intendiamo ascoltare con attenzione la community che ha reso questo
> plugin così speciale. Unisciti a noi su
> [Discord](https://discord.gg/VxfP4Vx3gX),
> [Reddit](https://www.reddit.com/r/ZooCode), oppure
> [apri una PR o una issue](https://github.com/Zoo-Code-Org/Zoo-Code).
>
> _-Zoo Code Team_

## Migrazione da Roo Code a Zoo Code

Puoi trovare una guida rapida per passare da Roo Code a Zoo Code nella [guida alla migrazione Roo→Zoo](https://docs.zoocode.dev/roo-to-zoo-migration). Vogliamo aiutare gli utenti il più possibile durante la transizione, e per questo abbiamo il nostro [Reddit](https://www.reddit.com/r/ZooCode) e il nostro [Discord](https://discord.gg/VxfP4Vx3gX). Se hai problemi o domande, passa pure e chiedi.

## Cosa ha aggiunto Zoo Code rispetto a Roo Code

Zoo Code parte dalle fondamenta create da Roo Code e continua ad ampliarle con:

- **Intelligenza della codebase Semble** — ricerca semantica del codice rapida e on demand, con configurazione automatica e senza un workflow di indicizzazione separato.
- **Workflow Orchestrator più solidi** — delega più sicura, coordinamento parallelo delle attività, recupero affidabile delle attività principali e secondarie e migliore isolamento tra attività secondarie e profili provider.
- **Esecuzioni autonome più lunghe con Destructive Command Guard (DCG)** — blocca automaticamente i comandi pericolosi mentre il lavoro attendibile prosegue senza ripetute richieste di approvazione.
- **I modelli più recenti** — supporto continuo per le nuove famiglie di modelli Claude, GPT, Gemini, Kimi, GLM, Grok, MiniMax e altre.
- **Più modi per connettersi** — provider nuovi e ampliati, tra cui Zoo Gateway, Moonshot, Kimi Code, Kenari, Friendli, OpenCode Go e molti altri.
- **Workflow di terminale e modifica più affidabili** — correzioni per il completamento prematuro del terminale, le race condition dello stato delle attività, la gestione del contesto, la modifica dei diff e l'uso di strumenti specifici dei provider.
- **Più controllo sul tuo workspace** — gestione delle regole, restrizioni MCP per modalità, controlli dei percorsi multi-root, opzioni di reasoning dei modelli e azioni per esaminare le modifiche al completamento.

## Novità in v3.76.0

- **Esegui attività più lunghe e senza interruzioni con Destructive Command Guard (DCG)** — DCG blocca i comandi pericolosi lasciando che Zoo continui a lavorare senza costringerti a premere continuamente i pulsanti di approvazione, con download e installazione rafforzati del binario gestito.
- **Controlli e affidabilità dei provider migliorati** — scegli la velocità di risposta di OpenAI Codex, usa le configurazioni DeepSeek aggiornate e approfitta di un isolamento più solido tra le modifiche ai profili provider e le attività in esecuzione.
- **Correzione critica dell'esecuzione nel terminale** — Zoo ora attende che i comandi del terminale terminino prima di iniziare il passaggio successivo, evitando sovrapposizioni di lavoro e la continuazione prematura del modello.
- Un raggruppamento più intelligente riunisce le approvazioni degli strumenti correlati mantenendo separate le richieste non correlate.
- L'invio della telemetria e il recupero della cache dei modelli sono più resilienti in caso di errori e richieste simultanee.

## Cosa può fare Zoo Code per TE?

- Generare codice da descrizioni in linguaggio naturale
- Adattarsi con le Modalità: Codice, Architetto, Chiedi, Debug e Modalità Personalizzate
- Refactoring e debug di codice esistente
- Scrivere e aggiornare la documentazione
- Rispondere a domande sulla tua codebase
- Automatizzare attività ripetitive
- Utilizzare server MCP

## Modalità

Zoo Code si adatta al tuo modo di lavorare, non il contrario:

- Modalità Codice: codifica quotidiana, modifiche e operazioni sui file
- Modalità Architetto: pianifica sistemi, specifiche e migrazioni
- Modalità Chiedi: risposte rapide, spiegazioni e documenti
- Modalità Debug: traccia problemi, aggiungi log, isola le cause principali
- Modalità Personalizzate: crea modalità specializzate per il tuo team o flusso di lavoro

Scopri di più: [Usare le Modalità](https://docs.zoocode.dev/basic-usage/using-modes) • [Modalità personalizzate](https://docs.zoocode.dev/advanced-usage/custom-modes)

## Risorse

- **[Documentazione](https://docs.zoocode.dev):** La guida ufficiale per installare, configurare e padroneggiare Zoo Code.
- **[Server Discord](https://discord.gg/VxfP4Vx3gX):** Unisciti alla community per aiuto e discussioni in tempo reale.
- **[Comunità Reddit](https://www.reddit.com/r/ZooCode):** Condividi le tue esperienze e guarda cosa stanno costruendo gli altri.
- **[Problemi GitHub](https://github.com/Zoo-Code-Org/Zoo-Code/issues):** Segnala bug e tieni traccia dello sviluppo.
- **[Richieste di funzionalità](https://github.com/Zoo-Code-Org/Zoo-Code/discussions/categories/feature-requests?discussions_q=is%3Aopen+category%3A%22Feature+Requests%22+sort%3Atop):** Hai un'idea? Condividila con gli sviluppatori.

---

## Configurazione e sviluppo locale

1. **Clona** il repository:

```sh
git clone https://github.com/Zoo-Code-Org/Zoo-Code.git
```

2. **Installa le dipendenze**:

```sh
pnpm install
```

3. **Esegui l'estensione**:

Ci sono diversi modi per eseguire l'estensione Zoo Code:

### Modalità di sviluppo (F5)

Per lo sviluppo attivo, usa il debug integrato di VSCode:

Premi `F5` (o vai su **Esegui** → **Avvia debug**) in VSCode. Si aprirà una nuova finestra di VSCode con l'estensione Zoo Code in esecuzione.

- Le modifiche alla webview appariranno immediatamente.
- Anche le modifiche all'estensione principale verranno ricaricate automaticamente a caldo.

### Installazione automatizzata di VSIX

Per compilare e installare l'estensione come pacchetto VSIX direttamente in VSCode:

```sh
pnpm install:vsix [-y] [--editor=<command>]
```

Questo comando:

- Chiederà quale comando dell'editor usare (code/cursor/code-insiders) - il default è 'code'
- Disinstallerà qualsiasi versione esistente dell'estensione.
- Compilerà l'ultimo pacchetto VSIX.
- Installerà il VSIX appena compilato.
- Ti chiederà di riavviare VS Code affinché le modifiche abbiano effetto.

Opzioni:

- `-y`: Salta tutte le richieste di conferma e usa i valori predefiniti
- `--editor=<command>`: Specifica il comando dell'editor (ad es. `--editor=cursor` o `--editor=code-insiders`)

### Installazione manuale di VSIX

Se preferisci installare manualmente il pacchetto VSIX:

1.  Per prima cosa, compila il pacchetto VSIX:
    ```sh
    pnpm vsix
    ```
2.  Un file `.vsix` verrà generato nella directory `bin/` (ad es. `bin/zoo-code-<version>.vsix`).
3.  Installalo manualmente usando la CLI di VSCode:
    ```sh
    code --install-extension bin/zoo-code-<version>.vsix
    ```

---

Usiamo [changesets](https://github.com/changesets/changesets) per il versioning e la pubblicazione. Controlla il nostro `CHANGELOG.md` per le note di rilascio.

---

## Dichiarazione di non responsabilità

**Si prega di notare** che Zoo Code **non** rilascia alcuna dichiarazione o garanzia in merito a qualsiasi codice, modello o altro strumento fornito o reso disponibile in connessione con Zoo Code, qualsiasi strumento di terze parti associato o qualsiasi output risultante. L'utente si assume **tutti i rischi** associati all'uso di tali strumenti o output; tali strumenti sono forniti **"COSÌ COME SONO"** e **"COME DISPONIBILI"**. Tali rischi possono includere, a titolo esemplificativo, violazione della proprietà intellettuale, vulnerabilità o attacchi informatici, parzialità, imprecisioni, errori, difetti, virus, tempi di inattività, perdita o danneggiamento di proprietà e/o lesioni personali. L'utente è l'unico responsabile dell'uso di tali strumenti o output (inclusi, a titolo esemplificativo, la loro legalità, adeguatezza e risultati).

---

## Contribuire

Adoriamo i contributi della community! Inizia leggendo il nostro [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Licenza

[Apache 2.0 © 2025 Zoo Code Org](../../LICENSE)

---

**Divertiti con Zoo Code!** Che tu lo tenga al guinzaglio corto o lo lasci muoversi in autonomia, non vediamo l'ora di vedere cosa costruirai. Se hai domande o idee per nuove funzionalità, apri una [issue](https://github.com/Zoo-Code-Org/Zoo-Code/issues) o avvia una [discussion](https://github.com/Zoo-Code-Org/Zoo-Code/discussions). Buon coding!
