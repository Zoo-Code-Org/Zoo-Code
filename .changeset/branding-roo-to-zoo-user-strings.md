---
"zoo-code": patch
---

Replace remaining user-facing "Roo" brand strings with "Zoo" across the extension: webview and editor tab titles, terminal names, diff editor labels, VS Code LM authorization prompts, LM Studio error messages, output channel messages, and the missing-tool-parameter error notice (now localized via `tools:missingToolParameter[WithPath]` keys across all 16 locales). Also update corresponding strings in webview-ui localization files (chat, settings, prompts).

References to the external Roo provider/router remain unchanged: the `roo` provider id, `.roo*` config files, `errors.roo`/`info.roo` i18n keys, router-removal notices, Roo Cloud sign-in/credit-balance messages, i18n key paths, attribution headers, and console logs.
