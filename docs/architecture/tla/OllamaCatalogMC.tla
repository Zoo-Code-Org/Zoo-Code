---- MODULE OllamaCatalogMC ----
\* Two callers and two rounds cover cancellation, reuse, and retry.
EXTENDS OllamaCatalog
MCClients == {1, 2}
MCRounds == 2
MCFallback == 128000
MCDiscovered == 1000000
====
