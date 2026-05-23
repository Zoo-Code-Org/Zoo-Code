---
"zoo-code": patch
---

Terminate the running command when a task is cancelled or torn down (#245). Pressing cancel (✕) now aborts the underlying terminal process instead of leaving it running while the terminal stays stuck "busy" until a manual kill.
