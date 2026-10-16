<div align="center">
<sub>

[English](../../CONTRIBUTING.md) • [Català](../ca/CONTRIBUTING.md) • [Deutsch](../de/CONTRIBUTING.md) • [Español](../es/CONTRIBUTING.md) • [Français](../fr/CONTRIBUTING.md) • [हिंदी](../hi/CONTRIBUTING.md) • [Bahasa Indonesia](../id/CONTRIBUTING.md) • <b>Italiano</b> • [日本語](../ja/CONTRIBUTING.md)

</sub>
<sub>

[한국어](../ko/CONTRIBUTING.md) • [Nederlands](../nl/CONTRIBUTING.md) • [Polski](../pl/CONTRIBUTING.md) • [Português (BR)](../pt-BR/CONTRIBUTING.md) • [Русский](../ru/CONTRIBUTING.md) • [Türkçe](../tr/CONTRIBUTING.md) • [Tiếng Việt](../vi/CONTRIBUTING.md) • [简体中文](../zh-CN/CONTRIBUTING.md) • [繁體中文](../zh-TW/CONTRIBUTING.md)

</sub>
</div>

<a id="contributing-to-zoo-code"></a>

# Contribuire a Zoo Code

Zoo Code è un progetto della comunità. Apprezziamo ogni contributo. Seguiamo l'approccio [Issue-First](#issue-first-approach). Ogni [Pull Request (PR)](#submitting-a-pull-request) deve quindi collegarsi a un'issue di GitHub. Leggi questa guida con attenzione.

<a id="table-of-contents"></a>

## Indice

