module CompletionPersistence

abstract sig CompletionPolicy {}
one sig CurrentPolicy, DurableFirstPolicy extends CompletionPolicy {}

one sig Config {
	policy: one CompletionPolicy
}

one sig Marker {}

one sig Lifecycle {
	var historyWriteStarted: lone Marker,
	var historyDurable: lone Marker,
	var completionAccepted: lone Marker,
	var completionEmitted: lone Marker,
	var hostStopped: lone Marker
}

pred init {
	no Lifecycle.historyWriteStarted
	no Lifecycle.historyDurable
	no Lifecycle.completionAccepted
	no Lifecycle.completionEmitted
	no Lifecycle.hostStopped
}

pred startHistoryWrite {
	no Lifecycle.historyWriteStarted
	no Lifecycle.hostStopped
	Lifecycle.historyWriteStarted' = Marker
	Lifecycle.historyDurable' = Lifecycle.historyDurable
	Lifecycle.completionAccepted' = Lifecycle.completionAccepted
	Lifecycle.completionEmitted' = Lifecycle.completionEmitted
	Lifecycle.hostStopped' = Lifecycle.hostStopped
}

pred finishHistoryWrite {
	some Lifecycle.historyWriteStarted
	no Lifecycle.historyDurable
	no Lifecycle.hostStopped
	Lifecycle.historyWriteStarted' = Lifecycle.historyWriteStarted
	Lifecycle.historyDurable' = Marker
	Lifecycle.completionAccepted' = Lifecycle.completionAccepted
	Lifecycle.completionEmitted' = Lifecycle.completionEmitted
	Lifecycle.hostStopped' = Lifecycle.hostStopped
}

pred acceptCompletion {
	no Lifecycle.completionAccepted
	no Lifecycle.hostStopped
	Lifecycle.historyWriteStarted' = Lifecycle.historyWriteStarted
	Lifecycle.historyDurable' = Lifecycle.historyDurable
	Lifecycle.completionAccepted' = Marker
	Lifecycle.completionEmitted' = Lifecycle.completionEmitted
	Lifecycle.hostStopped' = Lifecycle.hostStopped
}

pred emitCompletion {
	some Lifecycle.historyWriteStarted
	some Lifecycle.completionAccepted
	no Lifecycle.completionEmitted
	no Lifecycle.hostStopped
	Config.policy = DurableFirstPolicy implies some Lifecycle.historyDurable
	Lifecycle.historyWriteStarted' = Lifecycle.historyWriteStarted
	Lifecycle.historyDurable' = Lifecycle.historyDurable
	Lifecycle.completionAccepted' = Lifecycle.completionAccepted
	Lifecycle.completionEmitted' = Marker
	Lifecycle.hostStopped' = Lifecycle.hostStopped
}

pred stopHost {
	some Lifecycle.completionEmitted
	no Lifecycle.hostStopped
	Lifecycle.historyWriteStarted' = Lifecycle.historyWriteStarted
	Lifecycle.historyDurable' = Lifecycle.historyDurable
	Lifecycle.completionAccepted' = Lifecycle.completionAccepted
	Lifecycle.completionEmitted' = Lifecycle.completionEmitted
	Lifecycle.hostStopped' = Marker
}

pred stutter {
	Lifecycle.historyWriteStarted' = Lifecycle.historyWriteStarted
	Lifecycle.historyDurable' = Lifecycle.historyDurable
	Lifecycle.completionAccepted' = Lifecycle.completionAccepted
	Lifecycle.completionEmitted' = Lifecycle.completionEmitted
	Lifecycle.hostStopped' = Lifecycle.hostStopped
}

fact traces {
	init
	always (
		startHistoryWrite or
		finishHistoryWrite or
		acceptCompletion or
		emitCompletion or
		stopHost or
		stutter
	)
}

pred DurableFirstHappyPath {
	Config.policy = DurableFirstPolicy
	eventually (
		some Lifecycle.hostStopped and
		some Lifecycle.completionEmitted and
		some Lifecycle.historyDurable
	)
}

assert CurrentCompletionIsDurable {
	Config.policy = CurrentPolicy implies
		always (some Lifecycle.completionEmitted implies some Lifecycle.historyDurable)
}

assert CurrentShutdownPreservesHistory {
	Config.policy = CurrentPolicy implies
		always (
			some Lifecycle.hostStopped and some Lifecycle.completionEmitted implies
				some Lifecycle.historyDurable
		)
}

assert DurableFirstCompletionIsDurable {
	Config.policy = DurableFirstPolicy implies
		always (some Lifecycle.completionEmitted implies some Lifecycle.historyDurable)
}

assert DurableFirstShutdownPreservesHistory {
	Config.policy = DurableFirstPolicy implies
		always (
			some Lifecycle.hostStopped and some Lifecycle.completionEmitted implies
				some Lifecycle.historyDurable
		)
}

check CurrentCompletionIsDurable for 6 but 6 steps
check CurrentShutdownPreservesHistory for 6 but 6 steps
run DurableFirstHappyPath for 6 but 6 steps
check DurableFirstCompletionIsDurable for 6 but 8 steps
check DurableFirstShutdownPreservesHistory for 6 but 8 steps
