<p align="center">
          <a href="https://marketplace.visualstudio.com/items?itemName=ZooCodeOrganization.zoo-code"><img src="https://img.shields.io/badge/VS_Code_Marketplace-007ACC?style=flat&logo=visualstudiocode&logoColor=white" alt="VS Code Marketplace"></a>
          <a href="https://x.com/ZooCodeDev"><img src="https://img.shields.io/badge/ZooCode-000000?style=flat&logo=x&logoColor=white" alt="X"></a>
          <a href="https://discord.gg/VxfP4Vx3gX"><img src="https://img.shields.io/badge/Join%20Discord-5865F2?style=flat&logo=discord&logoColor=white" alt="Join Discord"></a>
          <a href="https://www.reddit.com/r/ZooCode/"><img src="https://img.shields.io/badge/Join%20r%2FZooCode-FF4500?style=flat&logo=reddit&logoColor=white" alt="Join r/ZooCode"></a>
          <a href="https://github.com/Zoo-Code-Org/Zoo-Code/issues"><img src="https://img.shields.io/badge/GitHub-Issues-181717?style=flat&logo=github&logoColor=white" alt="GitHub Issues"></a>
        </p>
        <p align="center">
          <em>Receba ajuda rápido → <a href="https://discord.gg/VxfP4Vx3gX">Entre no Discord</a> • Prefere algo assíncrono? → <a href="https://www.reddit.com/r/ZooCode/">Entre no r/ZooCode</a></em>
        </p>

        # Zoo Code

        > Seu time de desenvolvimento com IA, direto no seu editor

        ## Somos Zoo Code

