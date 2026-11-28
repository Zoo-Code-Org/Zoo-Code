---- MODULE McpToolSelectionLifecycleMC ----
\* Source: McpToolSelectionLifecycle actions. Sink: TLC with the config files.
\* Failure: the behavior module imports its checking domain. Rule: this wrapper extends the behavior module.
\* Expect: Fixed holds. Each variant fails the invariant named in the behavior module header.
EXTENDS McpToolSelectionLifecycle

\* Two topic groups with partial overlap. Small enough for exhaustive search.
MCCatalog == {"jira_1", "jira_2", "slack_1", "slack_2", "sentry_1"}
MCTopicA == {"jira_1", "jira_2", "sentry_1"}
MCTopicB == {"slack_1", "slack_2"}

\* -2 is unset, -1 is invalid. 0 turns dynamic loading off. 2 is a valid value below the default.
MCStoredValues == {-2, -1, 0, 2}

====
