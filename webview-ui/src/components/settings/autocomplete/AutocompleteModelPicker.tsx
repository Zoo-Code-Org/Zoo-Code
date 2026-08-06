import { useCallback, useEffect, useRef, useState } from "react"
import { CheckCircle2, KeyRound, RefreshCw, XCircle } from "lucide-react"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import type { AutocompleteModelSummary, AutocompleteProviderId } from "@roo-code/types"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { useEvent } from "react-use"
import { vscode } from "@src/utils/vscode"

import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, StandardTooltip } from "../../ui"

export interface AutocompleteModelPickerProps {
	provider: AutocompleteProviderId
	baseUrl?: string
	apiKeyDraft?: string
	/** True when a key is already in Secret Storage (the key itself never reaches the webview). */
	hasStoredApiKey?: boolean
	modelId?: string
	disabled?: boolean
	onChange: (modelId: string) => void
}

/**
 * Model field for autocomplete: a dropdown of what the endpoint actually offers,
 * with a free-text fallback.
 *
 * Both halves are load-bearing. Listing endpoints is how a user avoids typing an
 * exact model id from memory; free text is how they reach a model the endpoint
 * doesn't enumerate (Ollama tags not yet pulled, or a server with no models API).
 *
 * Fetching is triggered by an explicit refresh and by the endpoint settling —
 * never on bare mount, because `SettingsView` renders every section at opacity-0
 * during search indexing, and a mount-time fetch would fire for every user on
 * every settings open.
 */
