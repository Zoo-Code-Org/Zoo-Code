import React from "react"
import { Settings } from "lucide-react"

import { IconButton } from "../../chat/IconButton"
import { Button } from "../button"
import { Checkbox } from "../checkbox"
import { Input } from "../input"
import { Progress } from "../progress"
import { RadioGroup, RadioGroupItem } from "../radio-group"
import { Slider } from "../slider"
import { Textarea } from "../textarea"

export function AccessibilityContrastGallery() {
	return (
		<main
			data-testid="contrast-gallery"
			className="w-[488px] space-y-4 rounded-lg border border-vscode-panel-border bg-vscode-editor-background p-4 text-vscode-editor-foreground">
			<div
				data-testid="unsupported-gradient"
				className="absolute -left-[9999px] h-px w-px"
				style={{ backgroundImage: "linear-gradient(red, blue)" }}
			/>
			<section aria-labelledby="chat-preview-title" className="space-y-3">
				<div className="flex items-start justify-between gap-3">
					<div>
						<h1 id="chat-preview-title" className="m-0 text-lg font-semibold">
							New task
						</h1>
						<p data-testid="chat-description" className="m-0 text-sm text-vscode-descriptionForeground">
							Describe what Zoo Code should build or investigate.
						</p>
					</div>
					<IconButton iconClass="codicon-settings-gear" title="Chat settings" tooltip={false} />
				</div>
				<Textarea aria-label="Task message" defaultValue="Audit contrast across the webview" rows={2} />
				<div data-testid="chat-actions" className="flex items-center justify-between gap-3">
					<label className="flex items-center gap-2 text-sm">
						<Checkbox aria-label="Include context" variant="description" defaultChecked />
						Include workspace context
					</label>
					<Button variant="primary">Start task</Button>
				</div>
			</section>

			<div className="h-px bg-vscode-panel-border" />

			<section aria-labelledby="settings-preview-title" className="space-y-3">
				<div className="flex items-center gap-2">
					<Settings aria-hidden="true" className="size-4 text-vscode-foreground" />
					<h2 id="settings-preview-title" className="m-0 text-base font-semibold">
						Provider settings
					</h2>
				</div>
				<label className="block space-y-1 text-sm">
					<span>API endpoint</span>
					<Input aria-label="API endpoint" defaultValue="https://api.example.com/v1" />
				</label>
				<div className="grid grid-cols-2 gap-3">
					<label className="flex items-center gap-2 text-sm">
						<Checkbox aria-label="Stream responses" />
						Stream responses
					</label>
					<RadioGroup aria-label="Response mode" defaultValue="balanced" className="grid-cols-2">
						<label className="flex items-center gap-2 text-sm">
							<RadioGroupItem value="balanced" aria-label="Balanced" />
							Balanced
						</label>
						<label className="flex items-center gap-2 text-sm">
							<RadioGroupItem value="fast" aria-label="Fast" />
							Fast
						</label>
					</RadioGroup>
				</div>
				<label className="block space-y-1 text-sm">
					<span>Context budget</span>
					<Slider aria-label="Context budget" defaultValue={[65]} max={100} step={1} />
				</label>
				<Progress aria-label="Indexing progress" value={68} />
				<p data-testid="error-message" className="m-0 text-sm text-vscode-errorForeground">
					API key is required before this provider can be used.
				</p>
				<div data-testid="settings-actions" className="flex flex-wrap justify-end gap-2">
					<Button variant="outline">Reset</Button>
					<Button variant="primary">Save settings</Button>
					<Button disabled>Unavailable</Button>
				</div>
			</section>
		</main>
	)
}
