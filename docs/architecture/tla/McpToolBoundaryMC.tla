---- MODULE McpToolBoundaryMC ----
\* Source: McpToolBoundary actions. Sink: TLC with the six McpToolBoundaryMC configs.
\* Failure: the behavior module imports its checking domain. Rule: this wrapper extends the behavior module.
\* Expect: the fixed run and all five fault runs keep their results. Cost and findings are in McpToolBoundary.
EXTENDS McpToolBoundary

\* Lengths represent below, at, and above the limit. Missing and ambiguous lookups both use "unresolved".
\* A truncated alias has 64 characters. Both parser oracle results remain in each input class.
MCInputs == {i \in [length : {63, 64, 65}, parses : BOOLEAN,
                    lookup : {"unique", "unresolved"}, truncatedAlias : BOOLEAN] :
                i.truncatedAlias => i.length = 64}

====
