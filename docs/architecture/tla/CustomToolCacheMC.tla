------------------------ MODULE CustomToolCacheMC ------------------------
(* Source: CustomToolCache.Writers. Sink: TLC exploration.
The model checks two writers. No new failure is expected from this move. *)
EXTENDS CustomToolCache
MCWriters == {1, 2}
=============================================================================