export const AutocompleteModelPicker = ({
	provider,
	baseUrl,
	apiKeyDraft,
	hasStoredApiKey,
	modelId,
	disabled,
	onChange,
}: AutocompleteModelPickerProps) => {
	const { t } = useAppTranslation()

	const [models, setModels] = useState<AutocompleteModelSummary[]>([])
	const [status, setStatus] = useState<"idle" | "loading" | "connected" | "error">("idle")
	const [error, setError] = useState<string | undefined>(undefined)

	// A hosted endpoint will reject an unauthenticated request, so listing models
	// before a key exists produces a guaranteed 401 that reads as a broken feature.
	// Local endpoints (http://localhost, 127.0.0.1) need no key.
	const isRemote = /^https:\/\//i.test(baseUrl ?? "") && !/localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(baseUrl ?? "")
	const hasCredential = Boolean(apiKeyDraft) || Boolean(hasStoredApiKey)
	const needsKey = isRemote && !hasCredential

	// Identifies the endpoint so a change can retrigger the fetch, and so a stale
	// in-flight response for a previous endpoint can be ignored.
	const endpointKey = `${provider}|${baseUrl ?? ""}`
	const requestedKey = useRef<string | undefined>(undefined)

	const fetchModels = useCallback(() => {
		if (disabled || needsKey) {
			return
		}

		requestedKey.current = endpointKey
		setStatus("loading")
		setError(undefined)

		vscode.postMessage({
			type: "requestAutocompleteModels",
			values: { provider, baseUrl, ...(apiKeyDraft ? { apiKey: apiKeyDraft } : {}) },
		})
	}, [provider, baseUrl, apiKeyDraft, disabled, needsKey, endpointKey])

	const onMessage = useCallback((event: MessageEvent) => {
		const message = event.data

		if (message?.type !== "autocompleteModels") {
			return
		}

		const payload = message.autocompleteModels as { models?: AutocompleteModelSummary[]; error?: string }

		if (payload?.error) {
			setStatus("error")
			setError(payload.error)
			setModels([])
			return
		}

		setStatus("connected")
		setError(undefined)
		setModels(payload?.models ?? [])
	}, [])

	useEvent("message", onMessage)

	// Auto-fetch once the endpoint has settled, so a user who types a base URL
	// gets a populated list without hunting for a refresh button. Debounced
	// because `baseUrl` changes on every keystroke.
	useEffect(() => {
		if (disabled || needsKey || !baseUrl || requestedKey.current === endpointKey) {
			return
		}

		const timer = setTimeout(fetchModels, 600)

		return () => clearTimeout(timer)
	}, [endpointKey, baseUrl, disabled, needsKey, fetchModels])

	// A newly-entered key unblocks a fetch the gate above refused. Debounced
	// longer, since a key is pasted or typed character by character.
	useEffect(() => {
		if (disabled || !isRemote || !hasCredential || models.length > 0 || status === "loading") {
			return
		}

		const timer = setTimeout(fetchModels, 800)

		return () => clearTimeout(timer)
	}, [disabled, isRemote, hasCredential, models.length, status, fetchModels])

	const hasModels = models.length > 0
	// A model the endpoint doesn't list (typed by hand, or not yet pulled) must
	// still display as the current selection rather than silently reading empty.
	const isUnlisted = Boolean(modelId) && !models.some((model) => model.id === modelId)

	return (
		<div className="flex flex-col gap-1">
			<label className="block font-medium mb-1">{t("settings:autocomplete.model.label")}</label>

			<div className="flex items-center gap-2">
				{hasModels ? (
					<Select value={modelId ?? ""} onValueChange={onChange} disabled={disabled}>
						<SelectTrigger className="flex-1" data-testid="autocomplete-model-select">
							<SelectValue placeholder={t("settings:autocomplete.model.selectPlaceholder")} />
						</SelectTrigger>
						<SelectContent>
							{isUnlisted && (
								<SelectItem key={modelId} value={modelId!}>
									{modelId}
								</SelectItem>
							)}
							{models.map((model) => (
								<SelectItem key={model.id} value={model.id}>
									{model.label ?? model.id}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				) : (
					<VSCodeTextField
						value={modelId ?? ""}
						placeholder={t("settings:autocomplete.model.selectPlaceholder")}
						disabled={disabled}
						onInput={(e: unknown) => onChange((e as { target: { value: string } }).target.value)}
						className="flex-1"
						data-testid="autocomplete-model-input"
					/>
				)}

				<StandardTooltip content={t("settings:autocomplete.model.refresh")}>
					<Button
						variant="ghost"
						size="icon"
						disabled={disabled || status === "loading"}
						onClick={fetchModels}
						data-testid="autocomplete-model-refresh">
						<RefreshCw className={status === "loading" ? "size-4 animate-spin" : "size-4"} />
					</Button>
				</StandardTooltip>
			</div>

			{hasModels && (
				<VSCodeTextField
					value={modelId ?? ""}
					placeholder={t("settings:autocomplete.model.customPlaceholder")}
					disabled={disabled}
					onInput={(e: unknown) => onChange((e as { target: { value: string } }).target.value)}
					className="w-full mt-1"
					data-testid="autocomplete-model-input"
				/>
			)}

			{needsKey && (
				<div
					className="text-vscode-descriptionForeground text-sm mt-1 flex items-center gap-1"
					data-testid="autocomplete-model-needs-key">
					<KeyRound className="size-3.5 shrink-0" />
					{t("settings:autocomplete.connection.needsKey")}
				</div>
			)}

			{status === "loading" && (
				<div
					className="text-vscode-descriptionForeground text-sm mt-1"
					data-testid="autocomplete-model-loading">
					{t("settings:autocomplete.connection.checking")}
				</div>
			)}

			{status === "connected" && (
				<div
					className="text-vscode-charts-green text-sm mt-1 flex items-center gap-1"
					data-testid="autocomplete-model-connected">
					<CheckCircle2 className="size-3.5 shrink-0" />
					{t("settings:autocomplete.connection.connected", { count: models.length })}
				</div>
			)}

			{status === "error" && (
				<div
					className="text-vscode-errorForeground text-sm mt-1 flex items-start gap-1"
					data-testid="autocomplete-model-error">
					<XCircle className="size-3.5 shrink-0 mt-0.5" />
					<span>{t("settings:autocomplete.model.fetchFailed", { error })}</span>
				</div>
			)}

			<div className="text-vscode-descriptionForeground text-sm mt-1">
				{t("settings:autocomplete.model.description")}
			</div>
		</div>
	)
}
