import type { HookMessage } from "@roo-code/types"
import { CheckCircle2, CircleSlash2, Clock3, Loader2, Settings2, XCircle } from "lucide-react"
import { useTranslation } from "react-i18next"

const failureStatuses = new Set<HookMessage["status"]>(["failed", "timedOut", "cancelled", "interrupted"])

export function HookRow({ hook }: { hook: HookMessage }) {
	const { t } = useTranslation()
	const failed = failureStatuses.has(hook.status)
	const details = [hook.outputSummary, hook.errorSummary].filter(Boolean).join("\n\n")
	const Icon =
		hook.status === "running"
			? Loader2
			: hook.status === "succeeded"
				? CheckCircle2
				: hook.status === "blocked"
					? CircleSlash2
					: hook.status === "timedOut"
						? Clock3
						: XCircle

	return (
		<div
			className={`rounded border px-2.5 py-2 text-sm ${failed ? "border-vscode-inputValidation-errorBorder" : "border-vscode-widget-border"}`}>
			<div className="flex min-w-0 items-center gap-2">
				<Icon className={`size-3.5 shrink-0 ${hook.status === "running" ? "animate-spin" : ""}`} aria-hidden />
				<span className="min-w-0 flex-1 truncate font-medium">{hook.name}</span>
				<span className="shrink-0 text-xs text-vscode-descriptionForeground">
					{t(`chat:hooks.phase.${hook.phase}`)} · {t(`chat:hooks.status.${hook.status}`)}
				</span>
			</div>
			<div className="mt-1 truncate text-xs text-vscode-descriptionForeground">
				{t(`chat:hooks.summary.${hook.status}`)}
			</div>
			{details && hook.status !== "running" ? (
				<details className="mt-1.5 text-xs">
					<summary className="cursor-pointer text-vscode-textLink-foreground">
						{t("chat:hooks.details")}
					</summary>
					<pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-vscode-textCodeBlock-background p-2 font-mono">
						{details}
					</pre>
				</details>
			) : null}
			{failed ? (
				<button
					className="mt-1.5 flex cursor-pointer items-center gap-1 text-xs text-vscode-textLink-foreground hover:underline"
					onClick={() =>
						window.postMessage(
							{ type: "action", action: "settingsButtonClicked", values: { section: "hooks" } },
							"*",
						)
					}>
					<Settings2 className="size-3" aria-hidden />
					{t("chat:hooks.openSettings")}
				</button>
			) : null}
		</div>
	)
}
