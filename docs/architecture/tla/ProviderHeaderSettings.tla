---- MODULE ProviderHeaderSettings ----
\* Source: the OpenAICompatible.tsx header rows (customHeaders handlers) and the row sync.
\* Cache: SettingsView.cachedState.apiConfiguration.openAiHeaders through setApiConfigurationField.
\* Sink: the SettingsView handleSubmit upsertApiConfiguration payload.
\* Failure 1: a profile load or switch is replaced by stale editor rows (issue #2770).
\* Failure 2: Save omits a header edit made less than 300 ms earlier (issue #2770).
\* Invariant 1: LoadedHeadersSurvive. In phase "loaded" the cache and the editor hold the loaded headers.
\* Invariant 2: SaveKeepsLatestHeaders. The saved headers equal the latest user choice.
\* Expect: Immediate holds. StaleEditor fails invariant 1. EarlySave fails invariant 2.
\* The two variants factor the unfixed behavior: missing row sync plus a delayed cache write.
\* The delayed write came from PR 3415 (commit c1aa0ec5) as a keystroke debounce. Other
\* controls already write the cache per keystroke, so the immediate write is not new churn.
\* Result: Immediate holds in 16 states. StaleEditor fails LoadedHeadersSurvive in 4 states.
\* EarlySave fails SaveKeepsLatestHeaders in 16 states. The fix mirrors the Immediate variant.
\* Replay: the StaleEditor trace is the issue profile-load replay (mount rows, load, timer).
\* The EarlySave trace is the edit-then-early-Save replay. Both reached the real Save payload.
\* Cost: each TLC run takes less than 1 second. Agent work takes about 10 minutes.
\* Finding: no failure beyond the two known ones. The Immediate model is the reference the
\* investigation proposed; this commit brings the committed model in line with the fix.
\* Property test: webview-ui/src/components/settings/__tests__/SettingsView.headers.property.spec.tsx.
\* Storage and the restart path are oracles. The extension-host E2E covers them.
\* Scope: one header value. Two values show every overwrite. The empty-key rule stays a util test.

EXTENDS TLC
CONSTANT Variant
VARIABLES editor, cache, saved, loaded, latest, phase

Values == {"a", "b"}
None == "none"

Init ==
    /\ \E mount \in Values:
        editor = mount
        /\ cache = mount
        /\ saved = None
        /\ loaded = None
        /\ latest = mount
        /\ phase = "mounted"

\* A profile load or switch brings its headers into the cache and the editor rows.
\* StaleEditor skips the row sync, as the unfixed editor did.
ProfileLoad(p) ==
    /\ phase # "saved"
    /\ loaded' = p
    /\ latest' = p
    /\ cache' = p
    /\ editor' = IF Variant = "StaleEditor" THEN editor ELSE p
    /\ phase' = "loaded"
    /\ UNCHANGED saved

\* A user edit. Immediate and StaleEditor write the cache at once. EarlySave waits
\* for Timer, as the unfixed 300 ms write did.
Edit(v) ==
    /\ phase \in {"mounted", "loaded", "edited"}
    /\ editor' = v
    /\ latest' = v
    /\ cache' = IF Variant = "EarlySave" THEN cache ELSE v
    /\ phase' = "edited"
    /\ UNCHANGED <<saved, loaded>>

\* The removed 300 ms write: it pushed the editor rows into the cache late.
Timer ==
    /\ Variant # "Immediate"
    /\ cache' = editor
    /\ phase' = phase
    /\ UNCHANGED <<editor, saved, loaded, latest>>

\* Save reads the cache at once and posts it.
Save ==
    /\ phase \in {"loaded", "edited"}
    /\ saved' = cache
    /\ phase' = "saved"
    /\ UNCHANGED <<editor, cache, loaded, latest>>

Next ==
    \/ \E p \in Values: ProfileLoad(p)
    \/ \E v \in Values: Edit(v)
    \/ Timer
    \/ Save

Spec == Init /\ [][Next]_<<editor, cache, saved, loaded, latest, phase>>

LoadedHeadersSurvive ==
    (phase = "loaded") => (cache = loaded /\ editor = loaded)

SaveKeepsLatestHeaders ==
    (phase = "saved") => (saved = latest)

====