> O Zoo Code dá continuidade ao desenvolvimento deste projeto depois que a
> equipe do Roo encerrou o desenvolvimento ativo do Roo Code para se
> concentrar no [Roomote](https://roomote.dev/). Obrigado à equipe do Roo
> por tudo o que construíram.
>
> A equipe principal é formada por desenvolvedores que já contribuíram com
> o Roo antes e se importam profundamente com esse plugin. Vamos continuar
> fazendo atualizações de modelos, corrigindo bugs e lançando recursos, e
> pretendemos ouvir com atenção a comunidade que tornou esse plugin tão
> especial. Junte-se a nós no
> [Discord](https://discord.gg/VxfP4Vx3gX),
> [Reddit](https://www.reddit.com/r/ZooCode), ou
> [abra um PR ou issue](https://github.com/Zoo-Code-Org/Zoo-Code).
>
> _-Zoo Code Team_

## Migração do Roo Code para o Zoo Code

Você encontra um guia rápido para migrar do Roo Code para o Zoo Code no [guia de migração Roo→Zoo](https://docs.zoocode.dev/roo-to-zoo-migration). Queremos ajudar os usuários durante essa transição da melhor forma possível, e é exatamente para isso que temos nosso [Reddit](https://www.reddit.com/r/ZooCode) e nosso [Discord](https://discord.gg/VxfP4Vx3gX). Se você tiver algum problema ou dúvida, apareça por lá e pergunte.

## O que o Zoo Code adicionou desde o Roo Code

O Zoo Code aproveita a base criada pelo Roo Code e continua ampliando-a com:

- **Inteligência de codebase do Semble** — busca semântica de código rápida e sob demanda, com configuração automática e sem um workflow de indexação separado.
- **Workflows de Orchestrator mais robustos** — delegação mais segura, coordenação paralela de tarefas, recuperação confiável de tarefas principais e secundárias e melhor isolamento entre subtarefas e perfis de provider.
- **Execuções autônomas mais longas com o Destructive Command Guard (DCG)** — bloqueia automaticamente comandos perigosos enquanto o trabalho confiável continua sem solicitações repetidas de aprovação.
- **Os modelos mais recentes** — suporte contínuo a novas famílias de modelos Claude, GPT, Gemini, Kimi, GLM, Grok, MiniMax e outras.
- **Mais formas de conexão** — providers novos e ampliados, incluindo Zoo Gateway, Moonshot, Kimi Code, Kenari, Friendli, OpenCode Go e muitos outros.
- **Workflows de terminal e edição mais confiáveis** — correções para encerramento prematuro do terminal, race conditions no estado das tarefas, gerenciamento de contexto, edição de diff e uso de ferramentas específicas de cada provider.
- **Mais controle sobre seu workspace** — gerenciamento de regras, restrições de MCP por modo, controles de caminhos multi-root, opções de reasoning dos modelos e ações para revisar alterações ao concluir uma tarefa.

## Novidades na v3.78.0

- **Três novos modelos importantes chegaram** — use os novíssimos Gemini 3.7 Flash, GLM 5.3 e Qwen3.8 Max, além das atualizações de reasoning, preços e cobertura de providers do DeepSeek V4.
- **Conecte-se ao NanoGPT** — use descoberta dinâmica de modelos, streaming e conclusão de prompts, com preferências de roteamento por velocidade, preço, latência, throughput, suporte a ferramentas e cache.
- **Providers e tarefas mais confiáveis** — as correções melhoram a configuração de endpoints do Azure OpenAI, os limites de saída do Kimi Code, a preservação de títulos no histórico de tarefas e a importação/exportação das configurações do Zoo.
- O Destructive Command Guard agora oferece suporte a Macs com processadores Intel.
- Atualizações de segurança corrigem vulnerabilidades no `undici` e no Mermaid.

## O que o Zoo Code pode fazer por VOCÊ?

- Gerar código a partir de descrições em linguagem natural
- Adapte-se com os Modos: Código, Arquiteto, Pergunta, Depuração e Modos Personalizados
- Refatorar e depurar código existente
- Escrever e atualizar documentação
- Responder a perguntas sobre sua base de código
- Automatizar tarefas repetitivas
- Utilizar servidores MCP

## Modos

O Zoo Code se adapta à sua maneira de trabalhar, e não o contrário:

- Modo Código: codificação diária, edições e operações de arquivo
- Modo Arquiteto: planeje sistemas, especificações e migrações
- Modo Pergunta: respostas rápidas, explicações e documentos
- Modo Depuração: rastreie problemas, adicione logs, isole as causas raiz
- Modos Personalizados: crie modos especializados para sua equipe ou fluxo de trabalho

Saiba mais: [Usar Modos](https://docs.zoocode.dev/basic-usage/using-modes) • [Modos personalizados](https://docs.zoocode.dev/advanced-usage/custom-modes)

## Recursos

- **[Documentação](https://docs.zoocode.dev):** O guia oficial para instalar, configurar e dominar o Zoo Code.
- **[Servidor do Discord](https://discord.gg/VxfP4Vx3gX):** Junte-se à comunidade para ajuda e discussão em tempo real.
- **[Comunidade do Reddit](https://www.reddit.com/r/ZooCode):** Compartilhe suas experiências e veja o que os outros estão construindo.
- **[Issues do GitHub](https://github.com/Zoo-Code-Org/Zoo-Code/issues):** Relate bugs e acompanhe o desenvolvimento.
- **[Solicitações de recursos](https://github.com/Zoo-Code-Org/Zoo-Code/discussions/categories/feature-requests?discussions_q=is%3Aopen+category%3A%22Feature+Requests%22+sort%3Atop):** Tem uma ideia? Compartilhe com os desenvolvedores.

---

## Configuração e Desenvolvimento Local

1. **Clone** o repositório:

```sh
git clone https://github.com/Zoo-Code-Org/Zoo-Code.git
```

2. **Instale as dependências**:

```sh
pnpm install
```

3. **Execute a extensão**:

Existem várias maneiras de executar a extensão Zoo Code:

### Modo de Desenvolvimento (F5)

Para desenvolvimento ativo, use a depuração incorporada do VSCode:

Pressione `F5` (ou vá para **Executar** → **Iniciar Depuração**) no VSCode. Isso abrirá uma nova janela do VSCode com a extensão Zoo Code em execução.

- As alterações na visualização da web aparecerão imediatamente.
- As alterações na extensão principal também serão recarregadas automaticamente.

### Instalação automatizada de VSIX

Para construir e instalar a extensão como um pacote VSIX diretamente no VSCode:

```sh
pnpm install:vsix [-y] [--editor=<command>]
```

Este comando irá:

- Perguntar qual comando do editor usar (code/cursor/code-insiders) - o padrão é 'code'
- Desinstalar qualquer versão existente da extensão.
- Construir o pacote VSIX mais recente.
- Instalar o VSIX recém-construído.
- Solicitar que você reinicie o VS Code para que as alterações entrem em vigor.

Opções:

- `-y`: Pular todos os prompts de confirmação e usar os padrões
- `--editor=<command>`: Especifique o comando do editor (por exemplo, `--editor=cursor` ou `--editor=code-insiders`)

### Instalação Manual de VSIX

Se preferir instalar o pacote VSIX manualmente:

1.  Primeiro, construa o pacote VSIX:
    ```sh
    pnpm vsix
    ```
2.  Um arquivo `.vsix` será gerado no diretório `bin/` (por exemplo, `bin/zoo-code-<version>.vsix`).
3.  Instale-o manualmente usando a CLI do VSCode:
    ```sh
    code --install-extension bin/zoo-code-<version>.vsix
    ```

---

Usamos [changesets](https://github.com/changesets/changesets) para versionamento e publicação. Verifique nosso `CHANGELOG.md` para notas de lançamento.

---

## Isenção de responsabilidade

**Observe** que a Zoo Code **não** faz representações ou garantias em relação a qualquer código, modelos ou outras ferramentas fornecidas ou disponibilizadas em conexão com o Zoo Code, quaisquer ferramentas de terceiros associadas ou quaisquer saídas resultantes. Você assume **todos os riscos** associados ao uso de tais ferramentas ou saídas; tais ferramentas são fornecidas **"COMO ESTÃO"** e **"CONFORME DISPONÍVEIS"**. Tais riscos podem incluir, sem limitação, violação de propriedade intelectual, vulnerabilidades ou ataques cibernéticos, viés, imprecisões, erros, defeitos, vírus, tempo de inatividade, perda ou dano de propriedade e/ou lesões pessoais. Você é o único responsável pelo uso de tais ferramentas ou saídas (incluindo, sem limitação, a legalidade, adequação e resultados das mesmas).

---

## Contribuindo

Adoramos contribuições da comunidade! Comece lendo nosso [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Licença

[Apache 2.0 © 2025 Zoo Code Org](../../LICENSE)

---

**Aproveite o Zoo Code!** Seja mantendo tudo na coleira curta ou deixando-o vagar de forma autônoma, mal podemos esperar para ver o que você vai construir. Se você tiver perguntas ou ideias de recursos, abra uma [issue](https://github.com/Zoo-Code-Org/Zoo-Code/issues) ou inicie uma [discussion](https://github.com/Zoo-Code-Org/Zoo-Code/discussions). Bom código!
