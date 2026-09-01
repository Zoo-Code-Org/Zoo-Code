---
"zoo-code": patch
---

Fix commands run by Zoo Code forcing `LANG`/`LC_ALL` to `en_US.UTF-8` even when the system already has a correctly configured non-US UTF-8 locale (e.g. `en_AU.UTF-8`), which caused a `setlocale: LC_ALL: cannot change locale` warning on every command for anyone whose system locale isn't `en_US.UTF-8`. The existing locale is now preserved when it already specifies a UTF-8 encoding; only an unset locale or an encoding-less POSIX default (`C`/`POSIX`) falls back to `en_US.UTF-8`, and a locale with a non-UTF-8 encoding has its encoding upgraded while its language/territory is kept.
