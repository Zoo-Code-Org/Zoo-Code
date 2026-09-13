import {
	checkTranscriptTransportModel,
	TRANSPORT_MODEL_BOUNDS,
} from "../src/core/webview/__tests__/transcriptTransport.model"

const result = checkTranscriptTransportModel()
console.log(`Transcript transport model passed; bounds=${JSON.stringify(TRANSPORT_MODEL_BOUNDS)}`)
for (const scenario of result.results) {
	console.log(
		`${scenario.name}: ${scenario.states} states, ${scenario.transitions} transitions, maximum depth ${scenario.maximumDepth}`,
	)
}
console.log(`Actions (${result.actions.length}): ${result.actions.join(", ")}`)
console.log(`Landmarks (${result.landmarks.length}): ${result.landmarks.join(", ")}`)
for (const counterexample of result.counterexamples) {
	console.log(`Mutant ${counterexample.name}: ${counterexample.violation}\n  ${counterexample.trace.join(" -> ")}`)
}
