---- MODULE LmStudioDiscovery ----
\* Models discoverModels in src/api/providers/fetchers/lmstudio.ts. Source: the answer of each endpoint, the caller cancel and the deadline.
\* Sink: the discovery result and the error message. Endpoints: 1 = /api/v1/models, 2 = /api/v0/models, 3 = /v1/models.
\* Failure 1: a fatal answer, a cancel or a timeout starts the next endpoint and hides the real error.
\* Failure 2: a request starts after the signal ends.
\* Failure 3: the final error hides the first server message.
\* Invariant OnlyUnsupportedFallsBack: endpoint k+1 starts only after endpoint k answered unsup, or errbody for k < 3.
\* Invariant NoRequestAfterStop: no request starts while the signal is cancel or timeout.
\* Invariant FirstMessage: a server failure names the first server message, or the last endpoint if there was none.
\* Invariant OkIsList: the result is a success only when the last endpoint answered list.
\* Answers are an oracle: list, errbody (HTTP 200 with an error string), unsup (HTTP 404 or 405), fatal (any other failure).
\* The cancel and the deadline can happen at any time. They end the run with that reason, as the code checks them first.
\* Modes: Code (the code), FallAll (every failure falls back), NoSignalCheck (the next request ignores the signal),
\* LastMessage (the final error is the last server message).
\* Expected before the run: Code holds. Each other mode fails the invariant of its failure.
\* Result: LmStudioDiscovery.cfg (Code) holds. The three other configs fail (see check.sh). Null result: no bug found.
\* Code check (step 10): lmstudio.discovery.spec.ts runs every answer order on the real code against a reference of this spec.
\* Not modeled: the body shape, the parse of each entry, the version cache and the cache commit.
\* Cost: each run takes under 5 seconds. Agent time is not measured.

EXTENDS Naturals, Sequences

CONSTANTS Mode

Answers == {"list", "errbody", "unsup", "fatal"}

\* ep: the next endpoint. out: run, ok or fail. why: the failure reason. sg: the signal.
\* fm: the endpoint of the first server message (0 = none). asked: the endpoints requested. ans: their answers.
\* late: a request started while the signal was not live.
VARIABLES ep, out, why, sg, fm, asked, ans, late
vars == <<ep, out, why, sg, fm, asked, ans, late>>

Init ==
    /\ ep = 1 /\ out = "run" /\ why = "none" /\ sg = "live"
    /\ fm = 0 /\ asked = <<>> /\ ans = <<>> /\ late = FALSE

Stop(r) == /\ sg = "live" /\ out = "run" /\ sg' = r /\ UNCHANGED <<ep, out, why, fm, asked, ans, late>>

\* Fall is true when the answer starts the next request.
Falls(a) == ep < 3 /\ (a \in {"unsup", "errbody"} \/ Mode = "FallAll")
Checks == Mode # "NoSignalCheck"

\* The request for the next endpoint gets an answer. A stopped signal wins over any failure.
Ask(a) ==
    /\ out = "run"
    /\ asked' = Append(asked, ep) /\ ans' = Append(ans, a)
    /\ UNCHANGED sg
    /\ \/ /\ a = "list" /\ out' = "ok" /\ UNCHANGED <<ep, why, fm, late>>
       \/ /\ a # "list" /\ sg # "live" /\ Checks
          /\ out' = "fail" /\ why' = sg /\ UNCHANGED <<ep, fm, late>>
       \/ /\ a # "list" /\ (sg = "live" \/ ~Checks) /\ Falls(a)
          /\ ep' = ep + 1 /\ out' = "run" /\ late' = (late \/ sg # "live")
          /\ fm' = (IF a = "errbody" /\ fm = 0 THEN ep ELSE fm) /\ UNCHANGED why
       \/ /\ a # "list" /\ (sg = "live" \/ ~Checks) /\ ~Falls(a)
          /\ out' = "fail" /\ UNCHANGED <<ep, late>>
          /\ IF a = "fatal" \/ ep < 3
             THEN why' = "fatal" /\ UNCHANGED fm
             ELSE why' = "server" /\ fm' = (IF Mode = "LastMessage" \/ fm = 0 THEN ep ELSE fm)

Next == \/ Stop("cancel") \/ Stop("timeout") \/ \E a \in Answers : Ask(a)
        \/ (out # "run" /\ UNCHANGED vars)

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ out \in {"run", "ok", "fail"} /\ sg \in {"live", "cancel", "timeout"}
    /\ ep \in 1..3 /\ fm \in 0..3

OnlyUnsupportedFallsBack ==
    \A k \in 1..(Len(ans) - 1) : ans[k] = "unsup" \/ (ans[k] = "errbody" /\ asked[k] < 3)

NoRequestAfterStop == ~late

\* The first server message belongs to the first errbody answer. Without one, the last endpoint gives it.
FirstMessage ==
    (out = "fail" /\ why = "server") =>
        fm = IF \E k \in 1..Len(ans) : ans[k] = "errbody"
             THEN asked[CHOOSE k \in 1..Len(ans) : ans[k] = "errbody" /\ \A j \in 1..(k - 1) : ans[j] # "errbody"]
             ELSE 3

OkIsList == out = "ok" => ans[Len(ans)] = "list"
====
