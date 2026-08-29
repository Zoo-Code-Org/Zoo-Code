--------------------------- MODULE PrReviewLabels ---------------------------
EXTENDS Integers, Naturals, TLC

(***************************************************************************
The model separates environment changes (pushes, CI, and reviews) from the
metadata workflow's Reconcile action. dirty = TRUE means GitHub has newer
source-of-truth state than the labels currently show.
***************************************************************************)

CONSTANT MaxHead

Heads == 1..MaxHead
CIStates == {"pending", "failed", "passed"}
ReviewStates == {"none", "changes", "approved"}
StateLabels == {
    "none",
    "has-conflicts",
    "awaiting-coderabbit",
    "awaiting-author",
    "awaiting-ready",
    "awaiting-maintainer"
}

VARIABLES
    head,
    draft,
    conflict,
    ci,
    crHead,
    crState,
    maintHead,
    maintState,
    maintAfterCR,
    crLabelHead,
    stateLabel,
    gatePassed,
    dirty

vars == <<
    head,
    draft,
    conflict,
    ci,
    crHead,
    crState,
    maintHead,
    maintState,
    maintAfterCR,
    crLabelHead,
    stateLabel,
    gatePassed,
    dirty
>>

CurrentCRApproved == crHead = head /\ crState = "approved"
CurrentCRChanges == crHead = head /\ crState = "changes"
CurrentMaintChanges == maintHead = head /\ maintState = "changes"
ValidMaintApproval ==
    maintHead = head /\
    maintState = "approved" /\
    maintAfterCR

DesiredStateLabel ==
    CASE conflict -> "has-conflicts"
      [] ci # "passed" -> "none"
      [] CurrentCRChanges -> "awaiting-author"
      [] draft /\ CurrentCRApproved -> "awaiting-ready"
      [] draft -> "none"
      [] ~CurrentCRApproved -> "awaiting-coderabbit"
      [] CurrentMaintChanges -> "awaiting-author"
      [] ~ValidMaintApproval -> "awaiting-maintainer"
      [] OTHER -> "none"

DesiredCRLabelHead ==
    IF ~conflict /\
       ci = "passed" /\
       ~draft /\
       ~CurrentCRApproved /\
       ~CurrentCRChanges
    THEN head
    ELSE 0

DesiredGatePassed ==
    ~conflict /\
    ci = "passed" /\
    ~draft /\
    CurrentCRApproved /\
    ValidMaintApproval

Init ==
    /\ head = 1
    /\ draft = TRUE
    /\ conflict = FALSE
    /\ ci = "pending"
    /\ crHead = 0
    /\ crState = "none"
    /\ maintHead = 0
    /\ maintState = "none"
    /\ maintAfterCR = FALSE
    /\ crLabelHead = 0
    /\ stateLabel = "none"
    /\ gatePassed = FALSE
    /\ dirty = TRUE

Push ==
    /\ head < MaxHead
    /\ head' = head + 1
    /\ ci' = "pending"
    /\ gatePassed' = FALSE
    /\ dirty' = TRUE
    /\ UNCHANGED <<
        draft,
        conflict,
        crHead,
        crState,
        maintHead,
        maintState,
        maintAfterCR,
        crLabelHead,
        stateLabel
        >>

MarkReady ==
    /\ draft
    /\ draft' = FALSE
    /\ dirty' = TRUE
    /\ UNCHANGED <<
        head,
        conflict,
        ci,
        crHead,
        crState,
        maintHead,
        maintState,
        maintAfterCR,
        crLabelHead,
        stateLabel,
        gatePassed
        >>

ConvertToDraft ==
    /\ ~draft
    /\ draft' = TRUE
    /\ gatePassed' = FALSE
    /\ dirty' = TRUE
    /\ UNCHANGED <<
        head,
        conflict,
        ci,
        crHead,
        crState,
        maintHead,
        maintState,
        maintAfterCR,
        crLabelHead,
        stateLabel
        >>

SetConflict(value) ==
    /\ value \in BOOLEAN
    /\ conflict' = value
    /\ IF value THEN gatePassed' = FALSE ELSE UNCHANGED gatePassed
    /\ dirty' = TRUE
    /\ UNCHANGED <<
        head,
        draft,
        ci,
        crHead,
        crState,
        maintHead,
        maintState,
        maintAfterCR,
        crLabelHead,
        stateLabel
        >>

RestartCI ==
    /\ ci' = "pending"
    /\ gatePassed' = FALSE
    /\ dirty' = TRUE
    /\ UNCHANGED <<
        head,
        draft,
        conflict,
        crHead,
        crState,
        maintHead,
        maintState,
        maintAfterCR,
        crLabelHead,
        stateLabel
        >>

