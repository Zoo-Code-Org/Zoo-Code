---
"zoo-code": patch
---

fix(terminal): kill entire process group on Stop so child commands (e.g. `sleep 30`) are also killed when the user clicks 'Stop', rather than the shell waiting for them to finish.
