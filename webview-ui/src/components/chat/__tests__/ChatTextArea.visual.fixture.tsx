/* v8 ignore file -- Playwright component fixture is covered by the visual test. */
import React from "react"

import { TranslationContext } from "@src/i18n/TranslationContext"
import { TooltipProvider } from "@src/components/ui/tooltip"

// Translations for the labels shown in the snapshot.
const translations: Record<string, string> = {
	"chat:selectMode": "Select mode for interaction",
	"chat:selectApiConfig": "Select API configuration",
	"settings:providers.reasoningEffort.label": "Model Reasoning Effort",
	"settings:providers.reasoningEffort.none": "None",
	"settings:providers.reasoningEffort.low": "Low",
	"settings:providers.reasoningEffort.medium": "Medium",
	"settings:providers.reasoningEffort.high": "High",
	"settings:providers.reasoningEffort.max": "Max",
}

// Shared trigger styling for the four chat-toolbar controls. These reproduce
// each real control's PopoverTrigger classes so the snapshot faithfully
// captures the compact toolbar layout the user sees at a glance. The real
// components (ModeSelector, ApiConfigSelector, ReasoningEffortSelector,
// AutoApproveDropdown) all share this base; only minor variations differ
// (min-w-0, gap, first-use highlight). We render lightweight stand-ins rather
// than the real components because the real components' import graphs evaluate
// Zod schemas at module load (`@roo-code/types/model`), which the Playwright
// CT Vite build externalizes (`z is not defined` at runtime). Stand-ins keep
// the visual test free of that dependency while capturing the exact layout.
const TRIGGER_BASE =
	"inline-flex items-center relative whitespace-nowrap px-1.5 py-1 text-xs " +
	"bg-transparent border border-[rgba(255,255,255,0.08)] rounded-md text-vscode-foreground " +
	"transition-all duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder focus-visible:ring-inset " +
	"opacity-90 hover:opacity-100 hover:bg-[rgba(255,255,255,0.03)] hover:border-[rgba(255,255,255,0.15)] cursor-pointer"

// The same triggerClassName ChatTextArea passes to each control, tuned for the
// compact toolbar (min-width + ellipsis + flex-shrink so the row overflows
// gracefully at narrow widths). ModeSelector uses flex-shrink-0 in production,
// but the narrow-width snapshot needs to show truncation across the whole row
// (mode truncated, then bits of api-config and reasoning peeking through) — so
// the fixture gives the mode trigger the same shrinkable treatment as its
// siblings to exercise the overflow layout meaningfully.
const MODE_TRIGGER = `${TRIGGER_BASE} min-w-0 text-ellipsis overflow-hidden flex-shrink`
const SHRINK_TRIGGER = `${TRIGGER_BASE} min-w-0 text-ellipsis overflow-hidden flex-shrink`
const AUTO_APPROVE_TRIGGER =
	"inline-flex items-center gap-1.5 relative whitespace-nowrap px-1.5 py-1 text-xs " +
	"bg-transparent border border-[rgba(255,255,255,0.08)] rounded-md text-vscode-foreground " +
	"transition-all duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder focus-visible:ring-inset " +
	"max-[300px]:shrink-0 " +
	"opacity-90 hover:opacity-100 hover:bg-[rgba(255,255,255,0.03)] hover:border-[rgba(255,255,255,0.15)] cursor-pointer " +
	"min-w-[28px] text-ellipsis overflow-hidden flex-shrink"

// Right-cluster icon-button styling. IndexingStatusBadge is a ghost Button with
// a Database lucide icon + a status dot; ZooCodeAuthBadge (signed-out) is a
// size-5 rounded-full button with a person SVG. Reproduced as stand-ins for the
// same Zod-import reason as the left-cluster triggers.
const ICON_BUTTON_BASE =
	"relative inline-flex items-center justify-center bg-transparent border-none p-1.5 " +
	"rounded-md min-w-[28px] min-h-[28px] text-vscode-foreground opacity-85 " +
	"transition-all duration-150 hover:opacity-100 hover:bg-[rgba(255,255,255,0.03)] " +
	"focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder cursor-pointer"

// Person icon (signed-out Zoo Code auth state), matching ZooCodeAuthBadge's SVG.
const PersonIcon = () => (
	<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor">
		<circle cx="12" cy="7" r="4" />
		<path d="M5.5 21a8.38 8.38 0 0 1 13 0" />
	</svg>
)

interface ChatToolbarFixtureProps {
	/** Container width in px. The narrow state exercises the row's
	 * overflow/flex-shrink behavior (the compact toolbar's primary concern). */
	width: number
}

/**
 * Mounts the full compact chat-input toolbar row the user sees at a glance:
 * the left cluster of dropdowns — [Select mode] [Select API configuration]
 * [Model reasoning effort] [Auto-approval] — and the right cluster of icon
 * buttons — [Codebase indexing] [Sign in to Zoo Code]. The visual test
 * snapshots how the new reasoning-effort selector sits alongside the existing
 * controls, at both a default and a narrow width. The container mirrors the
 * real ChatTextArea structure: an outer `flex items-center gap-2`, an inner
 * `flex-1 min-w-0 overflow-clip` for the dropdowns, and a `flex-shrink-0`
 * right cluster with `gap-0.5`.
 */
export const ChatToolbarFixture = ({ width }: ChatToolbarFixtureProps) => (
	<TranslationContext.Provider
		value={{
			t: (key: string) => translations[key] ?? key,
			i18n: null as unknown as typeof import("../../../i18n/setup").default,
		}}>
		<TooltipProvider>
			<div
				className="flex items-center gap-2 bg-vscode-editor-background p-2 text-vscode-foreground"
				style={{ width: `${width}px` }}>
				<div className="flex items-center gap-2 min-w-0 overflow-clip flex-1">
					<button type="button" data-testid="mode-selector-trigger" className={MODE_TRIGGER}>
						<span className="truncate">🛡️ Security Reviewer</span>
					</button>
					<button type="button" data-testid="dropdown-trigger" className={SHRINK_TRIGGER}>
						<span className="truncate">Ollama-glm</span>
					</button>
					<button type="button" data-testid="reasoning-effort-trigger" className={SHRINK_TRIGGER}>
						<span className="truncate">Max</span>
					</button>
					<button type="button" data-testid="auto-approve-dropdown-trigger" className={AUTO_APPROVE_TRIGGER}>
						<span className="truncate">6 auto-approved</span>
					</button>
				</div>
				<div className="flex flex-shrink-0 items-center gap-0.5 h-5 leading-none pr-2">
					<button type="button" aria-label="Codebase indexing" className={ICON_BUTTON_BASE}>
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
							<ellipse cx="12" cy="5" rx="9" ry="3" />
							<path d="M3 5v14a9 3 0 0 0 18 0V5" />
							<path d="M3 12a9 3 0 0 0 18 0" />
						</svg>
						<span className="absolute top-0 right-0 w-1.5 h-1.5 rounded-full bg-vscode-charts-green" />
					</button>
					<button
						type="button"
						aria-label="Sign in to Zoo Code"
						title="Sign in to Zoo Code"
						className="flex size-5 items-center justify-center overflow-hidden rounded-full p-0 transition-all duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder border border-vscode-descriptionForeground/50 bg-transparent text-vscode-descriptionForeground hover:border-vscode-descriptionForeground">
						<PersonIcon />
					</button>
				</div>
			</div>
		</TooltipProvider>
	</TranslationContext.Provider>
)