CompleteCI(result) ==
    /\ result \in {"failed", "passed"}
    /\ ci' = result
    /\ IF result = "failed" THEN gatePassed' = FALSE ELSE UNCHANGED gatePassed
    /\ dirty' = TRUE
    /\ UNCHANGED <<
        head,
        draft,
        conflict,
        crHead,
        crState,
        maintHead,
        maintState,
        maintAfterCR,
        crLabelHead,
        stateLabel
        >>

CodeRabbitReview(result) ==
    /\ result \in {"changes", "approved"}
    /\ crHead # head
    /\ \/ draft
       \/ (~draft /\ ci = "passed" /\ crLabelHead = head)
    /\ crHead' = head
    /\ crState' = result
    /\ dirty' = TRUE
    /\ UNCHANGED <<
        head,
        draft,
        conflict,
        ci,
        maintHead,
        maintState,
        maintAfterCR,
        crLabelHead,
        stateLabel,
        gatePassed
        >>

MaintainerReview(result) ==
    /\ result \in {"changes", "approved"}
    /\ maintHead' = head
    /\ maintState' = result
    /\ maintAfterCR' = CurrentCRApproved
    /\ dirty' = TRUE
    /\ UNCHANGED <<
        head,
        draft,
        conflict,
        ci,
        crHead,
        crState,
        crLabelHead,
        stateLabel,
        gatePassed
        >>

Reconcile ==
    /\ stateLabel' = DesiredStateLabel
    /\ crLabelHead' = DesiredCRLabelHead
    /\ gatePassed' = DesiredGatePassed
    /\ dirty' = FALSE
    /\ UNCHANGED <<
        head,
        draft,
        conflict,
        ci,
        crHead,
        crState,
        maintHead,
        maintState,
        maintAfterCR
        >>

Next ==
    \/ Push
    \/ MarkReady
    \/ ConvertToDraft
    \/ \E value \in BOOLEAN : SetConflict(value)
    \/ RestartCI
    \/ \E result \in {"failed", "passed"} : CompleteCI(result)
    \/ \E result \in {"changes", "approved"} : CodeRabbitReview(result)
    \/ \E result \in {"changes", "approved"} : MaintainerReview(result)
    \/ Reconcile

Spec == Init /\ [][Next]_vars /\ WF_vars(Reconcile)

EventualReconciliation == []<>(~dirty)

TypeOK ==
    /\ head \in Heads
    /\ draft \in BOOLEAN
    /\ conflict \in BOOLEAN
    /\ ci \in CIStates
    /\ crHead \in 0..MaxHead
    /\ crState \in ReviewStates
    /\ maintHead \in 0..MaxHead
    /\ maintState \in ReviewStates
    /\ maintAfterCR \in BOOLEAN
    /\ crLabelHead \in 0..MaxHead
    /\ stateLabel \in StateLabels
    /\ gatePassed \in BOOLEAN
    /\ dirty \in BOOLEAN

SettledGateConsistency ==
    ~dirty => gatePassed = DesiredGatePassed

SettledLabelConsistency ==
    ~dirty => stateLabel = DesiredStateLabel

SettledControlLabelConsistency ==
    ~dirty => crLabelHead = DesiredCRLabelHead

AwaitingCodeRabbitSafety ==
    (~dirty /\ stateLabel = "awaiting-coderabbit") =>
        (~draft /\ ci = "passed" /\ ~conflict /\ ~CurrentCRApproved /\ ~CurrentCRChanges)

AwaitingMaintainerSafety ==
    (~dirty /\ stateLabel = "awaiting-maintainer") =>
        (~draft /\ ci = "passed" /\ CurrentCRApproved /\ ~ValidMaintApproval)

AwaitingReadySafety ==
    (~dirty /\ stateLabel = "awaiting-ready") =>
        (draft /\ ci = "passed" /\ CurrentCRApproved)

AwaitingAuthorSafety ==
    (~dirty /\ stateLabel = "awaiting-author") =>
        (CurrentCRChanges \/ (CurrentCRApproved /\ CurrentMaintChanges))

ConflictLabelSafety ==
    (~dirty /\ stateLabel = "has-conflicts") => conflict

CodeRabbitActivationSafety ==
    (~dirty /\ crLabelHead # 0) =>
        (crLabelHead = head /\ ~draft /\ ci = "passed" /\ ~conflict)

ApprovedStateHasNoLabel ==
    gatePassed => stateLabel = "none"

=============================================================================
