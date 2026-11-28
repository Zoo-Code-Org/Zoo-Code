---- MODULE LmStudioLoad ----
\* Models forceFullModelDetailsLoad (the shared load operation) and getLMStudioModels (the cache commit)
\* in src/api/providers/fetchers/lmstudio.ts. Source: callers join or cancel. Sink: the cache commit or clear.
\* Failure 1: the last caller leaves and the operation keeps running, or one caller leaves and aborts the others.
\* Failure 2: two live operations exist for one server and model.
\* Failure 3: a refresh that started earlier settles later and overwrites a newer result.
\* Failure 4: a cancelled refresh clears the cache.
\* Failure 5: an operation with no caller left still commits a refresh.
\* Invariant NoLeak: a running operation has a caller, or it is aborted.
\* Invariant NoAbortWithWaiter: an aborted operation has no caller.
\* Invariant OneLive: at most one running operation is not aborted.
\* Invariant FreshWins: the cache equals the effect of the settled refresh with the highest ticket.
\* Property NoOrphanCommit: no operation that is aborted commits its flush refresh.
\* A refresh has a ticket from its start. Settled means ok or fail. A cancelled refresh changes nothing.
\* Modes: Current (code before the fix), Gen (a refresh applies only if no settled refresh has a higher ticket),
\* NoAbort, AbortEarly, NoShare, CancelClears (sabotage), GenOrphan (Gen, and the flush ignores the abort).
\* Expected before the run: Current fails FreshWins. GenOrphan fails NoOrphanCommit. Each sabotage mode fails its invariant.
\* Result: LmStudioLoad.cfg (Gen) holds. The Current, GenOrphan and four sabotage configs fail (see check.sh).
\* Found: Current fails FreshWins (a stale refresh overwrites a newer one). GenOrphan fails NoOrphanCommit (the flush ignores the abort).
\* Both are real. The replay is in lmstudio.interleavings.spec.ts. The fix is a refresh ticket and the signal on flushModels.
\* Code check (step 10): lmstudio.interleavings.spec.ts runs the invariants on the real code in every settle order.
\* The flush action assumes a new request. LmStudioPreparation models the pre-load flight boundary from PR 2170.
\* Not modeled: serverVersions, the HTTP calls, the server side of a load, and the gap between a settle and finally.
\* Cost: each run takes under 20 seconds. Agent time is not measured.

EXTENDS Naturals, FiniteSets

CONSTANTS Mode, NC, MaxOps, MaxRef

Callers == 1..NC
Ops == 1..MaxOps
Refs == 1..MaxRef
Running == {"disc", "load"}

\* cs: caller state. at: the operation a caller joined. st: operation stage. ab: the abort flag. cur: the map entry (0 = none).
\* nops: operations made. rs: refresh state. rt: ticket. ro: owner operation (0 = a settings refresh).
\* tk: ticket count. cv: ticket of the cached data. valid: the cache holds data.
VARIABLES cs, at, st, ab, cur, nops, rs, rt, ro, tk, cv, valid
vars == <<cs, at, st, ab, cur, nops, rs, rt, ro, tk, cv, valid>>

Waiters(o) == {c \in Callers : cs[c] = "wait" /\ at[c] = o}
Settled == {r \in Refs : rs[r] \in {"ok", "fail"}}
Newest(r) == \A x \in Settled \ {r} : rt[x] < rt[r]
Applies(r) == Mode # "Current" => Newest(r)
FlushStops == Mode \notin {"Current", "GenOrphan"}

Init ==
    /\ cs = [c \in Callers |-> "idle"] /\ at = [c \in Callers |-> 0]
    /\ st = [o \in Ops |-> "none"] /\ ab = [o \in Ops |-> FALSE]
    /\ cur = 0 /\ nops = 0
    /\ rs = [r \in Refs |-> "idle"] /\ rt = [r \in Refs |-> 0] /\ ro = [r \in Refs |-> 0]
    /\ tk = 0 /\ cv = 0 /\ valid = FALSE

\* A new caller joins the map entry, or makes an operation when there is none.
Join(c) ==
    /\ cs[c] = "idle"
    /\ \/ /\ (cur = 0 \/ Mode = "NoShare") /\ nops < MaxOps
          /\ nops' = nops + 1 /\ cur' = nops + 1
          /\ st' = [st EXCEPT ![nops + 1] = "disc"]
          /\ at' = [at EXCEPT ![c] = nops + 1]
       \/ /\ cur # 0 /\ Mode # "NoShare"
          /\ UNCHANGED <<nops, cur, st>> /\ at' = [at EXCEPT ![c] = cur]
    /\ cs' = [cs EXCEPT ![c] = "wait"]
    /\ UNCHANGED <<ab, rs, rt, ro, tk, cv, valid>>

\* A caller cancels. The last caller to leave aborts the operation, in any stage before it ends.
Cancel(c) ==
    /\ cs[c] = "wait"
    /\ LET o == at[c] IN
       /\ cs' = [cs EXCEPT ![c] = "cancel"]
       /\ LET last == Waiters(o) = {c} IN
          /\ ab' = [ab EXCEPT ![o] = IF st[o] \in Running \cup {"flush"} /\ Mode # "NoAbort" /\ (last \/ Mode = "AbortEarly")
                                     THEN TRUE ELSE ab[o]]
          /\ cur' = IF cur = o /\ last /\ Mode # "NoAbort" THEN 0 ELSE cur
    /\ UNCHANGED <<at, st, nops, rs, rt, ro, tk, cv, valid>>

