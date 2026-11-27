---- MODULE McpOAuthRedirectUrl ----
\* Source: StreamableHTTPClientTransport auth() builds the authorization URL from
\* provider.redirectUrl before McpOAuthClientProvider.redirectToAuthorization runs.
\* Sink: McpHub._completeOAuthFlow opens the stored URL with authProvider.openBrowser().
\* Failure: the opened URL carries redirect_uri port 0, because a cached client
\* returns early from registerClientIfNeeded() and never starts the listener.
\* Invariant: NoBadOpen. The opened URL redirect_uri equals the active listener
\* port and is never 0.
\* Fix rule: redirectToAuthorization starts the listener first, then overrides
\* redirect_uri. The rule covers the first connect and a later 401.
\* Scope: registerClientIfNeeded and openBrowser are oracles. The listener starts
\* only inside those two calls, as in the code. A listener that dies between the
\* URL store and the open is out of scope; the next flow stores a fresh URL.
\* A strict server that rejects a changed port is out of scope (issue follow-up).
\* Result: Fixed holds in 5 states. NoOverride fails at 4 states. NoEnsure fails
\* at 3 states. No additional failure was found.
\* Property test: src/services/mcp/__tests__/mcp-oauth-flow.property.spec.ts.

CONSTANTS FixRedirectUri   \* TRUE when redirectToAuthorization overrides redirect_uri
CONSTANTS EnsureListener   \* TRUE when redirectToAuthorization starts the listener first
CONSTANTS CachedClient     \* TRUE when the client registration is cached and skips DCR

VARIABLES listenerPort   \* port of the active callback listener; 0 when none
VARIABLES sdkUrlPort     \* redirect_uri port the SDK wrote into the URL
VARIABLES finalUrlPort   \* redirect_uri port on the URL after redirectToAuthorization
VARIABLES urlStored      \* redirectToAuthorization stored the URL for openBrowser
VARIABLES opened         \* the URL was opened for the user
VARIABLES badOpen        \* latch: an open used a stale or zero port

vars == <<listenerPort, sdkUrlPort, finalUrlPort, urlStored, opened, badOpen>>

Init ==
    /\ listenerPort = 0
    /\ sdkUrlPort = 0
    /\ finalUrlPort = 0
    /\ urlStored = FALSE
    /\ opened = FALSE
    /\ badOpen = FALSE

\* registerClientIfNeeded: a fresh DCR starts the listener; a cached client
\* returns early and starts nothing.
RegisterClient ==
    /\ listenerPort' = IF CachedClient \/ listenerPort # 0 THEN listenerPort ELSE 1
    /\ UNCHANGED <<sdkUrlPort, finalUrlPort, urlStored, opened, badOpen>>

\* The SDK builds the URL from provider.redirectUrl before the listener starts.
SdkBuildsUrl ==
    /\ sdkUrlPort' = listenerPort
    /\ UNCHANGED <<listenerPort, finalUrlPort, urlStored, opened, badOpen>>

\* redirectToAuthorization: ensure the listener owns a real port, then set redirect_uri.
Redirect ==
    /\ listenerPort' = IF EnsureListener /\ listenerPort = 0 THEN 1 ELSE listenerPort
    /\ finalUrlPort' = IF FixRedirectUri THEN listenerPort' ELSE sdkUrlPort
    /\ urlStored' = TRUE
    /\ UNCHANGED <<sdkUrlPort, opened, badOpen>>

\* The user confirmed the toast and the stored URL is opened. A stale or zero
\* port at open time is a bad open.
OpenBrowser ==
    /\ urlStored
    /\ opened' = TRUE
    /\ badOpen' = (badOpen \/ finalUrlPort # listenerPort \/ finalUrlPort = 0)
    /\ UNCHANGED <<listenerPort, sdkUrlPort, finalUrlPort, urlStored>>

Next ==
    \/ RegisterClient
    \/ SdkBuildsUrl
    \/ Redirect
    \/ OpenBrowser

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ listenerPort \in {0, 1}
    /\ sdkUrlPort \in {0, 1}
    /\ finalUrlPort \in {0, 1}
    /\ urlStored \in BOOLEAN
    /\ opened \in BOOLEAN
    /\ badOpen \in BOOLEAN

\* The opened URL always carries the active listener port, and never port 0.
NoBadOpen == ~badOpen

====
