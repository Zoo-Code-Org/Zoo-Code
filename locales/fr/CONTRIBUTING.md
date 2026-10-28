<div align="center">
<sub>

[English](../../CONTRIBUTING.md) • [Català](../ca/CONTRIBUTING.md) • [Deutsch](../de/CONTRIBUTING.md) • [Español](../es/CONTRIBUTING.md) • <b>Français</b> • [हिंदी](../hi/CONTRIBUTING.md) • [Bahasa Indonesia](../id/CONTRIBUTING.md) • [Italiano](../it/CONTRIBUTING.md) • [日本語](../ja/CONTRIBUTING.md)

</sub>
<sub>

[한국어](../ko/CONTRIBUTING.md) • [Nederlands](../nl/CONTRIBUTING.md) • [Polski](../pl/CONTRIBUTING.md) • [Português (BR)](../pt-BR/CONTRIBUTING.md) • [Русский](../ru/CONTRIBUTING.md) • [Türkçe](../tr/CONTRIBUTING.md) • [Tiếng Việt](../vi/CONTRIBUTING.md) • [简体中文](../zh-CN/CONTRIBUTING.md) • [繁體中文](../zh-TW/CONTRIBUTING.md)

</sub>
</div>

<a id="contributing-to-zoo-code"></a>

# Contribuer à Zoo Code