\* An operation ends. Each caller that waits gets the result. The map entry goes.
Finish(o, res) ==
    /\ st' = [st EXCEPT ![o] = res]
    /\ cs' = [c \in Callers |-> IF cs[c] = "wait" /\ at[c] = o THEN "done" ELSE cs[c]]
    /\ cur' = IF cur = o THEN 0 ELSE cur

Step(o) ==
    /\ st[o] \in Running /\ ~ab[o]
    /\ \/ /\ st[o] = "disc" /\ Finish(o, "ok") /\ UNCHANGED <<at, ab, nops, rs, rt, ro, tk, cv, valid>>
       \/ /\ st[o] = "disc" /\ st' = [st EXCEPT ![o] = "load"] /\ UNCHANGED <<cs, at, ab, cur, nops, rs, rt, ro, tk, cv, valid>>
       \/ /\ Finish(o, "fail") /\ UNCHANGED <<at, ab, nops, rs, rt, ro, tk, cv, valid>>
       \/ \E r \in Refs : /\ rs[r] = "idle"
                          /\ rs' = [rs EXCEPT ![r] = "run"] /\ ro' = [ro EXCEPT ![r] = o]
                          /\ tk' = tk + 1 /\ rt' = [rt EXCEPT ![r] = tk + 1]
                          /\ st' = [st EXCEPT ![o] = "flush"]
                          /\ UNCHANGED <<cs, at, ab, cur, nops, cv, valid>>

\* The client request fails because the operation is aborted.
Unwind(o) ==
    /\ st[o] \in Running /\ ab[o]
    /\ st' = [st EXCEPT ![o] = "abort"]
    /\ UNCHANGED <<cs, at, ab, cur, nops, rs, rt, ro, tk, cv, valid>>

\* A settings refresh starts.
StartSettings ==
    /\ \E r \in Refs : /\ rs[r] = "idle"
                       /\ rs' = [rs EXCEPT ![r] = "run"] /\ ro' = [ro EXCEPT ![r] = 0]
                       /\ tk' = tk + 1 /\ rt' = [rt EXCEPT ![r] = tk + 1]
    /\ UNCHANGED <<cs, at, st, ab, cur, nops, cv, valid>>

\* A refresh settles. Commit sets the cache. Fail clears it. A flush refresh may also end the operation.
Settle(r, res) ==
    /\ rs[r] = "run"
    /\ rs' = [rs EXCEPT ![r] = res]
    /\ IF Applies(r) \/ res = "cancel"
       THEN /\ valid' = IF res = "ok" THEN TRUE ELSE IF res = "fail" THEN FALSE
                        ELSE IF Mode = "CancelClears" THEN FALSE ELSE valid
            /\ cv' = IF res = "ok" THEN rt[r] ELSE cv
       ELSE UNCHANGED <<valid, cv>>
    /\ UNCHANGED <<rt, ro, tk>>

\* A flush refresh settles. If the abort reached the flush, the refresh stops and does not commit.
Flush(r, res) ==
    /\ ro[r] # 0
    /\ Settle(r, IF FlushStops /\ ab[ro[r]] /\ res = "ok" THEN "cancel" ELSE res)
    /\ st[ro[r]] = "flush"
    /\ Finish(ro[r], IF res = "ok" THEN "ok" ELSE "fail")
    /\ UNCHANGED <<at, ab, nops>>

\* A settings refresh settles, or its caller cancels it.
Settings(r, res) ==
    /\ ro[r] = 0
    /\ Settle(r, res)
    /\ UNCHANGED <<cs, at, st, ab, cur, nops>>

Next ==
    \/ \E c \in Callers : Join(c) \/ Cancel(c)
    \/ \E o \in Ops : Step(o) \/ Unwind(o)
    \/ StartSettings
    \/ \E r \in Refs : \/ Flush(r, "ok") \/ Flush(r, "fail")
                       \/ Settings(r, "ok") \/ Settings(r, "fail") \/ Settings(r, "cancel")

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ cs \in [Callers -> {"idle", "wait", "done", "cancel"}]
    /\ st \in [Ops -> {"none", "disc", "load", "flush", "ok", "fail", "abort"}]
    /\ rs \in [Refs -> {"idle", "run", "ok", "fail", "cancel"}]

NoLeak == \A o \in Ops : (st[o] \in Running /\ ~ab[o]) => Waiters(o) # {}
NoAbortWithWaiter == \A o \in Ops : ab[o] => Waiters(o) = {}
OneLive == Cardinality({o \in Ops : st[o] \in Running /\ ~ab[o]}) <= 1

\* The newest settled refresh decides the cache. Tickets are unique.
FreshWins ==
    \A r \in Settled : Newest(r) =>
        IF rs[r] = "ok" THEN valid /\ cv = rt[r] ELSE ~valid

NoOrphanCommit ==
    [][\A r \in Refs : (rs[r] = "run" /\ rs'[r] = "ok" /\ ro[r] # 0) => ~ab[ro[r]]]_vars
====
