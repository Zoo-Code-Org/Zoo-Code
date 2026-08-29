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
printf '%s  %s\n' bee4a54f3ee3d4afc347c3240ec2d9e93b075104 tla2tools.jar | sha1sum --check
java -cp tla2tools.jar tlc2.TLC -config PrReviewLabels.cfg PrReviewLabels.tla
```

The JAR is a local tool and must not be committed.