Zoo Code est un projet communautaire. Chaque contribution compte pour nous. Nous suivons l'approche [d'abord une issue](#issue-first-approach). Chaque [Pull Request (PR)](#submitting-a-pull-request) doit donc être liée à une issue GitHub. Lis ce guide avec attention.

<a id="table-of-contents"></a>

## Table des matières

- [Avant de contribuer](#before-you-contribute)
- [Trouver et planifier ta contribution](#finding--planning-your-contribution)
- [Développement et soumission](#development--submission-process)
    - [Attentes pour les Pull Requests](#pull-request-expectations)
    - [Contributions avec l'aide de l'IA](#ai-assisted-contributions)
    - [Style d'écriture](#writing-style)
- [Aspects juridiques](#legal)

<a id="before-you-contribute"></a>

## Avant de contribuer

<a id="1-code-of-conduct"></a>

### 1. Code de conduite

Tous les contributeurs doivent suivre notre [code de conduite](./CODE_OF_CONDUCT.md).

<a id="2-project-roadmap"></a>

### 2. Feuille de route du projet

Notre feuille de route montre la direction du projet. Aligne tes contributions sur ces objectifs :

<a id="reliability-first"></a>

### La fiabilité d'abord

- Rends l'édition par diff et l'exécution de commandes fiables à chaque fois.
- Supprime les problèmes qui empêchent les gens d'utiliser Zoo Code chaque jour.
- Fais fonctionner Zoo Code dans toutes les langues et sur toutes les plateformes.
- Ajoute la prise en charge de plus de fournisseurs et de modèles d'IA.

<a id="enhanced-user-experience"></a>

### Une meilleure expérience utilisateur

- Rends l'UI et l'UX claires et faciles à utiliser.
- Améliore le flux de travail. Les développeurs attendent un niveau élevé des outils qu'ils utilisent chaque jour.

<a id="leading-on-agent-performance"></a>

### Être en tête sur les performances des agents

- Crée des tests d'évaluation (evals) qui mesurent la productivité en conditions réelles.
- Rends les evals faciles à exécuter et à lire.
- Publie des améliorations qui augmentent clairement les scores des evals.

Dans tes PRs, indique quels domaines le changement aide à améliorer.

<a id="3-join-the-zoo-code-community"></a>

### 3. Rejoins la communauté Zoo Code

- **Discord :** Rejoins notre [Discord](https://discord.gg/VxfP4Vx3gX).
- **Reddit :** Rejoins notre [Reddit](https://www.reddit.com/r/ZooCode/).

<a id="finding--planning-your-contribution"></a>

## Trouver et planifier ta contribution

<a id="types-of-contributions"></a>

### Types de contributions

- **Corrections de bugs :** Corrige les problèmes du code.
- **Nouvelles fonctionnalités :** Ajoute des fonctions.
- **Documentation :** Améliore les guides et rends-les plus clairs.

<a id="issue-first-approach"></a>

### D'abord une issue

Chaque contribution commence par une issue GitHub. Utilise nos modèles courts.

- **Vérifie les issues existantes** : Cherche dans les [GitHub Issues](https://github.com/Zoo-Code-Org/Zoo-Code/issues).
- **Crée une issue** avec :
    - **Améliorations :** Le modèle "Enhancement Request" (langage simple centré sur le bénéfice pour l'utilisateur).
    - **Bugs :** Le modèle "Bug Report" (reproduction minimale, résultat attendu et réel, version).
- **Rédige l'issue** avec le [style d'écriture](#writing-style) décrit plus bas.
- **Tu veux t'en occuper ?** Ajoute le commentaire "Claiming" à l'issue. Contacte ensuite l'équipe principale sur [Discord](https://discord.gg/VxfP4Vx3gX) pour qu'elle te l'attribue. L'équipe principale confirme l'attribution dans le fil.
- **Les PRs doivent être liées à l'issue.** Nous pouvons fermer les PRs sans ce lien.

<a id="deciding-what-to-work-on"></a>

### Choisir sur quoi travailler

- Consulte la [page GitHub Issues](https://github.com/Zoo-Code-Org/Zoo-Code/issues).
- Pour la documentation, va sur [Zoo Code Docs](https://github.com/Zoo-Code-Org/Zoo-Code-Docs).

<a id="reporting-bugs"></a>

### Signaler des bugs

- Vérifie d'abord les signalements existants.
- Crée un nouveau signalement avec le [modèle "Bug Report"](https://github.com/Zoo-Code-Org/Zoo-Code/issues/new/choose) et ces informations :
    - Des étapes de reproduction claires et numérotées
    - Le résultat attendu et le résultat réel
    - La version de Zoo Code (obligatoire)
    - Le fournisseur d'API et le modèle, s'ils sont pertinents
- **Problèmes de sécurité** : Signale-les en privé avec les [avis de sécurité](https://github.com/Zoo-Code-Org/Zoo-Code/security/advisories/new).

<a id="development--submission-process"></a>

## Développement et soumission

<a id="development-setup"></a>

### Préparer l'environnement de développement

1. **Crée un fork et clone le dépôt :**

```
git clone https://github.com/YOUR_USERNAME/Zoo-Code.git
```

2. **Installe les dépendances :**

```
pnpm install
```

3. **Débogage :** Ouvre le projet avec VS Code (`F5`).

<a id="writing-code-guidelines"></a>

### Conseils pour écrire du code

- Une PR ciblée par fonctionnalité ou correction.
- Suis les bonnes pratiques d'ESLint et de TypeScript.
- Écris des commits clairs et descriptifs qui font référence aux issues (par exemple, `Fixes #123`). Suis le [style d'écriture](#writing-style).
- Teste ton changement à fond (`npm test`).
- Fais un rebase sur la dernière version de la branche `main` avant de soumettre ta PR.

<a id="submitting-a-pull-request"></a>

### Soumettre une Pull Request

- Commence par une **PR en brouillon** si tu veux des retours tôt.
- Décris tes changements avec le modèle Pull Request Template. Suis le [style d'écriture](#writing-style).
- Lie l'issue dans la description ou le titre de la PR (par exemple, "Fixes #123").
- Ajoute des captures d'écran ou des vidéos pour les changements d'UI.
- Indique si le changement nécessite une mise à jour de la documentation.

<a id="pull-request-policy"></a>

### Règles pour les Pull Requests

- La PR doit faire référence à une issue GitHub attribuée. Pour obtenir l'attribution, ajoute le commentaire "Claiming" à l'issue. Contacte ensuite l'équipe principale sur [Discord](https://discord.gg/VxfP4Vx3gX). L'équipe principale confirme l'attribution dans le fil.
- Nous pouvons fermer les PRs sans ce lien.
- Une PR doit réussir les tests de CI, suivre la feuille de route et avoir une documentation claire.

<a id="review-process"></a>

### Processus de revue

Une PR prête pour la revue doit remplir ces conditions :

- Elle réussit les vérifications de CI obligatoires.
- Elle répond aux retours de revue qui demandent une action.
- Elle reçoit une nouvelle approbation d'un mainteneur ou CODEOWNER. Cela se produit après la fin de la revue automatisée du dernier commit.

La revue automatisée peut ajouter un commentaire d'orientation et des labels d'état gérés par le processus. Suis l'étape suivante du commentaire. Ne modifie pas les labels toi-même. Les nouveaux commits réinitialisent l'état de revue du code modifié.

Le label `community-approved` indique une nouvelle approbation de la communauté sur le dernier commit. La PR attend ensuite la revue d'un mainteneur. Ce label donne aux mainteneurs une indication de priorité. Il ne remplace ni la revue d'un mainteneur ni une vérification obligatoire. Le processus de revue gère ce label.

La revue automatisée aide les mainteneurs. Elle ne remplace pas l'approbation humaine. Les contributeurs externes ne peuvent pas donner d'instructions à CodeRabbit par des commentaires. Une revue qui remplit les conditions redémarre seule après la réussite de la CI obligatoire. Les mainteneurs gèrent les redémarrages exceptionnels. Les avertissements sont indicatifs, sauf si les règles du dépôt disent le contraire. Les vérifications obligatoires de GitHub, les règles CODEOWNER et les protections de revue déterminent si une PR peut être fusionnée.

- **Triage quotidien :** Les mainteneurs font des vérifications rapides.
- **Revue hebdomadaire approfondie :** Les mainteneurs font une évaluation complète.
- **Fais les ajustements rapidement** quand tu reçois des retours.

<a id="pull-request-expectations"></a>

### Attentes pour les Pull Requests

Une PR doit être facile à examiner, testée et facile à maintenir. Avant d'ouvrir une PR, vérifie ces points :

- Le changement traite une issue, un bug ou une amélioration précise.
- Tu peux expliquer ce que fait le changement et pourquoi il est correct.
- Tu as testé le changement sur ton ordinateur quand c'était possible.
- Tu répondras aux retours de revue et feras les ajustements raisonnables demandés.
- Les mainteneurs ne doivent pas réécrire, reconcevoir ou reprendre le changement avant de pouvoir le fusionner.

Les mainteneurs peuvent fermer une PR pour ces raisons :

- Elle est incomplète.
- Elle est trop large.
- Elle est inactive.
- Elle ne suit pas la direction du projet.
- Elle demande trop de travail de revue ou de maintenance.

Fermer une PR n'est pas un jugement sur le contributeur. Cela signifie que les mainteneurs ne peuvent pas accepter le changement sous sa forme actuelle.

Un bot ferme aussi des PRs automatiquement :

- **60 jours d'inactivité :** Le bot marque une PR comme inactive après 60 jours sans activité. Si elle reste inactive pendant 7 jours de plus, il la ferme. Un nouveau commentaire, commit ou une nouvelle revue réinitialise le compteur.
- **14 jours d'inactivité de l'auteur :** Quand un réviseur demande des changements, le bot ajoute le label `awaiting-author`. L'activité de l'auteur réinitialise le compteur d'inactivité. Quand les changements sont prêts, demande une nouvelle revue au réviseur.

Pour empêcher la fermeture automatique d'une PR, ajoute le label `do-not-close`, `pinned` ou `work-in-progress`.

<a id="ai-assisted-contributions"></a>

### Contributions avec l'aide de l'IA

Tu peux utiliser des outils d'IA. Tu restes entièrement responsable de ce que tu soumets.

Si tu utilises des outils d'IA pour créer une PR, tu dois :

- Examiner et comprendre chaque changement important.
- Expliquer l'implémentation et les compromis avec tes propres mots.
- Tester le changement toi-même. Si tu ne peux pas le tester dans ton environnement, explique pourquoi dans la description de la PR. Décris aussi comment les réviseurs peuvent vérifier le changement.
- Vérifier que le code généré est correct, nécessaire et compatible avec la licence du projet.
- Envisager de mentionner l'aide de l'IA dans la description de la PR. Fais-le quand cette aide a beaucoup changé le code, les tests ou la conception. Cela aide les réviseurs à donner de meilleurs retours.

Ne soumets pas de changements générés par l'IA que tu ne comprends pas. Ne soumets pas de changements que tu ne peux pas maintenir pendant la revue. Les mainteneurs peuvent fermer une PR qui semble avoir reçu beaucoup d'aide de l'IA. Ils peuvent le faire s'il manque une vérification humaine, une raison claire ou un suivi pendant la revue.

<a id="writing-style"></a>

### Style d'écriture

Ces règles s'appliquent aux textes en anglais. Écris les titres et textes des issues, les titres et descriptions des PRs et les messages de commit en [Simplified Technical English (ASD-STE100)](https://www.asd-ste100.org/). Les modèles d'issues et de PRs donnent le même rappel.

- Utilise des phrases courtes. Utilise 20 mots ou moins pour une instruction.
- Utilise des mots simples. Écris "use", pas "utilize". Écris "start", pas "commence".
- Utilise la voix active. Écris "the parser reads the file", pas "the file is read by the parser".
- Écris une idée par phrase.
- N'utilise pas de formes contractées, de points-virgules ou de tirets cadratins.
- Garde le titre court et précis.
- Ne modifie pas les journaux, messages d'erreur, identifiants, commandes ou preuves de reproduction exacts. Colle-les tels quels.

Ces règles sont des conseils d'écriture. Les réviseurs ne vérifient pas la conformité formelle à ASD-STE100. Le code, les identifiants et la syntaxe des commandes ne sont pas concernés par cette règle.

<a id="legal"></a>

## Aspects juridiques

En contribuant, tu acceptes que tes contributions utilisent la licence Apache 2.0. C'est la licence de Zoo Code.
