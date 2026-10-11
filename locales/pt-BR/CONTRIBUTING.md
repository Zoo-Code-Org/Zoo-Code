<div align="center">
<sub>

[English](../../CONTRIBUTING.md) • [Català](../ca/CONTRIBUTING.md) • [Deutsch](../de/CONTRIBUTING.md) • [Español](../es/CONTRIBUTING.md) • [Français](../fr/CONTRIBUTING.md) • [हिंदी](../hi/CONTRIBUTING.md) • [Bahasa Indonesia](../id/CONTRIBUTING.md) • [Italiano](../it/CONTRIBUTING.md) • [日本語](../ja/CONTRIBUTING.md)

</sub>
<sub>

[한국어](../ko/CONTRIBUTING.md) • [Nederlands](../nl/CONTRIBUTING.md) • [Polski](../pl/CONTRIBUTING.md) • <b>Português (BR)</b> • [Русский](../ru/CONTRIBUTING.md) • [Türkçe](../tr/CONTRIBUTING.md) • [Tiếng Việt](../vi/CONTRIBUTING.md) • [简体中文](../zh-CN/CONTRIBUTING.md) • [繁體中文](../zh-TW/CONTRIBUTING.md)

</sub>
</div>

<a id="contributing-to-zoo-code"></a>

# Contribuir com o Zoo Code

