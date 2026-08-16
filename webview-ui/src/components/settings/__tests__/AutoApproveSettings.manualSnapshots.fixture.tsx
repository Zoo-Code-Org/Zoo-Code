import React from "react"

import screenshot1 from "./__screenshots__/screenshot-1-.png"
import screenshot2 from "./__screenshots__/screenshot-2-.png"
import screenshot3 from "./__screenshots__/screenshot-3-.png"

const SnapshotImage = ({ src, alt }: { src: string; alt: string }) => (
	<div className="inline-block bg-vscode-editor-background">
		<img src={src} alt={alt} className="block" />
	</div>
)

export const AutoApproveSettingsManualSnapshot1Fixture = () => (
	<SnapshotImage src={screenshot1} alt="Manual snapshot 1" />
)

export const AutoApproveSettingsManualSnapshot2Fixture = () => (
	<SnapshotImage src={screenshot2} alt="Manual snapshot 2" />
)

export const AutoApproveSettingsManualSnapshot3Fixture = () => (
	<SnapshotImage src={screenshot3} alt="Manual snapshot 3" />
)
