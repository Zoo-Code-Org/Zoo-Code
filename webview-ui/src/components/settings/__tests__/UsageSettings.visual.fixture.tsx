import { useEffect } from "react"

import { providerIdentifiers, VsCodeLmModelsMessageType, type HistoryItem, type ProviderQuota } from "@roo-code/types"

import { UsageSettings } from "../UsageSettings"
import { AppProviders } from "../../../../playwright/AppProviders"
import { vscode } from "@src/utils/vscode"

/** Matches the clock the visual test pins, so the history and the "updated" label are stable. */
export const USAGE_NOW = new Date("2026-06-01T12:00:00Z").getTime()
const DAY = 24 * 60 * 60 * 1000
const WORKSPACE = "/work/project"

const task = (n: number, daysAgo: number, overrides: Partial<HistoryItem>): HistoryItem => ({
	id: `usage-task-${n}`,
	number: n,
	ts: USAGE_NOW - daysAgo * DAY,
	task: `Task ${n}`,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	workspace: WORKSPACE,
	mode: "code",
	...overrides,
})

const used = (apiProvider: string, modelId: string, tokensIn: number, tokensOut: number, cost: number) => [
	{ apiProvider, modelId, requests: 4, tokensIn, tokensOut, cost },
]

/** A week of mixed priced (Anthropic) and unpriced (Copilot) work. */
const history: HistoryItem[] = [
	task(1, 0, {
		task: "Add a loading spinner to the Save button",
		tokensIn: 52_000,
		tokensOut: 4_100,
		totalCost: 1.84,
		cacheReads: 31_000,
		usageByModel: used(providerIdentifiers.anthropic, "claude-sonnet-5", 52_000, 4_100, 1.84),
	}),
	task(2, 1, {
		task: "Refactor the auth middleware",
		tokensIn: 91_000,
		tokensOut: 8_800,
		totalCost: 3.27,
		cacheReads: 60_000,
		mode: "architect",
		usageByModel: used(providerIdentifiers.anthropic, "claude-sonnet-5", 91_000, 8_800, 3.27),
	}),
	task(3, 2, {
		task: "Write unit tests for the billing service",
		tokensIn: 210_000,
		tokensOut: 15_000,
		totalCost: 0,
		usageByModel: used(providerIdentifiers.githubCopilot, "gpt-5", 210_000, 15_000, 0),
	}),
	task(4, 4, {
		task: "Investigate the flaky checkout test",
		tokensIn: 34_000,
		tokensOut: 2_900,
		totalCost: 0.61,
		mode: "debug",
		usageByModel: used(providerIdentifiers.anthropic, "claude-haiku-5", 34_000, 2_900, 0.61),
	}),
]

const healthyQuotas: ProviderQuota[] = [
	{
		providerId: providerIdentifiers.githubCopilot,
		ok: true,
		plan: "business",
		fetchedAt: USAGE_NOW,
		windows: [
			{
				id: "premium",
				valueLabel: "39,389 / 140,000 used",
				usedPercent: 28,
				resetAt: new Date("2026-07-01T00:00:00Z").getTime(),
			},
		],
	},
	{
		providerId: providerIdentifiers.deepseek,
		ok: true,
		fetchedAt: USAGE_NOW,
		windows: [{ id: "balance", valueLabel: "$4.25 left" }],
	},
]

const degradedQuotas: ProviderQuota[] = [
	{
		providerId: providerIdentifiers.githubCopilot,
		ok: false,
		reason: "signedOut",
		fetchedAt: USAGE_NOW,
	},
	{ providerId: providerIdentifiers.openrouter, ok: false, reason: "noKey", fetchedAt: USAGE_NOW },
	{ providerId: providerIdentifiers.deepseek, ok: false, reason: "error", message: "HTTP 500", fetchedAt: USAGE_NOW },
]

/** Plays the extension host: answers the component's quota request, echoing its request id. */
function FakeHost({ quotas }: { quotas: ProviderQuota[] }) {
	useEffect(() => {
		const original = vscode.postMessage.bind(vscode)
		vscode.postMessage = ((message: { type: string; requestId?: string }) => {
			if (message.type === VsCodeLmModelsMessageType.requestProviderQuotas) {
				queueMicrotask(() =>
					window.dispatchEvent(
						new MessageEvent("message", {
							data: {
								type: VsCodeLmModelsMessageType.providerQuotas,
								providerQuotas: quotas,
								requestId: message.requestId,
							},
						}),
					),
				)
				return
			}
			return original(message as never)
		}) as typeof vscode.postMessage
		return () => {
			vscode.postMessage = original as typeof vscode.postMessage
		}
	}, [quotas])
	return null
}

export type UsageStoryVariant = "populated" | "degraded" | "empty"

export function UsageSettingsStory({ variant = "populated" }: { variant?: UsageStoryVariant }) {
	const quotas = variant === "degraded" ? degradedQuotas : variant === "empty" ? [] : healthyQuotas
	return (
		<AppProviders initialState={{ taskHistory: variant === "empty" ? [] : history, cwd: WORKSPACE }}>
			<FakeHost quotas={quotas} />
			<div
				data-testid="usage-story"
				className="w-[520px] max-w-full rounded-lg border border-vscode-panel-border bg-vscode-editor-background p-4 text-vscode-editor-foreground">
				<UsageSettings />
			</div>
		</AppProviders>
	)
}
