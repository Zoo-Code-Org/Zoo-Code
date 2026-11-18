---- MODULE MockAuthentication ----
\* Source: runTest.main creates the key and passes it to suite.run.
\* Sink: authenticatedMockFetch calls fetch. LLMock checks inbound keys.
\* Failures: a mock call has conflicting keys; another origin gets the key.
\* Failure: a mock call can follow a redirect without an explicit check.
\* Invariants: MockAccepted, OtherOriginUnchanged and NoRedirectFollow.
\* Expect: Fixed holds. Each removed guard fails its named invariant.
\* Stance: the branch fix was read before these invariants were written.
\* Scope: URL and Headers parsing are oracles. Inputs are valid HTTP URLs.
\* Scope: LLMock recording and key setup have integration tests, not a model.
\* Property test: apps/vscode-e2e/src/mock-auth.property.spec.ts.
\* Result: Fixed holds in 64 states. All three sabotage configs fail.
\* Replay: each guard was removed from mock-auth.ts. The property test failed.
\* Replay: the restored wrapper passes the property tests. No new bug found.
\* Limit: redirect replay checks fetch options, not browser credential rules.
\* Cost: about 20 agent minutes. Each TLC run took less than one second.
\* Gate: all four configs, property test and two integration tests passed as expected.
\* Gate: package check-types and package ESLint passed. No suppressions added.
\* Review: 0 covered, 0 added, 2 gap. CI found a test compile failure.
\* Gap: Headers iteration types differ between the ESM and CommonJS configs.
\* This model cannot check TypeScript libraries. Both compile checks now pass.
\* Fix: headerEntries uses Headers.forEach. The credential model is unchanged.
\* Run TLC per AGENTS.md with each MockAuthentication*.cfg and this module.
\* Gap: PR 2474 found tests registered with the wrong runner.
\* Thread: https://github.com/Zoo-Code-Org/Zoo-Code/pull/2474#discussion_r4607809980
\* Test discovery is outside this credential model. Node tests now use .spec names.
\* Code QA runs the package command. Mocha discovers only .test.js files.
\* Gate: the package command fails with the redirect guard removed and passes after restore.
\* Run tests: pnpm --dir apps/vscode-e2e test:mock-auth.
\* A model check covers this model. It does not prove the code correct.

EXTENDS FiniteSets

CONSTANTS ScopeGuard, StripConflicts, BlockRedirects
VARIABLE input

CredentialHeaders == {"authorization", "x-api-key", "x-goog-api-key", "api-key", "xi-api-key"}
Inputs == [sameOrigin : BOOLEAN, credentials : SUBSET CredentialHeaders]
Wrapped == input.sameOrigin \/ ~ScopeGuard
OutputCredentials == IF Wrapped
    THEN (IF StripConflicts THEN {} ELSE input.credentials) \cup {"authorization"}
    ELSE input.credentials
MockKeySent == Wrapped
RedirectBlocked == Wrapped /\ BlockRedirects

Init == input \in Inputs
Next == UNCHANGED input
Spec == Init /\ [][Next]_input
TypeOK == input \in Inputs

\* Each mock call has one valid key, with no conflicting provider key.
MockAccepted == input.sameOrigin =>
    (MockKeySent /\ OutputCredentials = {"authorization"})
\* A call to another origin keeps its input credentials and gets no mock key.
OtherOriginUnchanged == ~input.sameOrigin =>
    (~MockKeySent /\ OutputCredentials = input.credentials)
\* A mock call must reject automatic redirects.
NoRedirectFollow == input.sameOrigin => RedirectBlocked
====
