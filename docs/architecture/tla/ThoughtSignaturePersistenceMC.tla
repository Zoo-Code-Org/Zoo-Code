---- MODULE ThoughtSignaturePersistenceMC ----
\* Sabotage: history can save an ID fallback while the stream still drains.
EXTENDS ThoughtSignaturePersistence
SaveBeforeDrain == FALSE
====
