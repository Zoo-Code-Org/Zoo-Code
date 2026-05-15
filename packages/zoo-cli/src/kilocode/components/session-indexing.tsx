// kilocode_change - new file
import { createMemo, Show } from "solid-js"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { indexingEnabled } from "../indexing-feature"
import { formatIndexingLabel } from "../indexing-label"
import type { KiloIndexing } from "../indexing"

function tone(state: KiloIndexing.StatusState, theme: ReturnType<typeof useTheme>["theme"]) {
	if (state === "Complete") return theme.success
	if (state === "Error") return theme.error
	if (state === "In Progress") return theme.warning
	if (state === "Standby") return theme.textMuted
	return theme.textMuted
}

export function SessionIndexing() {
	const { theme } = useTheme()
	const sync = useSync()
	const enabled = createMemo(() => indexingEnabled(sync.data.config))
	const indexing = createMemo(() => sync.data.indexing)
	const label = createMemo(() => formatIndexingLabel(indexing()))

	return (
		<Show when={enabled()}>
			<box flexShrink={0} flexDirection="row" paddingLeft={2} paddingRight={2}>
				<text fg={tone(indexing().state, theme)}>{label().slice(0, 48)}</text>
			</box>
		</Show>
	)
}
