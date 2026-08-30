# PR review label model

`PrReviewLabels.tla` is a bounded policy/interleaving model with two independently scheduled systems:

- GitHub changes the PR head, draft state, conflicts, required CI, and reviews.
- The metadata workflow reconciles those facts into one state label, the CodeRabbit activation label, and the advisory review gate.

The `dirty` variable allows source state and reconciliation to lag. Label and advisory-gate consistency are required whenever reconciliation has settled. `Reconcile` deliberately abstracts metadata writes as one successful atomic action, so this model verifies policy precedence rather than the GitHub API adapter.

The model assumes review events have already been normalized and metadata writes succeed. It does not model token permissions, API errors or limits, webhook delivery guarantees, integration identity, check-run ordering, or changes to third-party comment/status formats. Those boundaries are covered by the executable workflow harness and live branch validation. Weak fairness means reconciliation becomes clean infinitely often; it does not claim permanent convergence while GitHub continues changing the PR.

The finite model checks two head commits and covers:

- pushes and stale reviews;
- draft/ready conversion;
- conflicts;
- required CI pending, failure, success, and reruns;
- automatic and manual-draft CodeRabbit reviews;
- bot-authored PRs that bypass required CodeRabbit review;
- fork PRs whose advisory gate never passes;
- same-head CodeRabbit approval replacement or retraction;
- maintainer reviews before and after CodeRabbit;
- delayed or out-of-order reconciliation.

## Run TLC

Download the pinned TLA+ tools release, then run TLC from this directory:

```bash
curl -fsSLO https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar
printf '%s  %s\n' 936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88 tla2tools.jar | sha256sum --check
java -cp tla2tools.jar tlc2.TLC -config PrReviewLabels.cfg PrReviewLabels.tla
```

The JAR is a local tool and must not be committed. The model does not claim that CI or reviewers eventually approve a PR, or that external APIs eventually accept a metadata write.
