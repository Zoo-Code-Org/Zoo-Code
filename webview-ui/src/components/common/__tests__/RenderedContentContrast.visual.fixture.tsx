import React from "react"

import { TerminalOutput } from "../../chat/TerminalOutput"
import { StyledPre } from "../CodeBlock"
import DiffView from "../DiffView"

const diff = `@@ -1,3 +1,3 @@
 export function greet(name: string) {
-  return "Hello " + name
+  return \`Hello \${name}\`
 }`

export function RenderedContentContrastFixture() {
	return (
		<main className="w-[620px] space-y-4 rounded-lg border border-vscode-panel-border bg-vscode-editor-background p-4 text-vscode-editor-foreground">
			<section aria-labelledby="code-title" className="space-y-2">
				<h2 id="code-title" className="m-0 text-base font-semibold">
					Code response
				</h2>
				<div data-testid="code-block">
					<StyledPre wordwrap="true" windowshade="false">
						<pre>
							<code>const greeting = &quot;Hello, Zoo Code&quot;</code>
						</pre>
					</StyledPre>
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
