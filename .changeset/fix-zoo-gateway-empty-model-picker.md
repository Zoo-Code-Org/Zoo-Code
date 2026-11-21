---
"zoo-code": patch
---

Fix the Zoo Gateway model picker sometimes showing an empty list.

- Signing in now refreshes the model list in the settings panel. Before, the list could stay empty until the panel was reopened.
- A failed or slow model request no longer replaces a working list with an empty one. The last catalog from this session is kept, and the catalog is revalidated with ETags instead of being downloaded on every open.
- When the session has expired, model discovery now signs you out and shows the sign-in prompt instead of an empty list next to "Authenticated".
- Thinking models on Zoo Gateway now show their reasoning in the chat.
