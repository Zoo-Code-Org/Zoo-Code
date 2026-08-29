# PR review label model

`PrReviewLabels.tla` models the review workflow as two independently scheduled systems:

- GitHub changes the PR head, draft state, conflicts, required CI, and reviews.
- The metadata workflow reconciles those facts into one state label, the CodeRabbit activation label, and the advisory review gate.

The `dirty` variable allows webhook delivery and reconciliation to lag. Label and advisory-gate consistency are required whenever reconciliation has settled. The model intentionally does not treat the custom check as an instantaneous enforcement boundary: GitHub's native CI and review state can change before the metadata workflow processes the corresponding webhook.

The finite model checks two head commits and covers:

- pushes and stale reviews;
- draft/ready conversion;
- conflicts;
- required CI pending, failure, success, and reruns;
- automatic and manual-draft CodeRabbit reviews;
- maintainer reviews before and after CodeRabbit;
- delayed or out-of-order reconciliation.

## Run TLC

Download the pinned TLA+ tools release, then run TLC from this directory:

```bash
curl -fsSLO https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar
printf '%s  %s\n' 936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88 tla2tools.jar | sha256sum --check
java -cp tla2tools.jar tlc2.TLC -config PrReviewLabels.cfg PrReviewLabels.tla
```

The JAR is a local tool and must not be committed. Weak fairness on reconciliation checks that metadata eventually converges after asynchronous GitHub events; the model does not claim that CI or reviewers must eventually approve a PR.
