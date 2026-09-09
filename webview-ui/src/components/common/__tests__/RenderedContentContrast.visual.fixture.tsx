import React from "react"

import { TerminalOutput } from "../../chat/TerminalOutput"
import CodeBlock from "../CodeBlock"
import DiffView from "../DiffView"

const diff = `@@ -1,3 +1,3 @@
 export function greet(name: string) {
-  return "Hello " + name
+  return \`Hello \${name}\`
 }`

const source = Array.from(
	{ length: 36 },
	(_, index) => `const greeting${index + 1} = \`Hello, Zoo Code ${index + 1}\``,
).join("\n")

export function RenderedContentContrastFixture() {
	return (
		<main
			data-virtuoso-scroller="true"
			className="w-[480px] max-w-full space-y-4 overflow-y-auto rounded-lg border border-vscode-panel-border bg-vscode-editor-background p-4 text-vscode-editor-foreground">
			<section aria-labelledby="code-title" className="space-y-2">
				<h2 id="code-title" className="m-0 text-base font-semibold">
					Code response
				</h2>
				<div data-testid="code-block">
					<CodeBlock source={source} language="typescript" collapsedHeight={96} />
				</div>
			</section>

			<section aria-labelledby="diff-title" className="space-y-2">
				<h2 id="diff-title" className="m-0 text-base font-semibold">
					Proposed edit
				</h2>
				<div data-testid="diff-view">
					<DiffView source={diff} />
				</div>
			</section>

			<section aria-labelledby="terminal-title" className="space-y-2">
				<h2 id="terminal-title" className="m-0 text-base font-semibold">
					Terminal output
				</h2>
				<div data-testid="terminal-output">
					<TerminalOutput
						content={"Tests passed\n\u001b[32m24 passing\u001b[0m  \u001b[33m1 skipped\u001b[0m"}
					/>
				</div>
			</section>
		</main>
	)
}
