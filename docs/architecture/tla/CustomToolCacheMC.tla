------------------------ MODULE CustomToolCacheMC ------------------------
(* TLC bounds for CustomToolCache: Two writers and four path forms.
The spec header records expectations, cost, findings, and validation. *)
EXTENDS CustomToolCache
MCWriters == {1, 2}
(* These path results come from Node path.resolve, dirname, and basename. *)
MCCleanupCases == {
    [form |-> "plain", root |-> "cache", normalizedTarget |-> "cache", mixedTarget |-> "cache"],
    [form |-> "dot", root |-> "cache", normalizedTarget |-> "cache", mixedTarget |-> "parent"],
    [form |-> "dots", root |-> "cache", normalizedTarget |-> "cache", mixedTarget |-> "parent"],
    [form |-> "dotdot", root |-> "cache", normalizedTarget |-> "cache", mixedTarget |-> "grandparent"]
}
=============================================================================
