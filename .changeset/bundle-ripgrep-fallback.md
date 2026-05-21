---
"zoo-code": patch
---

Bundle a ripgrep binary with the extension and fall back to it when ripgrep cannot be located in the VS Code installation. Fixes "Could not find ripgrep binary" errors that break search_files / list_files on VS Code Insiders' newer staged-install layout.
