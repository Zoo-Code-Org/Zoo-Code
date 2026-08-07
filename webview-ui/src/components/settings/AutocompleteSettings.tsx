import { HTMLAttributes, useMemo } from "react"
import { VSCodeCheckbox, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { Sparkles } from "lucide-react"

import {
	AUTOCOMPLETE_DEFAULTS,
	AUTOCOMPLETE_LIMITS,
	type AutocompleteConfig,
	type AutocompleteProfile,
	type AutocompleteProviderId,
} from "@roo-code/types"

import { useAppTranslation } from "@/i18n/TranslationContext"

import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"
import { AutocompleteProfileBar } from "./autocomplete/AutocompleteProfileBar"
import { AutocompleteModelPicker } from "./autocomplete/AutocompleteModelPicker"
import { SearchableSelect, Slider } from "../ui"

/**
 * Placeholder base URLs per transport. Shown as a hint rather than written into
 * state, so switching providers never silently overwrites a URL the user typed.
 */
const BASE_URL_PLACEHOLDERS: Record<string, string> = {
	ollama: "http://localhost:11434",
	"openai-compatible": "http://localhost:1234",
	codestral: "https://codestral.mistral.ai",
}

/**
 * Transports that *always* need a key. Every other transport may still need one:
 * `https://ollama.com/v1` and hosted vLLM authenticate exactly like Codestral,
 * while `localhost` usually does not. The field is therefore always shown and
 * simply optional — hiding it made remote endpoints impossible to configure.
 */
const PROVIDERS_REQUIRING_API_KEY: ReadonlySet<string> = new Set(["codestral"])

/**
 * Slider bounds for the suggestion-length cap.
 *
 * Deliberately narrower than the schema's 1–2048: the post-processor already
 * truncates to 12 lines, so tokens generated beyond roughly this ceiling are
 * discarded after the user has waited for them.
 */
const MAX_OUTPUT_TOKENS_RANGE = { min: 64, max: 512 } as const

/**
 * The transports that speak fill-in-the-middle natively — the whole of the
 * provider dropdown.
 *
 * Autocomplete is FIM-only by design. Every other provider the extension supports
 * has to be *asked* for a completion through the chat path, which is slower, less
 * accurate, and discards the after-cursor suffix that makes FIM work at all.
 * Offering them produced a dropdown of thirty entries where three worked well and
 * the rest quietly underperformed — including several near-identical "OpenAI"
 * rows (`openai-native`, `openai-codex`, `openai`) that differed only in ways
 * invisible at the point of choosing.
 */
const NATIVE_FIM_OPTIONS: readonly { value: string; label: string }[] = [
	{ value: "ollama", label: "Ollama" },
	{ value: "openai-compatible", label: "OpenAI Compatible (LM Studio, llama.cpp, vLLM)" },
	{ value: "codestral", label: "Mistral Codestral" },
]

/**
 * Providers reached at a user-supplied endpoint.
 *
 * Codestral is absent because it derives its endpoint from the provider.
 */
const PROVIDERS_WITH_BASE_URL: ReadonlySet<string> = new Set(["ollama", "openai-compatible"])

export interface AutocompleteSettingsProps extends HTMLAttributes<HTMLDivElement> {
	autocompleteConfig?: AutocompleteConfig
	/** Whether a key is already stored. The key itself never reaches the webview. */
	hasAutocompleteApiKey?: boolean
	/** `undefined` until the user types, so an untouched field leaves the stored key alone. */
	autocompleteApiKeyDraft?: string
	autocompleteProfiles?: AutocompleteProfile[]
	activeAutocompleteProfileId?: string
	setAutocompleteConfigField: <K extends keyof AutocompleteConfig>(field: K, value: AutocompleteConfig[K]) => void
	setAutocompleteApiKey: (apiKey: string) => void
	onSelectProfile?: (profileId: string) => void
	onSaveProfile?: (name: string) => void
	onRenameProfile?: (profileId: string, name: string) => void
	onDeleteProfile?: (profileId: string) => void
}

/**
 * Autocomplete settings.
 *
 * Two sections only — the master switch, then the model that serves it — with
 * behaviour tuning inline at the end. Field order follows the order a user fills
 * them in: provider, endpoint, credential, model. Everything is on one page; the
 * setting count is small enough that a disclosure cost more than it saved.
 */
export const AutocompleteSettings = ({
	autocompleteConfig,
	hasAutocompleteApiKey,
	autocompleteApiKeyDraft,
	autocompleteProfiles,
	activeAutocompleteProfileId,
	setAutocompleteConfigField,
	setAutocompleteApiKey,
	onSelectProfile,
	onSaveProfile,
	onRenameProfile,
	onDeleteProfile,
	...props
}: AutocompleteSettingsProps) => {
	const { t } = useAppTranslation()

	const enabled = autocompleteConfig?.enabled ?? AUTOCOMPLETE_DEFAULTS.ENABLED
	const provider = autocompleteConfig?.provider ?? AUTOCOMPLETE_DEFAULTS.PROVIDER
	const debounceMs = autocompleteConfig?.debounceMs ?? AUTOCOMPLETE_DEFAULTS.DEBOUNCE_MS
	// Clamped to the slider's own range. The schema permits up to 2048, so a config
	// written by hand, imported, or saved before these bounds were tightened can hold
	// a larger number — which the slider could only render as a handle pinned to the
	// far right, indistinguishable from a legitimate maximum.
	const storedMaxOutputTokens = autocompleteConfig?.maxOutputTokens ?? AUTOCOMPLETE_DEFAULTS.MAX_OUTPUT_TOKENS
	const maxOutputTokens = Math.min(
		Math.max(storedMaxOutputTokens, MAX_OUTPUT_TOKENS_RANGE.min),
		MAX_OUTPUT_TOKENS_RANGE.max,
	)
	const maxOutputTokensClamped = storedMaxOutputTokens !== maxOutputTokens

	const requiresApiKey = PROVIDERS_REQUIRING_API_KEY.has(provider)
	// Shown whenever the provider is reached at a user-supplied endpoint, and also
	// whenever one is already stored — hiding a field that holds a value would
	// strand the user with a URL they cannot see or edit.
	const showBaseUrl = PROVIDERS_WITH_BASE_URL.has(provider) || Boolean(autocompleteConfig?.baseUrl)
	// Local endpoints don't need a key, but remote ones reached through the same
	// transport do, so the field is always available and labelled optional.
	const isRemoteEndpoint = /^https:\/\//i.test(autocompleteConfig?.baseUrl ?? "")

	const profiles = autocompleteProfiles ?? []
	const activeProfile = profiles.find((entry) => entry.id === activeAutocompleteProfileId)
	// Compared field-by-field against the saved snapshot so the bar can tell the
	// user their edits are unsaved rather than silently diverging from the preset.
	const isDirty = activeProfile ? !isSameConfig(activeProfile.config, autocompleteConfig) : false

	const showProfiles = Boolean(onSelectProfile && onSaveProfile && onRenameProfile && onDeleteProfile)

	const providerOptions = useMemo(() => [...NATIVE_FIM_OPTIONS], [])

	return (
		<div {...props}>
			<SectionHeader description={t("settings:autocomplete.description")}>
				<div className="flex items-center gap-2">
					<Sparkles className="w-4" />
					<div>{t("settings:sections.autocomplete")}</div>
				</div>
			</SectionHeader>

			<Section>
				<SearchableSetting
					settingId="autocomplete-enabled"
					section="autocomplete"
					label={t("settings:autocomplete.enable.label")}>
					<div>
						<VSCodeCheckbox
							checked={enabled}
							onChange={(e: unknown) =>
								setAutocompleteConfigField(
									"enabled",
									(e as { target: { checked: boolean } }).target.checked,
								)
							}
							data-testid="autocomplete-enabled-checkbox">
							<span className="font-medium">{t("settings:autocomplete.enable.label")}</span>
						</VSCodeCheckbox>
						<div className="text-vscode-descriptionForeground text-sm mt-1 ml-6">
							{t("settings:autocomplete.enable.description")}
						</div>
					</div>
				</SearchableSetting>

				{/*
				 * Accepting, dismissing and cycling are core VS Code keybindings that an
				 * extension cannot rebind, so they are surfaced as guidance rather than
				 * as controls that would only pretend to work.
				 */}
				<div className="text-vscode-descriptionForeground text-xs mt-3 ml-6">
					{t("settings:autocomplete.shortcuts.description")}
				</div>
			</Section>

			<Section>
				<GroupHeading
					title={t("settings:autocomplete.model.sectionTitle")}
					description={t("settings:autocomplete.model.sectionDescription")}
				/>
				{showProfiles && (
					<SearchableSetting
						settingId="autocomplete-profiles"
						section="autocomplete"
						label={t("settings:autocomplete.profiles.label")}>
						<AutocompleteProfileBar
							profiles={profiles}
							activeProfileId={activeAutocompleteProfileId}
							isDirty={isDirty}
							onSelect={onSelectProfile!}
							onSave={onSaveProfile!}
							onRename={onRenameProfile!}
							onDelete={onDeleteProfile!}
						/>
					</SearchableSetting>
				)}

				<SearchableSetting
					settingId="autocomplete-provider"
					section="autocomplete"
					label={t("settings:autocomplete.provider.label")}>
					<div>
						<label className="block font-medium mb-1">{t("settings:autocomplete.provider.label")}</label>
						<SearchableSelect
							value={provider}
							onValueChange={(value) => setAutocompleteConfigField("provider", value)}
							options={providerOptions}
							placeholder={t("settings:common.select")}
							searchPlaceholder={t("settings:providers.searchProviderPlaceholder")}
							emptyMessage={t("settings:providers.noProviderMatchFound")}
							disabled={!enabled}
							className="w-full"
							data-testid="autocomplete-provider-select"
						/>
						<div className="text-vscode-descriptionForeground text-sm mt-1">
							{t("settings:autocomplete.provider.nativeFimHint")}
						</div>
					</div>
				</SearchableSetting>

				{showBaseUrl && (
					<SearchableSetting
						settingId="autocomplete-base-url"
						section="autocomplete"
						label={t("settings:autocomplete.baseUrl.label")}>
						<div>
							<label className="block font-medium mb-1">{t("settings:autocomplete.baseUrl.label")}</label>
							<VSCodeTextField
								value={autocompleteConfig?.baseUrl ?? ""}
								placeholder={BASE_URL_PLACEHOLDERS[provider] ?? ""}
								disabled={!enabled}
								onInput={(e: unknown) =>
									setAutocompleteConfigField(
										"baseUrl",
										(e as { target: { value: string } }).target.value,
									)
								}
								className="w-full"
								data-testid="autocomplete-base-url-input"
							/>
						</div>
					</SearchableSetting>
				)}

				<SearchableSetting
					settingId="autocomplete-api-key"
					section="autocomplete"
					label={t("settings:autocomplete.apiKey.label")}>
					<div>
						<label className="block font-medium mb-1">
							{requiresApiKey
								? t("settings:autocomplete.apiKey.label")
								: t("settings:autocomplete.apiKey.optionalLabel")}
						</label>
						<VSCodeTextField
							type="password"
							value={autocompleteApiKeyDraft ?? ""}
							placeholder={
								hasAutocompleteApiKey
									? t("settings:autocomplete.apiKey.storedPlaceholder")
									: t("settings:autocomplete.apiKey.emptyPlaceholder")
							}
							disabled={!enabled}
							onInput={(e: unknown) =>
								setAutocompleteApiKey((e as { target: { value: string } }).target.value)
							}
							className="w-full"
							data-testid="autocomplete-api-key-input"
						/>
						<div className="text-vscode-descriptionForeground text-sm mt-1">
							{requiresApiKey || isRemoteEndpoint
								? t("settings:autocomplete.apiKey.description")
								: t("settings:autocomplete.apiKey.localDescription")}
						</div>
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="autocomplete-model"
					section="autocomplete"
					label={t("settings:autocomplete.model.label")}>
					<AutocompleteModelPicker
						provider={provider as AutocompleteProviderId}
						baseUrl={autocompleteConfig?.baseUrl}
						apiKeyDraft={autocompleteApiKeyDraft}
						hasStoredApiKey={hasAutocompleteApiKey}
						modelId={autocompleteConfig?.modelId}
						disabled={!enabled}
						onChange={(value) => setAutocompleteConfigField("modelId", value)}
					/>
				</SearchableSetting>
			</Section>

			<Section>
				<GroupHeading
					title={t("settings:autocomplete.behavior.sectionTitle")}
					description={t("settings:autocomplete.behavior.sectionDescription")}
				/>
				<SearchableSetting
					settingId="autocomplete-debounce"
					section="autocomplete"
					label={t("settings:autocomplete.debounce.label")}>
					<div>
						<label className="block font-medium mb-1">{t("settings:autocomplete.debounce.label")}</label>
						<div className="flex items-center gap-2">
							<Slider
								min={AUTOCOMPLETE_LIMITS.DEBOUNCE_MS.min}
								max={1_000}
								step={25}
								value={[debounceMs]}
								onValueChange={([value]) => setAutocompleteConfigField("debounceMs", value)}
								disabled={!enabled}
								data-testid="autocomplete-debounce-slider"
							/>
							<span className="w-14 text-right text-sm">{debounceMs}ms</span>
						</div>
						<div className="text-vscode-descriptionForeground text-sm mt-1">
							{t("settings:autocomplete.debounce.description")}
						</div>
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="autocomplete-max-output-tokens"
					section="autocomplete"
					label={t("settings:autocomplete.maxOutputTokens.label")}>
					<div>
						<label className="block font-medium mb-1">
							{t("settings:autocomplete.maxOutputTokens.label")}
						</label>
						<div className="flex items-center gap-2">
							<Slider
								min={MAX_OUTPUT_TOKENS_RANGE.min}
								max={MAX_OUTPUT_TOKENS_RANGE.max}
								step={16}
								value={[maxOutputTokens]}
								onValueChange={([value]) => setAutocompleteConfigField("maxOutputTokens", value)}
								disabled={!enabled}
								data-testid="autocomplete-max-output-tokens-slider"
							/>
							<span className="w-14 text-right text-sm">{maxOutputTokens}</span>
						</div>
						<div className="text-vscode-descriptionForeground text-sm mt-1">
							{t("settings:autocomplete.maxOutputTokens.description")}
						</div>
						{maxOutputTokensClamped && (
							<div
								className="text-vscode-descriptionForeground text-sm mt-1"
								data-testid="autocomplete-max-output-tokens-clamped">
								{t("settings:autocomplete.maxOutputTokens.clamped", {
									stored: storedMaxOutputTokens,
									max: MAX_OUTPUT_TOKENS_RANGE.max,
								})}
							</div>
						)}
					</div>
				</SearchableSetting>
			</Section>
		</div>
	)
}

/**
 * Compact heading for a group of settings inside a section.
 *
 * Deliberately not a {@link SectionHeader}: that one is sticky and carries
 * `pt-6 pb-4`, so stacking three of them in a single panel produced three
 * floating bars and a great deal of dead vertical space.
 */
const GroupHeading = ({ title, description }: { title: string; description: string }) => (
	<div className="border-t border-vscode-panel-border pt-4 first:border-t-0 first:pt-0">
		<h4 className="text-vscode-foreground font-semibold m-0">{title}</h4>
		<p className="text-vscode-descriptionForeground text-sm mt-1 mb-0">{description}</p>
	</div>
)

/** Field-by-field comparison used to detect unsaved edits against a saved profile. */
function isSameConfig(a: AutocompleteConfig, b: AutocompleteConfig | undefined): boolean {
	if (!b) {
		return false
	}

	const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof AutocompleteConfig>

	for (const key of keys) {
		const left = a[key]
		const right = b[key]

		if (Array.isArray(left) || Array.isArray(right)) {
			if (JSON.stringify(left ?? []) !== JSON.stringify(right ?? [])) {
				return false
			}

			continue
		}

		if (left !== right) {
			return false
		}
	}

	return true
}