O Zoo Code é um projeto da comunidade. Valorizamos toda contribuição. Trabalhamos com a abordagem [Issue-First](#issue-first-approach). Isso significa que cada [Pull Request (PR)](#submitting-a-pull-request) precisa ter um link para uma issue do GitHub. Leia este guia com atenção.

<a id="table-of-contents"></a>

## Índice

- [Antes de contribuir](#before-you-contribute)
- [Encontrar e planejar sua contribuição](#finding--planning-your-contribution)
- [Desenvolvimento e envio](#development--submission-process)
    - [Expectativas para Pull Requests](#pull-request-expectations)
    - [Contribuições com ajuda de IA](#ai-assisted-contributions)
    - [Estilo de escrita](#writing-style)
- [Questões legais](#legal)

<a id="before-you-contribute"></a>

## Antes de contribuir

<a id="1-code-of-conduct"></a>

### 1. Código de conduta

Todas as pessoas que contribuem precisam seguir nosso [código de conduta](./CODE_OF_CONDUCT.md).

<a id="2-project-roadmap"></a>

### 2. Plano de desenvolvimento do projeto

Nosso plano de desenvolvimento mostra a direção do projeto. Alinhe suas contribuições com estes objetivos:

<a id="reliability-first"></a>

### Confiabilidade em primeiro lugar

- Faça a edição por diff e a execução de comandos funcionarem de forma confiável todas as vezes.
- Remova os problemas que impedem as pessoas de usar o Zoo Code todos os dias.
- Faça o Zoo Code funcionar em todas as configurações regionais e plataformas.
- Dê suporte a mais provedores e modelos de IA.

<a id="enhanced-user-experience"></a>

### Melhor experiência de uso

- Deixe a UI e a UX claras e fáceis de usar.
- Melhore o fluxo de trabalho. Desenvolvedores esperam alta qualidade das ferramentas que usam todos os dias.

<a id="leading-on-agent-performance"></a>

### Foco no desempenho dos agentes

- Crie benchmarks de avaliação (evals) que meçam a produtividade real.
- Deixe os evals fáceis de executar e de ler.
- Entregue melhorias que aumentem claramente as pontuações dos evals.

Nos seus PRs, diga quais dessas áreas a mudança apoia.

<a id="3-join-the-zoo-code-community"></a>

### 3. Participe da comunidade do Zoo Code

- **Discord:** Participe do nosso [Discord](https://discord.gg/VxfP4Vx3gX).
- **Reddit:** Participe do nosso [Reddit](https://www.reddit.com/r/ZooCode/).

<a id="finding--planning-your-contribution"></a>

## Encontrar e planejar sua contribuição

<a id="types-of-contributions"></a>

### Tipos de contribuição

- **Correções de bugs:** Corrija problemas no código.
- **Novos recursos:** Adicione funções.
- **Documentação:** Melhore os guias e deixe-os mais claros.

<a id="issue-first-approach"></a>

### Abordagem Issue-First

Cada contribuição começa com uma issue do GitHub. Use nossos modelos curtos.

- **Confira as issues existentes**: Pesquise nas [GitHub Issues](https://github.com/Zoo-Code-Org/Zoo-Code/issues).
- **Crie uma issue** usando:
    - **Melhorias:** O modelo "Enhancement Request" (linguagem simples, com foco no benefício para quem usa).
    - **Bugs:** O modelo "Bug Report" (reprodução mínima, resultado esperado e real, versão).
- **Escreva a issue** seguindo o [estilo de escrita](#writing-style) abaixo.
- **Quer trabalhar nela?** Comente "Claiming" na issue. Depois, entre em contato com a equipe principal no [Discord](https://discord.gg/VxfP4Vx3gX) para receber a atribuição. A equipe confirma a atribuição na conversa.
- **PRs precisam ter um link para a issue.** Podemos fechar PRs sem esse link.

<a id="deciding-what-to-work-on"></a>

### Escolher no que trabalhar

- Veja a [página de GitHub Issues](https://github.com/Zoo-Code-Org/Zoo-Code/issues).
- Para documentação, acesse [Zoo Code Docs](https://github.com/Zoo-Code-Org/Zoo-Code-Docs).

<a id="reporting-bugs"></a>

### Relatar bugs

- Primeiro, confira os relatos existentes.
- Crie um novo relato com o [modelo "Bug Report"](https://github.com/Zoo-Code-Org/Zoo-Code/issues/new/choose) e inclua:
    - Passos de reprodução claros e numerados
    - Resultado esperado e resultado real
    - Versão do Zoo Code (obrigatória)
    - Provedor de API e modelo, se forem relevantes
- **Problemas de segurança**: Relate em particular pelos [avisos de segurança](https://github.com/Zoo-Code-Org/Zoo-Code/security/advisories/new).

<a id="development--submission-process"></a>

## Desenvolvimento e envio

<a id="development-setup"></a>

### Preparar o ambiente de desenvolvimento

1. **Faça um fork e clone:**

```
git clone https://github.com/YOUR_USERNAME/Zoo-Code.git
```

2. **Instale as dependências:**

```
pnpm install
```

3. **Depuração:** Abra com o VS Code (`F5`).

<a id="writing-code-guidelines"></a>

### Orientações para escrever código

- Faça um PR focado por recurso ou correção.
- Siga as boas práticas de ESLint e TypeScript.
- Escreva commits claros e descritivos que façam referência às issues (por exemplo, `Fixes #123`). Siga o [estilo de escrita](#writing-style).
- Teste sua mudança por completo (`npm test`).
- Antes de enviar, faça rebase na versão mais recente da branch `main`.

<a id="submitting-a-pull-request"></a>

### Enviar um Pull Request

- Comece como **Draft PR** se quiser receber comentários antes de terminar.
- Descreva suas mudanças com o Pull Request Template. Siga o [estilo de escrita](#writing-style).
- Inclua o link da issue na descrição ou no título do PR (por exemplo, "Fixes #123").
- Adicione capturas de tela ou vídeos para mudanças na UI.
- Diga se a mudança exige atualizações na documentação.

<a id="pull-request-policy"></a>

### Política de Pull Requests

- O PR precisa fazer referência a uma issue do GitHub atribuída a você. Para receber a atribuição, comente "Claiming" na issue. Depois, entre em contato com a equipe principal no [Discord](https://discord.gg/VxfP4Vx3gX). A equipe confirma a atribuição na conversa.
- Podemos fechar PRs sem esse link.
- Um PR precisa passar nos testes de CI, seguir o plano de desenvolvimento e ter documentação clara.

<a id="review-process"></a>

### Processo de revisão

Um PR pronto para revisão precisa atender a estas condições:

- Passar nas verificações obrigatórias de CI.
- Resolver os comentários da revisão que exigem ação.
- Receber uma nova aprovação de um mantenedor ou CODEOWNER. Isso acontece depois que a revisão automática do commit mais recente termina.

A revisão automática pode adicionar um comentário com orientações e etiquetas de estado gerenciadas pelo sistema. Siga o próximo passo indicado no comentário. Não edite as etiquetas por conta própria. Novos commits reiniciam o estado da revisão do código alterado.

A etiqueta `community-approved` mostra uma nova aprovação da comunidade no commit mais recente. O PR então aguarda a revisão de um mantenedor. A etiqueta serve como orientação de prioridade para os mantenedores. Ela não substitui a revisão de um mantenedor nem uma verificação obrigatória. O fluxo de revisão gerencia a etiqueta.

A revisão automática ajuda os mantenedores. Ela não substitui a aprovação humana. Pessoas que contribuem de fora da equipe não podem dar instruções ao CodeRabbit por comentários. Uma revisão que atende aos critérios reinicia sozinha depois que o CI obrigatório passa. Os mantenedores cuidam dos reinícios excepcionais. Os avisos são orientações, salvo se a política do repositório disser o contrário. As verificações obrigatórias nativas do GitHub, as regras de CODEOWNER e as proteções de revisão decidem se um PR pode ser integrado.

- **Triagem diária:** Os mantenedores fazem verificações rápidas.
- **Revisão detalhada semanal:** Os mantenedores fazem uma avaliação completa.
- **Faça ajustes rapidamente** quando receber comentários.

<a id="pull-request-expectations"></a>

### Expectativas para Pull Requests

Um PR precisa ser fácil de revisar, testado e fácil de manter. Antes de abrir um PR, confira estes pontos:

- A mudança trata de uma única issue, bug ou melhoria específica.
- Você consegue explicar o que a mudança faz e por que está correta.
- Você testou a mudança no seu computador, quando possível.
- Você vai responder aos comentários da revisão e fazer ajustes posteriores razoáveis.
- Os mantenedores não precisam reescrever, redesenhar ou assumir a responsabilidade pela mudança antes de integrá-la.

Os mantenedores podem fechar um PR por estes motivos:

- Está incompleto.
- Tem um escopo amplo demais.
- Está inativo.
- Não segue a direção do projeto.
- Cria trabalho demais de revisão ou manutenção.

Fechar um PR não é um julgamento sobre quem contribui. Significa que os mantenedores não podem aceitar a mudança na forma atual.

Um bot também fecha PRs automaticamente:

- **60 dias de inatividade:** O bot marca um PR como inativo após 60 dias sem atividade. Se não houver atividade por mais 7 dias, o bot fecha o PR. Um novo comentário, commit ou revisão reinicia o contador.
- **14 dias de inatividade do autor:** Quando alguém solicita mudanças na revisão, o bot adiciona a etiqueta `awaiting-author`. A atividade do autor reinicia o contador de inatividade. Quando as mudanças estiverem prontas, peça uma nova revisão à pessoa que revisou.

Para impedir o fechamento automático de um PR, adicione a etiqueta `do-not-close`, `pinned` ou `work-in-progress`.

<a id="ai-assisted-contributions"></a>

### Contribuições com ajuda de IA

Você pode usar ferramentas de IA. Ainda é totalmente responsável pelo que envia.

Se usar ferramentas de IA para ajudar a criar um PR, você precisa:

- Revisar e entender cada mudança importante.
- Explicar a implementação e as escolhas envolvidas com suas próprias palavras.
- Testar a mudança por conta própria. Se não puder testar no seu ambiente, explique o motivo na descrição do PR. Descreva também como as pessoas que revisam podem verificar a mudança.
- Conferir se o código gerado está correto, é necessário e é compatível com a licença do projeto.
- Considerar informar sobre a ajuda de IA na descrição do PR. Faça isso quando a IA tiver alterado muito o código, os testes ou o projeto da solução. Isso ajuda a receber comentários melhores na revisão.

Não envie mudanças geradas por IA que você não entende. Não envie mudanças que não consegue manter durante a revisão. Os mantenedores podem fechar um PR que pareça ter usado muita ajuda de IA. Podem fazer isso se não houver verificação humana, motivo claro ou acompanhamento na revisão.

<a id="writing-style"></a>

### Estilo de escrita

Estas regras se aplicam apenas a textos em inglês. Escreva títulos e textos de issues, títulos e descrições de PRs e mensagens de commit em Simplified Technical English (ASD-STE100). Veja [ASD-STE100](https://www.asd-ste100.org/). Os modelos de issue e PR trazem o mesmo lembrete.

- Use frases curtas. Use no máximo 20 palavras para uma instrução.
- Use palavras simples. Escreva "use", não "utilize". Escreva "start", não "commence".
- Use a voz ativa. Escreva "the parser reads the file", não "the file is read by the parser".
- Escreva uma ideia em cada frase.
- Não use contrações, ponto e vírgula ou travessões.
- Mantenha o título curto e específico.
- Não altere logs exatos, mensagens de erro, identificadores, comandos ou evidências de reprodução. Cole tudo como está.

Estas regras são orientações para escrever em inglês. Quem revisa não verifica conformidade formal com ASD-STE100. Código, identificadores e sintaxe de comandos não fazem parte desta regra.

<a id="legal"></a>

## Questões legais

Ao contribuir, você concorda que suas contribuições usem a licença Apache 2.0. Essa é a licença do Zoo Code.
