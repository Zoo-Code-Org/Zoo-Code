---
"zoo-code": patch
---

Fix unreliable automatic context condensing on the VS Code LM (vscode-lm) provider. The condense gate now treats the provider's `maxTokens: -1` (unlimited) as the default output reserve and measures usage against available input space, and a new `getCondenseContextWindow()` seam makes the gate use the curated model `maxInputTokens` instead of the inflated live window. Also refreshes the VS Code LM model catalog and default model.
