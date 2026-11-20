---- MODULE McpToolBoundaryMC ----
\* Length classes include the provider limit and an oversized persisted name.
EXTENDS Naturals

MCInputs == [length : {12, 63, 64, 65, 4096}, parses : BOOLEAN,
             lookup : {"unique", "missing", "ambiguous"}, truncatedAlias : BOOLEAN]

====
