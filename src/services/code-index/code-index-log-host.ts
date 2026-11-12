import { window } from "vscode"
import { codeIndexLog, type CodeIndexLogSink } from "./code-index-log"

const createHostSink = (): CodeIndexLogSink => window.createOutputChannel("Zoo Code Indexing", { log: true })

export function initializeCodeIndexHostLogging(): void {
	codeIndexLog.setHostSinkFactory(createHostSink)
}