- [Prima di contribuire](#before-you-contribute)
- [Trovare e pianificare il tuo contributo](#finding--planning-your-contribution)
- [Sviluppo e invio](#development--submission-process)
    - [Aspettative per le Pull Request](#pull-request-expectations)
    - [Contributi con l'aiuto dell'IA](#ai-assisted-contributions)
    - [Stile di scrittura](#writing-style)
- [Aspetti legali](#legal)

<a id="before-you-contribute"></a>

## Prima di contribuire

<a id="1-code-of-conduct"></a>

### 1. Codice di condotta

Tutti i collaboratori devono seguire il nostro [Codice di condotta](./CODE_OF_CONDUCT.md).

<a id="2-project-roadmap"></a>

### 2. Roadmap del progetto

La roadmap indica la direzione del progetto. Allinea i tuoi contributi a questi obiettivi:

<a id="reliability-first"></a>

### Affidabilità prima di tutto

- Rendi affidabili le modifiche tramite diff e l'esecuzione dei comandi, ogni volta.
- Elimina i problemi che impediscono di usare Zoo Code ogni giorno.
- Fai funzionare Zoo Code in tutte le lingue e su tutte le piattaforme.
- Supporta più fornitori e modelli di IA.

<a id="enhanced-user-experience"></a>

### Migliorare l'esperienza d'uso

- Rendi l'interfaccia e l'esperienza d'uso chiare e semplici.
- Migliora il flusso di lavoro. Gli sviluppatori si aspettano strumenti di qualità per il lavoro quotidiano.

<a id="leading-on-agent-performance"></a>

### Puntare sulle prestazioni degli agenti

- Crea benchmark di valutazione (evals) che misurino la produttività reale.
- Rendi gli evals facili da eseguire e da leggere.
- Introduci miglioramenti che aumentino chiaramente i punteggi degli evals.

Nelle tue PR, indica quali di queste aree sostiene la modifica.

<a id="3-join-the-zoo-code-community"></a>

### 3. Unisciti alla comunità di Zoo Code

- **Discord:** Unisciti al nostro [Discord](https://discord.gg/VxfP4Vx3gX).
- **Reddit:** Unisciti al nostro [Reddit](https://www.reddit.com/r/ZooCode/).

<a id="finding--planning-your-contribution"></a>

## Trovare e pianificare il tuo contributo

<a id="types-of-contributions"></a>

### Tipi di contributi

- **Correzioni di bug:** Risolvi problemi nel codice.
- **Nuove funzionalità:** Aggiungi funzioni.
- **Documentazione:** Migliora le guide e rendile più chiare.

<a id="issue-first-approach"></a>

### Approccio Issue-First

Ogni contributo inizia con un'issue di GitHub. Usa i nostri modelli brevi.

- **Controlla le issue esistenti**: Cerca nelle [issue di GitHub](https://github.com/Zoo-Code-Org/Zoo-Code/issues).
- **Crea un'issue** usando:
    - **Miglioramenti:** Il modello "Enhancement Request" (linguaggio semplice, con attenzione al beneficio per l'utente).
    - **Bug:** Il modello "Bug Report" (riproduzione minima, risultato atteso e reale, versione).
- **Scrivi l'issue** seguendo lo [stile di scrittura](#writing-style) descritto sotto.
- **Vuoi occupartene?** Commenta "Claiming" nell'issue. Poi contatta il team principale su [Discord](https://discord.gg/VxfP4Vx3gX) per farti assegnare l'issue. Il team conferma l'assegnazione nella discussione.
- **Le PR devono collegarsi all'issue.** Possiamo chiudere le PR senza collegamento.

<a id="deciding-what-to-work-on"></a>

### Scegliere su cosa lavorare

- Consulta la [pagina delle issue di GitHub](https://github.com/Zoo-Code-Org/Zoo-Code/issues).
- Per la documentazione, visita [Zoo Code Docs](https://github.com/Zoo-Code-Org/Zoo-Code-Docs).

<a id="reporting-bugs"></a>

### Segnalare bug

- Prima controlla le segnalazioni esistenti.
- Crea una nuova segnalazione con il [modello "Bug Report"](https://github.com/Zoo-Code-Org/Zoo-Code/issues/new/choose) e includi:
    - Passaggi di riproduzione chiari e numerati
    - Risultato atteso e risultato reale
    - Versione di Zoo Code (obbligatoria)
    - Fornitore API e modello, se rilevanti
- **Problemi di sicurezza**: Segnalali in privato tramite gli [avvisi di sicurezza](https://github.com/Zoo-Code-Org/Zoo-Code/security/advisories/new).

<a id="development--submission-process"></a>

## Sviluppo e invio

<a id="development-setup"></a>

### Preparare l'ambiente di sviluppo

1. **Crea un fork e clona:**

```
git clone https://github.com/YOUR_USERNAME/Zoo-Code.git
```

2. **Installa le dipendenze:**

```
pnpm install
```

3. **Debug:** Apri con VS Code (`F5`).

<a id="writing-code-guidelines"></a>

### Linee guida per il codice

- Una PR mirata per ogni funzionalità o correzione.
- Segui le buone pratiche di ESLint e TypeScript.
- Scrivi commit chiari e descrittivi che facciano riferimento alle issue (per esempio, `Fixes #123`). Segui lo [stile di scrittura](#writing-style).
- Testa completamente la modifica (`npm test`).
- Prima dell'invio, esegui il rebase sull'ultima versione del branch `main`.

<a id="submitting-a-pull-request"></a>

### Inviare una Pull Request

- Inizia con una **Draft PR** se vuoi ricevere commenti in anticipo.
- Descrivi le modifiche usando il Pull Request Template. Segui lo [stile di scrittura](#writing-style).
- Collega l'issue nella descrizione o nel titolo della PR (per esempio, "Fixes #123").
- Aggiungi screenshot o video per le modifiche all'interfaccia.
- Indica se la modifica richiede aggiornamenti alla documentazione.

<a id="pull-request-policy"></a>

### Regole per le Pull Request

- La PR deve fare riferimento a un'issue di GitHub assegnata. Per ottenere l'assegnazione, commenta "Claiming" nell'issue. Poi contatta il team principale su [Discord](https://discord.gg/VxfP4Vx3gX). Il team conferma l'assegnazione nella discussione.
- Possiamo chiudere le PR senza collegamento.
- Una PR deve superare i test CI, seguire la roadmap e avere una documentazione chiara.

<a id="review-process"></a>

### Processo di revisione

Una PR pronta per la revisione deve soddisfare queste condizioni:

- Supera i controlli CI richiesti.
- Risponde ai commenti della revisione che richiedono interventi.
- Ottiene una nuova approvazione da un manutentore o CODEOWNER. Questo avviene dopo la fine della revisione automatica dell'ultimo commit.

La revisione automatica può aggiungere un commento con indicazioni ed etichette di stato gestite dal sistema. Segui il prossimo passo indicato nel commento. Non modificare le etichette. I nuovi commit azzerano lo stato della revisione per il codice modificato.

L'etichetta `community-approved` indica una nuova approvazione della comunità sull'ultimo commit. La PR attende poi la revisione di un manutentore. L'etichetta suggerisce una priorità ai manutentori. Non sostituisce la loro revisione né un controllo richiesto. Il flusso di revisione gestisce l'etichetta.

La revisione automatica aiuta i manutentori. Non sostituisce l'approvazione umana. I collaboratori esterni non possono dare istruzioni a CodeRabbit tramite commenti. Una revisione idonea riparte da sola dopo il superamento dei controlli CI richiesti. I manutentori gestiscono i riavvii eccezionali. Gli avvisi sono indicativi, salvo diversa regola del repository. I controlli obbligatori nativi di GitHub, le regole CODEOWNER e le protezioni della revisione decidono se una PR può essere unita.

- **Controllo giornaliero:** I manutentori fanno controlli rapidi.
- **Revisione approfondita settimanale:** I manutentori fanno una valutazione completa.
- **Aggiorna rapidamente** quando ricevi commenti.

<a id="pull-request-expectations"></a>

### Aspettative per le Pull Request

Una PR deve essere facile da revisionare, testata e facile da mantenere. Prima di aprirla, verifica questi punti:

- La modifica riguarda un solo problema, bug o miglioramento specifico.
- Sai spiegare cosa fa la modifica e perché è corretta.
- Hai testato la modifica sul tuo computer, quando possibile.
- Risponderai ai commenti della revisione e farai modifiche successive ragionevoli.
- I manutentori non devono riscrivere o riprogettare la modifica, né prenderla in carico, prima di poterla unire.

I manutentori possono chiudere una PR per questi motivi:

- È incompleta.
- È troppo ampia.
- È inattiva.
- Non segue la direzione del progetto.
- Crea troppo lavoro di revisione o manutenzione.

Chiudere una PR non è un giudizio su chi contribuisce. Significa che i manutentori non possono accettare la modifica nella forma attuale.

Anche un bot chiude automaticamente le PR:

- **Inattività di 60 giorni:** Il bot segna una PR come inattiva dopo 60 giorni senza attività. Se non ci sono attività per altri 7 giorni, la chiude. Un nuovo commento, commit o revisione azzera il timer.
- **Inattività dell'autore di 14 giorni:** Quando un revisore richiede modifiche, il bot aggiunge l'etichetta `awaiting-author`. L'attività dell'autore azzera il timer di inattività. Quando le modifiche sono pronte, chiedi al revisore una nuova revisione.

Per evitare la chiusura automatica di una PR, aggiungi l'etichetta `do-not-close`, `pinned` o `work-in-progress`.

<a id="ai-assisted-contributions"></a>

### Contributi con l'aiuto dell'IA

Puoi usare strumenti di IA. Resti pienamente responsabile di ciò che invii.

Se usi strumenti di IA per creare una PR, devi:

- Revisionare e capire ogni modifica importante.
- Spiegare l'implementazione e i compromessi con parole tue.
- Testare personalmente la modifica. Se non puoi testarla nel tuo ambiente, spiega il motivo nella descrizione della PR. Descrivi anche come i revisori possono verificarla.
- Verificare che il codice generato sia corretto, necessario e compatibile con la licenza del progetto.
- Valutare se informare i revisori dell'aiuto dell'IA nella descrizione della PR. Fallo quando l'IA ha modificato molto il codice, i test o il progetto della soluzione. Questo aiuta i revisori a dare commenti migliori.

Non inviare modifiche generate dall'IA che non capisci. Non inviare modifiche che non puoi mantenere durante la revisione. I manutentori possono chiudere una PR che sembra usare molto l'IA. Possono farlo se mancano verifiche umane, una motivazione chiara o risposte durante la revisione.

<a id="writing-style"></a>

### Stile di scrittura

Queste regole si applicano solo ai testi in inglese. Scrivi titoli e testi delle issue, titoli e descrizioni delle PR e messaggi di commit in Simplified Technical English (ASD-STE100). Consulta [ASD-STE100](https://www.asd-ste100.org/). I modelli delle issue e delle PR riportano lo stesso promemoria.

- Usa frasi brevi. Per un'istruzione, usa al massimo 20 parole.
- Usa parole semplici. Scrivi "use", non "utilize". Scrivi "start", non "commence".
- Usa la forma attiva. Scrivi "the parser reads the file", non "the file is read by the parser".
- Esprimi una sola idea in ogni frase.
- Non usare contrazioni, punti e virgola o trattini lunghi.
- Mantieni il titolo breve e specifico.
- Non modificare log esatti, messaggi di errore, identificatori, comandi o prove di riproduzione. Incollali così come sono.

Queste regole sono una guida alla scrittura in inglese. I revisori non controllano la conformità formale ad ASD-STE100. La regola non riguarda il codice, gli identificatori o la sintassi dei comandi.

<a id="legal"></a>

## Aspetti legali

Quando contribuisci, accetti che i tuoi contributi usino la licenza Apache 2.0. È la licenza di Zoo Code.
