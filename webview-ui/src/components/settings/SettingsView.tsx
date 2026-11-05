import React, {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useReducer,
	useState,
} from "react"
import {
	CheckCheck,
	GitBranch,
	Bell,
	Database,
	SquareTerminal,
	FlaskConical,
	Globe,
	Info,
	MessageSquare,
	LucideIcon,
	SquareSlash,
	Glasses,
	Plug,
	Server,
	UsersRound,
	ArrowLeft,
	GitCommitVertical,
	GraduationCap,
	ScrollText,
} from "lucide-react"

import {
	type ProviderSettings,
	type ExperimentId,
	type TelemetrySetting,
	DEFAULT_AUTO_CLOSE_ZOO_OPENED_FILES,
	DEFAULT_AUTO_CLOSE_ZOO_OPENED_FILES_AFTER_USER_EDITED,
	DEFAULT_AUTO_CLOSE_ZOO_OPENED_NEW_FILES,
	DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
	ImageGenerationProvider,
} from "@roo-code/types"

import { vscode } from "@src/utils/vscode"
import { APPEARANCE_SETTINGS, type AppearanceKey } from "@src/utils/appearance"
import { useLatestRef } from "@src/hooks/useLatestRef"
import { cn } from "@src/lib/utils"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { ExtensionStateContextType, useExtensionState } from "@src/context/ExtensionStateContext"
import { Button, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, StandardTooltip } from "@src/components/ui"

import { Tab, TabContent, TabHeader, TabList, TabTrigger } from "../common/Tab"
import { SetCachedStateField, SetExperimentEnabled } from "./types"
import { UnsavedChangesDialog } from "./UnsavedChangesDialog"
import { SectionHeader } from "./SectionHeader"
import ApiConfigManager from "./ApiConfigManager"
import ApiOptions from "./ApiOptions"
import { AutoApproveSettings } from "./AutoApproveSettings"
import { CheckpointSettings } from "./CheckpointSettings"
import { NotificationSettings } from "./NotificationSettings"
import { ContextManagementSettings } from "./ContextManagementSettings"
import { TerminalSettings } from "./TerminalSettings"
import { ExperimentalSettings } from "./ExperimentalSettings"
import { LanguageSettings } from "./LanguageSettings"
import { About } from "./About"
import { Section } from "./Section"
import PromptsSettings from "./PromptsSettings"
import { SlashCommandsSettings } from "./SlashCommandsSettings"
import { SkillsSettings } from "./SkillsSettings"
import { RulesSettings } from "./RulesSettings"
import { UISettings } from "./UISettings"
import { nextSaveRequestId } from "./saveRequestId"
import ModesView from "../modes/ModesView"
import McpView from "../mcp/McpView"
import { WorktreesView } from "../worktrees/WorktreesView"
import { SettingsSearch } from "./SettingsSearch"
import { useSearchIndexRegistry, SearchIndexProvider } from "./useSettingsSearch"

export const settingsTabsContainer = "flex flex-1 overflow-hidden [&.narrow_.tab-label]:hidden"
export const settingsTabList =
	"w-48 data-[compact=true]:w-12 flex-shrink-0 flex flex-col overflow-y-auto overflow-x-hidden border-r border-vscode-sideBar-background"
export const settingsTabTrigger =
	"whitespace-nowrap overflow-hidden min-w-0 h-12 px-4 py-3 box-border flex items-center border-l-2 border-transparent text-vscode-foreground opacity-70 hover:bg-vscode-list-hoverBackground data-[compact=true]:w-12 data-[compact=true]:p-4"
export const settingsTabTriggerActive = "opacity-100 border-vscode-focusBorder bg-vscode-list-activeSelectionBackground"

export interface SettingsViewRef {
	checkUnsaveChanges: (then: () => void) => void
}

/**
 * How long the form waits for the host to answer a save that changes an appearance value, or a time or date value.
 * The host always answers (success or failure), but a write that never settles would otherwise leave the form locked
 * until the webview reloads. After this the outcome of the save is unknown, not failed: the edits stay, Save and Done
 * work again, and the save is kept (`timedOutSaves`) because the host may still store it. If its answer comes later, a
 * success is reconciled with the form (the stored values are what it compares with from then on, and the values the
 * user is not editing take them) and a failure changes nothing. Until then, leaving the page warns that the save may
 * still complete.
 */
export const SAVE_ANSWER_TIMEOUT_MS = 20_000

/**
 * How long, and how many, saves that were not answered are kept. A host that has not answered after this long is not
 * going to: the save is forgotten (its late answer is ignored, and the warning that it may still complete goes away).
 * The oldest is dropped beyond the limit, so a view that stays open cannot collect them without end.
 */
export const TIMED_OUT_SAVE_KEEP_MS = 10 * 60_000
export const MAX_TIMED_OUT_SAVES = 10

export const sectionNames = [
	"providers",
	"autoApprove",
	"slashCommands",
	"skills",
	"rules",
	"checkpoints",
	"notifications",
	"contextManagement",
	"terminal",
	"modes",
	"mcp",
	"worktrees",
	"prompts",
	"ui",
	"experimental",
	"language",
	"about",
] as const

export type SectionName = (typeof sectionNames)[number]

type SettingsViewProps = {
	onDone: () => void
	targetSection?: string
}

const SettingsView = forwardRef<SettingsViewRef, SettingsViewProps>(({ onDone, targetSection }, ref) => {
	const { t } = useAppTranslation()

	const extensionState = useExtensionState()
	const { currentApiConfigName, listApiConfigMeta, uriScheme, settingsImportedAt, settingsImportRefreshedAt, mode } =
		extensionState

	const [isDiscardDialogShow, setDiscardDialogShow] = useState(false)
	// Whether the form has unsaved changes, and how many changes the user has made in all. The count only goes up: a
	// save remembers the count it was made at, to tell whether the user edited again while it was in flight, and a
	// reset of the flag (an import, a profile switch) must not make a later edit look like no edit. (Not the identity
	// of the state object: an automatic update of the state that is no edit, such as a settings page initialising
	// itself, replaces that object too.)
	const [{ count: changeCount, changed: isChangeDetected }, setChangeDetected] = useReducer(
		(state: { count: number; changed: boolean }, changed: boolean) => ({
			count: changed ? state.count + 1 : state.count,
			changed,
		}),
		{ count: 0, changed: false },
	)
	// The save currently waiting for the host's answer. The "unsaved changes" flag stays on until it succeeds.
	const [pendingSaveId, setPendingSaveId] = useState<string | undefined>(undefined)
	const pendingSaveChangeCount = useRef(0)
	// Appearance values that a successful save stored, until the live state shows them. The host reports a success even
	// if refreshing the state failed afterwards, and then the live state is stale: comparing with it alone would take
	// a later reset to the old value for "nothing changed" and not send it.
	const appearanceSaved = useRef<Record<string, number | null>>({})
	// Saves that were not answered in time. Their outcome is unknown: the host may still store them.
	const timedOutSaves = useRef(
		new Map<
			string,
			{
				sent: Record<string, number | null>
				changeCount: number
				expiry: ReturnType<typeof setTimeout>
			}
		>(),
	)
	// Nothing outlives the view: its timers are cleared, and what it kept is let go.
	useEffect(() => {
		const saves = timedOutSaves.current
		return () => {
			for (const { expiry } of saves.values()) clearTimeout(expiry)
			saves.clear()
		}
	}, [])
	const [saveOutcomeUnknown, setSaveOutcomeUnknown] = useState(false)
	// The appearance values this form has edited. A value that only differs from the live state because the live state
	// changed (another webview, a reset from the host) is not an edit and is never sent. A ref, not state: it is read
	// when saving and needs no render of its own.
	const editedAppearance = useRef(new Set<AppearanceKey>())
	// What the pending save sent for each appearance value, to tell which edits it has saved when it succeeds.
	const pendingAppearanceSent = useRef<Record<string, number | null>>({})
	// A request to leave the form (a tab switch, a command from the host) that came in while a save was pending. It is
	// asked again, through the same unsaved-changes check, once the save has settled.
	const heldNavigation = useRef<(() => void) | undefined>(undefined)
	const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined)
	const [activeTab, setActiveTab] = useState<SectionName>(
		targetSection && sectionNames.includes(targetSection as SectionName)
			? (targetSection as SectionName)
			: "providers",
	)

	const scrollPositions = useRef<Record<SectionName, number>>(
		Object.fromEntries(sectionNames.map((s) => [s, 0])) as Record<SectionName, number>,
	)
	const contentRef = useRef<HTMLDivElement | null>(null)

	const prevApiConfigName = useRef(currentApiConfigName)
	const prevMode = useRef(mode)
	const handledSettingsImportedAt = useRef<number | undefined>(undefined)
	const confirmDialogHandler = useRef<() => void>()

	const [cachedState, setCachedState] = useState(() => extensionState)
	// What the save results are compared with: the latest commit, not the one before it (see `useLatestRef`).
	const latestCachedState = useLatestRef(cachedState)
	const latestChangeCount = useLatestRef(changeCount)

	const {
		alwaysAllowReadOnly,
		alwaysAllowReadOnlyOutsideWorkspace,
		allowedReadFiles,
		allowedCommands,
		deniedCommands,
		allowedMaxRequests,
		allowedMaxCost,
		language,
		alwaysAllowExecute,
		destructiveCommandGuardEnabled,
		alwaysDenyUnapprovedCommands,
		alwaysAllowMcp,
		alwaysAllowModeSwitch,
		alwaysAllowSubtasks,
		alwaysAllowWrite,
		alwaysAllowWriteOutsideWorkspace,
		alwaysAllowWriteProtected,
		allowedWriteFiles,
		autoCondenseContext,
		autoCondenseContextPercent,
		enableCheckpoints,
		checkpointTimeout,
		experiments,
		maxOpenTabsContext,
		maxWorkspaceFiles,
		mcpEnabled,
		soundEnabled,
		ttsEnabled,
		ttsSpeed,
		soundVolume,
		telemetrySetting,
		terminalOutputPreviewSize,
		terminalShellIntegrationTimeout,
		terminalShellIntegrationDisabled, // Added from upstream
		collapseCommandOutputByDefault,
		terminalCommandDelay,
		terminalPowershellCounter,
		terminalZshClearEolMark,
		terminalZshOhMy,
		terminalZshP10k,
		terminalZdotdir,
		terminalProfile,
		writeDelayMs,
		diffFuzzyThreshold,
		showRooIgnoredFiles,
		enableSubfolderRules,
		maxImageFileSize,
		maxTotalImageSize,
		customSupportPrompts,
		profileThresholds,
		alwaysAllowFollowupQuestions,
		followupAutoApproveTimeoutMs,
		includeDiagnosticMessages,
		maxDiagnosticMessages,
		includeTaskHistoryInEnhance,
		imageGenerationProvider,
		openRouterImageApiKey,
		openRouterImageGenerationSelectedModel,
		reasoningBlockCollapsed,
		chatFontSize,
		interfaceFontScale,
		terminalFontSize,
		editorFontSize,
		spacingScale,
		timeFormat,
		dateFormat,
		showRelativeTimes,
		enterBehavior,
		includeCurrentTime,
		includeCurrentCost,
		maxGitStatusFiles,
		autoCloseZooOpenedFiles,
		autoCloseZooOpenedFilesAfterUserEdited,
		autoCloseZooOpenedNewFiles,
	} = cachedState

	const apiConfiguration = cachedState.apiConfiguration

	useEffect(() => {
		// Update when currentApiConfigName or mode changes.
		// Expected to be triggered by loadApiConfiguration/upsertApiConfiguration or mode switch.
		if (prevApiConfigName.current === currentApiConfigName && prevMode.current === mode) {
			return
		}

		setCachedState((prevCachedState) => ({ ...prevCachedState, ...extensionState }))
		prevApiConfigName.current = currentApiConfigName
		prevMode.current = mode
		editedAppearance.current.clear()
		setChangeDetected(false)
	}, [currentApiConfigName, mode, extensionState])

	// Bust the cache when settings are imported.
	useEffect(() => {
		if (!settingsImportedAt || handledSettingsImportedAt.current === settingsImportedAt) {
			return
		}

		handledSettingsImportedAt.current = settingsImportedAt
		setCachedState((prevCachedState) => ({ ...prevCachedState, ...extensionState }))
		editedAppearance.current.clear()
		setChangeDetected(false)
	}, [settingsImportedAt, extensionState])

	// An import that failed part of the way stored some of its settings: the form takes the values that changed with the
	// state that follows it, and keeps every other value as it is, with the edits made to them (unlike after an import
	// that succeeded, which replaces the form).
	const handledImportRefreshAt = useRef<number | undefined>(undefined)
	const liveStateBefore = useRef(extensionState)
	useEffect(() => {
		const before = liveStateBefore.current
		liveStateBefore.current = extensionState
		if (!settingsImportRefreshedAt || handledImportRefreshAt.current === settingsImportRefreshedAt) {
			return
		}

		handledImportRefreshAt.current = settingsImportRefreshedAt
		const stored: Record<string, unknown> = {}
		for (const [key, value] of Object.entries(extensionState)) {
			// Compared by value: the host builds new arrays and objects for every state it posts.
			if (
				key !== "settingsImportRefreshedAt" &&
				JSON.stringify(before[key as keyof typeof before]) !== JSON.stringify(value)
			) {
				stored[key] = value
			}
		}
		setCachedState((prevCachedState) => ({ ...prevCachedState, ...stored }))
	}, [settingsImportRefreshedAt, extensionState])

	const setCachedStateField: SetCachedStateField<keyof ExtensionStateContextType> = useCallback((field, value) => {
		setCachedState((prevState) => {
			if (prevState[field] === value) {
				return prevState
			}

			if (field in APPEARANCE_SETTINGS) editedAppearance.current.add(field as AppearanceKey)
			setChangeDetected(true)
			return { ...prevState, [field]: value }
		})
	}, [])

	const setApiConfigurationField = useCallback(
		<K extends keyof ProviderSettings>(field: K, value: ProviderSettings[K], isUserAction: boolean = true) => {
			setCachedState((prevState) => {
				if (prevState.apiConfiguration[field] === value) {
					return prevState
				}

				const previousValue = prevState.apiConfiguration[field]

				// Helper to check if two values are semantically equal
				const areValuesEqual = (a: any, b: any): boolean => {
					if (a === b) return true
					if (a == null && b == null) return true
					if (typeof a !== typeof b) return false
					if (typeof a === "object" && typeof b === "object") {
						return JSON.stringify(a) === JSON.stringify(b)
					}
					return false
				}

				// Only skip change detection for automatic initialization (not user actions)
				// This prevents the dirty state when the component initializes and auto-syncs values
				const isInitialSync =
					!isUserAction &&
					(previousValue === undefined || previousValue === "" || previousValue === null) &&
					value !== undefined &&
					value !== "" &&
					value !== null

				// Also skip if it's an automatic sync with semantically equal values
				const isAutomaticNoOpSync = !isUserAction && areValuesEqual(previousValue, value)

				if (!isInitialSync && !isAutomaticNoOpSync) {
					setChangeDetected(true)
				}
				return { ...prevState, apiConfiguration: { ...prevState.apiConfiguration, [field]: value } }
			})
		},
		[],
	)

	const setExperimentEnabled: SetExperimentEnabled = useCallback((id: ExperimentId, enabled: boolean) => {
		setCachedState((prevState) => {
			if (prevState.experiments?.[id] === enabled) {
				return prevState
			}

			setChangeDetected(true)
			return { ...prevState, experiments: { ...prevState.experiments, [id]: enabled } }
		})
	}, [])

	const setTelemetrySetting = useCallback((setting: TelemetrySetting) => {
		setCachedState((prevState) => {
			if (prevState.telemetrySetting === setting) {
				return prevState
			}

			setChangeDetected(true)
			return { ...prevState, telemetrySetting: setting }
		})
	}, [])

	const setDebug = useCallback((debug: boolean) => {
		setCachedState((prevState) => {
			if (prevState.debug === debug) {
				return prevState
			}

			setChangeDetected(true)
			return { ...prevState, debug }
		})
	}, [])

	const setImageGenerationProvider = useCallback((provider: ImageGenerationProvider) => {
		setCachedState((prevState) => {
			if (prevState.imageGenerationProvider !== provider) {
				setChangeDetected(true)
			}

			return { ...prevState, imageGenerationProvider: provider }
		})
	}, [])

	const setOpenRouterImageApiKey = useCallback((apiKey: string) => {
		setCachedState((prevState) => {
			if (prevState.openRouterImageApiKey !== apiKey) {
				setChangeDetected(true)
			}

			return { ...prevState, openRouterImageApiKey: apiKey }
		})
	}, [])

	const setImageGenerationSelectedModel = useCallback((model: string) => {
		setCachedState((prevState) => {
			if (prevState.openRouterImageGenerationSelectedModel !== model) {
				setChangeDetected(true)
			}

			return { ...prevState, openRouterImageGenerationSelectedModel: model }
		})
	}, [])

	const setCustomSupportPromptsField = useCallback((prompts: Record<string, string | undefined>) => {
		setCachedState((prevState) => {
			const previousStr = JSON.stringify(prevState.customSupportPrompts)
			const newStr = JSON.stringify(prompts)

			if (previousStr === newStr) {
				return prevState
			}

			setChangeDetected(true)
			return { ...prevState, customSupportPrompts: prompts }
		})
	}, [])

	const isSettingValid = !errorMessage

	// What the form compares an appearance value with: what a save stored, if the live state has not caught up yet.
	const savedAppearanceValue = (key: AppearanceKey) =>
		key in appearanceSaved.current ? appearanceSaved.current[key] : extensionState[key]

	// The time and date values are written one at a time on the host, and a write can fail: a save that changes one of
	// them waits for the host's answer too.
	const displayChanged =
		(cachedState.timeFormat ?? "auto") !== (extensionState.timeFormat ?? "auto") ||
		(cachedState.dateFormat ?? "auto") !== (extensionState.dateFormat ?? "auto") ||
		(cachedState.showRelativeTimes ?? true) !== (extensionState.showRelativeTimes ?? true)

	const handleSubmit = () => {
		if (isSettingValid) {
			// Only a save that changes an appearance value, or a time or date value, waits for the host's answer: the
			// appearance values are saved all-or-nothing, and a failed save has to keep the edits. Every other save
			// behaves as it always did.
			// Only the appearance values this form changed are sent, and null (not undefined) for a reset so it
			// survives JSON and clears the stored value. A save that changes none sends none of them, so it neither
			// waits for the host nor puts an appearance value into the host's all-or-nothing save.
			// A value whose earlier save was not answered is sent whatever it equals: that save may still store its value.
			const unresolved = new Set([...timedOutSaves.current.values()].flatMap(({ sent }) => Object.keys(sent)))
			const changedAppearance: Record<string, number | null> = Object.fromEntries(
				[...editedAppearance.current]
					.filter(
						(key) =>
							unresolved.has(key) || (cachedState[key] ?? null) !== (savedAppearanceValue(key) ?? null),
					)
					.map((key) => [key, cachedState[key] ?? null]),
			)
			const appearanceEdited = Object.keys(changedAppearance).length > 0
			const saveId = appearanceEdited || displayChanged ? nextSaveRequestId() : undefined
			if (saveId) {
				pendingSaveChangeCount.current = changeCount
				pendingAppearanceSent.current = changedAppearance
				// This save is the newer word on these values: an earlier save's late answer must not overwrite them.
				for (const { sent } of timedOutSaves.current.values())
					for (const key in changedAppearance) delete sent[key]
				setPendingSaveId(saveId)
			}
			vscode.postMessage({
				type: "updateSettings",
				requestId: saveId,
				updatedSettings: {
					language,
					alwaysAllowReadOnly: alwaysAllowReadOnly ?? undefined,
					alwaysAllowReadOnlyOutsideWorkspace: alwaysAllowReadOnlyOutsideWorkspace ?? undefined,
					allowedReadFiles: allowedReadFiles ?? [],
					alwaysAllowWrite: alwaysAllowWrite ?? undefined,
					alwaysAllowWriteOutsideWorkspace: alwaysAllowWriteOutsideWorkspace ?? undefined,
					alwaysAllowWriteProtected: alwaysAllowWriteProtected ?? undefined,
					allowedWriteFiles: allowedWriteFiles ?? [],
					alwaysAllowExecute: alwaysAllowExecute ?? undefined,
					destructiveCommandGuardEnabled: destructiveCommandGuardEnabled ?? false,
					alwaysDenyUnapprovedCommands: alwaysDenyUnapprovedCommands ?? false,
					alwaysAllowMcp,
					alwaysAllowModeSwitch,
					allowedCommands: allowedCommands ?? [],
					deniedCommands: deniedCommands ?? [],
					// Note that we use `null` instead of `undefined` since `JSON.stringify`
					// will omit `undefined` when serializing the object and passing it to the
					// extension host. We may need to do the same for other nullable fields.
					allowedMaxRequests: allowedMaxRequests ?? null,
					allowedMaxCost: allowedMaxCost ?? null,
					autoCondenseContext,
					autoCondenseContextPercent,
					soundEnabled: soundEnabled ?? true,
					soundVolume: soundVolume ?? 0.5,
					ttsEnabled,
					ttsSpeed,
					enableCheckpoints: enableCheckpoints ?? false,
					checkpointTimeout: checkpointTimeout ?? DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
					writeDelayMs,
					diffFuzzyThreshold,
					terminalShellIntegrationTimeout: terminalShellIntegrationTimeout ?? 30_000,
					terminalShellIntegrationDisabled,
					collapseCommandOutputByDefault,
					terminalCommandDelay,
					terminalPowershellCounter,
					terminalZshClearEolMark,
					terminalZshOhMy,
					terminalZshP10k,
					terminalZdotdir,
					terminalProfile: terminalProfile ?? "", // "" clears a saved profile; undefined is dropped by JSON.stringify
					terminalOutputPreviewSize: terminalOutputPreviewSize ?? "medium",
					mcpEnabled,
					maxOpenTabsContext: Math.min(Math.max(0, maxOpenTabsContext ?? 20), 500),
					maxWorkspaceFiles: Math.min(Math.max(0, maxWorkspaceFiles ?? 200), 500),
					showRooIgnoredFiles: showRooIgnoredFiles ?? true,
					enableSubfolderRules: enableSubfolderRules ?? false,
					maxImageFileSize: maxImageFileSize ?? 5,
					maxTotalImageSize: maxTotalImageSize ?? 20,
					includeDiagnosticMessages:
						includeDiagnosticMessages !== undefined ? includeDiagnosticMessages : true,
					maxDiagnosticMessages: maxDiagnosticMessages ?? 50,
					alwaysAllowSubtasks,
					alwaysAllowFollowupQuestions: alwaysAllowFollowupQuestions ?? false,
					followupAutoApproveTimeoutMs,
					includeTaskHistoryInEnhance: includeTaskHistoryInEnhance ?? true,
					reasoningBlockCollapsed: reasoningBlockCollapsed ?? true,
					chatFontSize: chatFontSize ?? null,
					...changedAppearance,
					timeFormat: timeFormat ?? "auto",
					dateFormat: dateFormat ?? "auto",
					showRelativeTimes: showRelativeTimes ?? true,
					enterBehavior: enterBehavior ?? "send",
					includeCurrentTime: includeCurrentTime ?? true,
					includeCurrentCost: includeCurrentCost ?? true,
					maxGitStatusFiles: maxGitStatusFiles ?? 0,
					autoCloseZooOpenedFiles: autoCloseZooOpenedFiles ?? DEFAULT_AUTO_CLOSE_ZOO_OPENED_FILES,
					autoCloseZooOpenedFilesAfterUserEdited:
						autoCloseZooOpenedFilesAfterUserEdited ?? DEFAULT_AUTO_CLOSE_ZOO_OPENED_FILES_AFTER_USER_EDITED,
					autoCloseZooOpenedNewFiles: autoCloseZooOpenedNewFiles ?? DEFAULT_AUTO_CLOSE_ZOO_OPENED_NEW_FILES,
					profileThresholds,
					imageGenerationProvider,
					openRouterImageApiKey,
					openRouterImageGenerationSelectedModel,
					experiments,
					customSupportPrompts,
				},
			})

			// These have more complex logic so they aren't (yet) handled
			// by the `updateSettings` message.
			vscode.postMessage({ type: "upsertApiConfiguration", text: currentApiConfigName, apiConfiguration })
			vscode.postMessage({ type: "telemetrySetting", text: telemetrySetting })
			vscode.postMessage({ type: "debugSetting", bool: cachedState.debug })

			// With an appearance edit, the "unsaved changes" flag is cleared only once the host reports that
			// `updateSettings` was stored: see the `settingsSaveResult` listener below. A failed save leaves the
			// user's edits in place to retry. Any other save clears it at once.
			if (!saveId) {
				// Nothing was sent, so no appearance edit is left to save (an edit that was undone equals the live value).
				editedAppearance.current.clear()
				setChangeDetected(false)
			}
		}
	}

	useEffect(() => {
		if (!pendingSaveId) return

		// The save is over: stored, failed, or not answered in time.
		const settle = (success: boolean) => {
			const editedAt = pendingSaveChangeCount.current
			const sent = pendingAppearanceSent.current
			pendingAppearanceSent.current = {}
			setPendingSaveId(undefined)

			// What was stored is no longer an unsaved edit, unless the user changed that value again meanwhile.
			if (success) {
				for (const [key, value] of Object.entries(sent)) {
					appearanceSaved.current[key] = value
					if ((latestCachedState.current[key as AppearanceKey] ?? null) === value) {
						editedAppearance.current.delete(key as AppearanceKey)
					}
				}
			}

			// An edit made while the save was in flight is not in what was sent: it stays unsaved.
			const clean = success && latestChangeCount.current === editedAt
			if (clean) setChangeDetected(false)

			// A request to leave that came in meanwhile goes through the unsaved-changes check now: it proceeds if
			// everything was stored, and otherwise (a failed save, or an edit made meanwhile) the user is asked.
			const held = heldNavigation.current
			heldNavigation.current = undefined
			if (held) {
				if (clean) {
					held()
				} else {
					confirmDialogHandler.current = held
					setDiscardDialogShow(true)
				}
			}
		}

		const onResult = (event: MessageEvent) => {
			const message = event.data
			if (message?.type !== "settingsSaveResult" || message.requestId !== pendingSaveId) return

			settle(message.success === true)
		}

		window.addEventListener("message", onResult)
		const timer = setTimeout(() => {
			// No answer is not a failure: the host may still store it. Its answer is waited for further on, and the
			// user is told if they leave meanwhile.
			const saves = timedOutSaves.current
			while (saves.size >= MAX_TIMED_OUT_SAVES) {
				const [oldest, entry] = saves.entries().next().value!
				clearTimeout(entry.expiry)
				saves.delete(oldest)
			}
			const saveId = pendingSaveId
			saves.set(saveId, {
				sent: { ...pendingAppearanceSent.current },
				changeCount: pendingSaveChangeCount.current,
				expiry: setTimeout(() => {
					saves.delete(saveId)
					setSaveOutcomeUnknown(saves.size > 0)
				}, TIMED_OUT_SAVE_KEEP_MS),
			})
			setSaveOutcomeUnknown(true)
			settle(false)
		}, SAVE_ANSWER_TIMEOUT_MS)
		return () => {
			clearTimeout(timer)
			window.removeEventListener("message", onResult)
		}
	}, [pendingSaveId, latestCachedState, latestChangeCount])

	// The answer to a save that was given up on. If it stored the values, the form is brought up to date with them: the
	// values the user is not editing now take the stored value, and every value is compared with it from now on.
	useEffect(() => {
		const onLateResult = (event: MessageEvent) => {
			const message = event.data
			if (message?.type !== "settingsSaveResult") return
			const late = timedOutSaves.current.get(message.requestId)
			if (!late) return

			clearTimeout(late.expiry)
			timedOutSaves.current.delete(message.requestId)
			setSaveOutcomeUnknown(timedOutSaves.current.size > 0)
			if (message.success !== true) return

			const { sent, changeCount: sentAt } = late
			for (const [key, value] of Object.entries(sent)) {
				appearanceSaved.current[key] = value
				// An edit that was kept and now equals what was stored is no longer an unsaved edit.
				if ((latestCachedState.current[key as AppearanceKey] ?? null) === value) {
					editedAppearance.current.delete(key as AppearanceKey)
				}
			}
			// Nothing else was changed since that save was sent: there is nothing left unsaved.
			if (latestChangeCount.current === sentAt) setChangeDetected(false)
			setCachedState((prev) => {
				const next = { ...prev }
				for (const [key, value] of Object.entries(sent)) {
					if (!editedAppearance.current.has(key as AppearanceKey)) {
						Object.assign(next, { [key]: value ?? undefined })
					}
				}
				return next
			})
		}

		window.addEventListener("message", onLateResult)
		return () => window.removeEventListener("message", onLateResult)
	}, [latestCachedState, latestChangeCount])

	// Once the live state shows an appearance value it is the one to compare with again (it may also be newer, if
	// another webview changed it).
	const previousLive = useRef<Record<string, number | null | undefined>>({})
	useEffect(() => {
		for (const key of Object.keys(APPEARANCE_SETTINGS) as AppearanceKey[]) {
			if (previousLive.current[key] !== extensionState[key]) delete appearanceSaved.current[key]
			previousLive.current[key] = extensionState[key]
		}
	}, [extensionState])

	const checkUnsaveChanges = useCallback(
		(then: () => void) => {
			// A save waiting for the host's answer keeps going whatever is chosen here, so leaving now (and offering
			// to discard changes that are being stored) would say something untrue. The request is kept, the latest
			// one if there are several, and goes through this check again when the save has settled.
			if (pendingSaveId) {
				heldNavigation.current = then
				return
			}

			if (isChangeDetected) {
				confirmDialogHandler.current = then
				setDiscardDialogShow(true)
			} else {
				then()
			}
		},
		[isChangeDetected, pendingSaveId],
	)

	useImperativeHandle(ref, () => ({ checkUnsaveChanges }), [checkUnsaveChanges])

	const onConfirmDialogResult = useCallback(
		(confirm: boolean) => {
			if (confirm) {
				// Discard changes: Reset state and flag
				setCachedState(extensionState) // Revert to original state
				editedAppearance.current.clear()
				setChangeDetected(false) // Reset change flag
				confirmDialogHandler.current?.() // Execute the pending action (e.g., tab switch)
			}
			// If confirm is false (Cancel), do nothing, dialog closes automatically
		},
		[extensionState], // Depend on extensionState to get the latest original state
	)

	// Handle tab changes with unsaved changes check
	const handleTabChange = useCallback(
		(newTab: SectionName) => {
			if (contentRef.current) {
				scrollPositions.current[activeTab] = contentRef.current.scrollTop
			}
			setActiveTab(newTab)
		},
		[activeTab],
	)

	useLayoutEffect(() => {
		if (contentRef.current) {
			contentRef.current.scrollTop = scrollPositions.current[activeTab] ?? 0
		}
	}, [activeTab])

	// Store direct DOM element refs for each tab
	const tabRefs = useRef<Record<SectionName, HTMLButtonElement | null>>(
		Object.fromEntries(sectionNames.map((name) => [name, null])) as Record<SectionName, HTMLButtonElement | null>,
	)

	// Track whether we're in compact mode
	const [isCompactMode, setIsCompactMode] = useState(false)
	const containerRef = useRef<HTMLDivElement>(null)

	// Setup resize observer to detect when we should switch to compact mode
	useEffect(() => {
		if (!containerRef.current) return

		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) {
				// If container width is less than 500px, switch to compact mode
				setIsCompactMode(entry.contentRect.width < 500)
			}
		})

		observer.observe(containerRef.current)

		return () => {
			observer?.disconnect()
		}
	}, [])

	const sections: { id: SectionName; icon: LucideIcon }[] = useMemo(
		() => [
			{ id: "providers", icon: Plug },
			{ id: "modes", icon: UsersRound },
			{ id: "skills", icon: GraduationCap },
			{ id: "slashCommands", icon: SquareSlash },
			{ id: "rules", icon: ScrollText },
			{ id: "autoApprove", icon: CheckCheck },
			{ id: "mcp", icon: Server },
			{ id: "checkpoints", icon: GitCommitVertical },
			{ id: "notifications", icon: Bell },
			{ id: "contextManagement", icon: Database },
			{ id: "terminal", icon: SquareTerminal },
			{ id: "prompts", icon: MessageSquare },
			{ id: "worktrees", icon: GitBranch },
			{ id: "ui", icon: Glasses },
			{ id: "experimental", icon: FlaskConical },
			{ id: "language", icon: Globe },
			{ id: "about", icon: Info },
		],
		[], // No dependencies needed now
	)

	// Update target section logic to set active tab
	useEffect(() => {
		if (targetSection && sectionNames.includes(targetSection as SectionName)) {
			setActiveTab(targetSection as SectionName)
		}
	}, [targetSection])

	// Function to scroll the active tab into view for vertical layout
	const scrollToActiveTab = useCallback(() => {
		const activeTabElement = tabRefs.current[activeTab]

		if (activeTabElement) {
			activeTabElement.scrollIntoView({
				behavior: "auto",
				block: "nearest",
			})
		}
	}, [activeTab])

	// Effect to scroll when the active tab changes
	useEffect(() => {
		scrollToActiveTab()
	}, [activeTab, scrollToActiveTab])

	// Effect to scroll when the webview becomes visible
	useLayoutEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const message = event.data
			if (message.type === "action" && message.action === "didBecomeVisible") {
				scrollToActiveTab()
			}
		}

		window.addEventListener("message", handleMessage)

		return () => {
			window.removeEventListener("message", handleMessage)
		}
	}, [scrollToActiveTab])

	// Search index registry - settings register themselves on mount
	const getSectionLabel = useCallback((section: SectionName) => t(`settings:sections.${section}`), [t])
	const { contextValue: searchContextValue, index: searchIndex } = useSearchIndexRegistry(getSectionLabel)

	// Track which tabs have been indexed (visited at least once)
	const [indexingTabIndex, setIndexingTabIndex] = useState(0)
	const initialTab = useRef<SectionName>(activeTab)
	const isIndexing = indexingTabIndex < sectionNames.length
	const isIndexingComplete = !isIndexing
	const tabTitlesRegistered = useRef(false)

	// Index all tabs by cycling through them on mount
	useLayoutEffect(() => {
		if (indexingTabIndex >= sectionNames.length) {
			// All tabs indexed, now register tab titles as searchable items
			if (!tabTitlesRegistered.current && searchContextValue) {
				sections.forEach(({ id }) => {
					const tabTitle = t(`settings:sections.${id}`)
					// Register each tab title as a searchable item
					// Using a special naming convention for tab titles: "tab-{sectionName}"
					searchContextValue.registerSetting({
						settingId: `tab-${id}`,
						section: id,
						label: tabTitle,
					})
				})
				tabTitlesRegistered.current = true
				// Return to initial tab
				setActiveTab(initialTab.current)
			}
			return
		}

		// Move to the next tab on next render
		setIndexingTabIndex((prev) => prev + 1)
	}, [indexingTabIndex, searchContextValue, sections, t])

	// Determine which tab content to render (for indexing or active display)
	const renderTab = isIndexing ? sectionNames[indexingTabIndex] : activeTab

	// Handle search navigation - switch to the correct tab and scroll to the element
	const handleSearchNavigate = useCallback(
		(section: SectionName, settingId: string) => {
			// Switch to the correct tab
			handleTabChange(section)

			// Wait for the tab to render, then find element by settingId and scroll to it
			requestAnimationFrame(() => {
				setTimeout(() => {
					const element = document.querySelector(`[data-setting-id="${settingId}"]`)
					if (element) {
						element.scrollIntoView({ behavior: "smooth", block: "center" })

						// Add highlight animation
						element.classList.add("settings-highlight")
						setTimeout(() => {
							element.classList.remove("settings-highlight")
						}, 1500)
					}
				}, 100) // Small delay to ensure tab content is rendered
			})
		},
		[handleTabChange],
	)

	return (
		<Tab>
			<TabHeader className="flex justify-between items-center gap-2">
				<div className="flex items-center gap-2 grow">
					<StandardTooltip content={t("settings:header.doneButtonTooltip")}>
						<Button
							variant="ghost"
							className="px-1.5 -ml-2"
							disabled={!!pendingSaveId}
							onClick={() => checkUnsaveChanges(onDone)}>
							<ArrowLeft />
							<span className="sr-only">{t("settings:common.done")}</span>
						</Button>
					</StandardTooltip>
					<h3 className="text-vscode-foreground m-0 flex-shrink-0">{t("settings:header.title")}</h3>
				</div>
				<div className="flex items-center gap-2 shrink-0">
					{isIndexingComplete && (
						<SettingsSearch index={searchIndex} onNavigate={handleSearchNavigate} sections={sections} />
					)}
					<StandardTooltip
						content={
							!isSettingValid
								? errorMessage
								: isChangeDetected
									? t("settings:header.saveButtonTooltip")
									: t("settings:header.nothingChangedTooltip")
						}>
						<Button
							variant={isSettingValid ? "primary" : "secondary"}
							className={!isSettingValid ? "!border-vscode-errorForeground" : ""}
							onClick={handleSubmit}
							disabled={!isChangeDetected || !isSettingValid || !!pendingSaveId}
							data-testid="save-button">
							{t("settings:common.save")}
						</Button>
					</StandardTooltip>
				</div>
			</TabHeader>

			{/* Vertical tabs layout */}
			<div ref={containerRef} className={cn(settingsTabsContainer, isCompactMode && "narrow")}>
				{/* Tab sidebar */}
				<TabList
					value={activeTab}
					onValueChange={(value) => handleTabChange(value as SectionName)}
					className={cn(settingsTabList)}
					data-compact={isCompactMode}
					data-testid="settings-tab-list">
					{sections.map(({ id, icon: Icon }) => {
						const isSelected = id === activeTab
						const onSelect = () => handleTabChange(id)

						// Base TabTrigger component definition
						// We pass isSelected manually for styling, but onSelect is handled conditionally
						const triggerComponent = (
							<TabTrigger
								ref={(element) => (tabRefs.current[id] = element)}
								value={id}
								isSelected={isSelected} // Pass manually for styling state
								className={cn(
									isSelected // Use manual isSelected for styling
										? `${settingsTabTrigger} ${settingsTabTriggerActive}`
										: settingsTabTrigger,
									"cursor-pointer focus:ring-0", // Remove the focus ring styling
								)}
								data-testid={`tab-${id}`}
								data-compact={isCompactMode}>
								<div className={cn("flex items-center gap-2", isCompactMode && "justify-center")}>
									<Icon className="w-4 h-4" />
									<span className="tab-label">{t(`settings:sections.${id}`)}</span>
								</div>
							</TabTrigger>
						)

						if (isCompactMode) {
							// Wrap in Tooltip and manually add onClick to the trigger
							return (
								<TooltipProvider key={id} delayDuration={300}>
									<Tooltip>
										<TooltipTrigger asChild onClick={onSelect}>
											{/* Clone to avoid ref issues if triggerComponent itself had a key */}
											{React.cloneElement(triggerComponent)}
										</TooltipTrigger>
										<TooltipContent side="right" className="text-base">
											<p className="m-0">{t(`settings:sections.${id}`)}</p>
										</TooltipContent>
									</Tooltip>
								</TooltipProvider>
							)
						} else {
							// Render trigger directly; TabList will inject onSelect via cloning
							// Ensure the element passed to TabList has the key
							return React.cloneElement(triggerComponent, { key: id })
						}
					})}
				</TabList>

				{/* Content area - renders only the active tab (or indexing tab during initial indexing) */}
				<TabContent
					ref={contentRef}
					className={cn("p-0 flex-1 overflow-auto", isIndexing && "opacity-0")}
					data-testid="settings-content">
					<SearchIndexProvider value={searchContextValue}>
						{/* Providers Section */}
						{renderTab === "providers" && (
							<div>
								<SectionHeader>{t("settings:sections.providers")}</SectionHeader>

								<Section>
									<ApiConfigManager
										currentApiConfigName={currentApiConfigName}
										listApiConfigMeta={listApiConfigMeta}
										onSelectConfig={(configName: string) =>
											checkUnsaveChanges(() =>
												vscode.postMessage({ type: "loadApiConfiguration", text: configName }),
											)
										}
										onDeleteConfig={(configName: string) =>
											vscode.postMessage({ type: "deleteApiConfiguration", text: configName })
										}
										onRenameConfig={(oldName: string, newName: string) => {
											vscode.postMessage({
												type: "renameApiConfiguration",
												values: { oldName, newName },
												apiConfiguration,
											})
											prevApiConfigName.current = newName
										}}
										onUpsertConfig={(configName: string) =>
											vscode.postMessage({
												type: "upsertApiConfiguration",
												text: configName,
												apiConfiguration,
											})
										}
									/>
									<ApiOptions
										uriScheme={uriScheme}
										apiConfiguration={apiConfiguration}
										setApiConfigurationField={setApiConfigurationField}
										errorMessage={errorMessage}
										setErrorMessage={setErrorMessage}
									/>
								</Section>
							</div>
						)}

						{/* Auto-Approve Section */}
						{renderTab === "autoApprove" && (
							<AutoApproveSettings
								alwaysAllowReadOnly={alwaysAllowReadOnly}
								alwaysAllowReadOnlyOutsideWorkspace={alwaysAllowReadOnlyOutsideWorkspace}
								allowedReadFiles={allowedReadFiles}
								alwaysAllowWrite={alwaysAllowWrite}
								alwaysAllowWriteOutsideWorkspace={alwaysAllowWriteOutsideWorkspace}
								alwaysAllowWriteProtected={alwaysAllowWriteProtected}
								allowedWriteFiles={allowedWriteFiles}
								alwaysAllowMcp={alwaysAllowMcp}
								alwaysAllowModeSwitch={alwaysAllowModeSwitch}
								alwaysAllowSubtasks={alwaysAllowSubtasks}
								alwaysAllowExecute={alwaysAllowExecute}
								destructiveCommandGuardEnabled={destructiveCommandGuardEnabled}
								alwaysDenyUnapprovedCommands={alwaysDenyUnapprovedCommands}
								alwaysAllowFollowupQuestions={alwaysAllowFollowupQuestions}
								followupAutoApproveTimeoutMs={followupAutoApproveTimeoutMs}
								allowedCommands={allowedCommands}
								allowedMaxRequests={allowedMaxRequests ?? undefined}
								allowedMaxCost={allowedMaxCost ?? undefined}
								deniedCommands={deniedCommands}
								setCachedStateField={setCachedStateField}
							/>
						)}

						{/* Slash Commands Section */}
						{renderTab === "slashCommands" && <SlashCommandsSettings />}

						{/* Skills Section */}
						{renderTab === "skills" && <SkillsSettings />}

						{/* Rules Section */}
						{renderTab === "rules" && <RulesSettings />}

						{/* Checkpoints Section */}
						{renderTab === "checkpoints" && (
							<CheckpointSettings
								enableCheckpoints={enableCheckpoints}
								checkpointTimeout={checkpointTimeout}
								setCachedStateField={setCachedStateField}
							/>
						)}

						{/* Notifications Section */}
						{renderTab === "notifications" && (
							<NotificationSettings
								ttsEnabled={ttsEnabled}
								ttsSpeed={ttsSpeed}
								soundEnabled={soundEnabled}
								soundVolume={soundVolume}
								setCachedStateField={setCachedStateField}
							/>
						)}

						{/* Context Management Section */}
						{renderTab === "contextManagement" && (
							<ContextManagementSettings
								autoCondenseContext={autoCondenseContext}
								autoCondenseContextPercent={autoCondenseContextPercent}
								listApiConfigMeta={listApiConfigMeta ?? []}
								maxOpenTabsContext={maxOpenTabsContext}
								maxWorkspaceFiles={maxWorkspaceFiles ?? 200}
								showRooIgnoredFiles={showRooIgnoredFiles}
								enableSubfolderRules={enableSubfolderRules}
								maxImageFileSize={maxImageFileSize}
								maxTotalImageSize={maxTotalImageSize}
								profileThresholds={profileThresholds}
								includeDiagnosticMessages={includeDiagnosticMessages}
								maxDiagnosticMessages={maxDiagnosticMessages}
								writeDelayMs={writeDelayMs}
								diffFuzzyThreshold={diffFuzzyThreshold}
								includeCurrentTime={includeCurrentTime}
								includeCurrentCost={includeCurrentCost}
								maxGitStatusFiles={maxGitStatusFiles}
								customSupportPrompts={customSupportPrompts || {}}
								setCustomSupportPrompts={setCustomSupportPromptsField}
								setCachedStateField={setCachedStateField}
							/>
						)}

						{/* Terminal Section */}
						{renderTab === "terminal" && (
							<TerminalSettings
								terminalOutputPreviewSize={terminalOutputPreviewSize}
								terminalShellIntegrationTimeout={terminalShellIntegrationTimeout}
								terminalShellIntegrationDisabled={terminalShellIntegrationDisabled}
								collapseCommandOutputByDefault={collapseCommandOutputByDefault}
								terminalCommandDelay={terminalCommandDelay}
								terminalPowershellCounter={terminalPowershellCounter}
								terminalZshClearEolMark={terminalZshClearEolMark}
								terminalZshOhMy={terminalZshOhMy}
								terminalZshP10k={terminalZshP10k}
								terminalZdotdir={terminalZdotdir}
								terminalProfile={terminalProfile}
								onTerminalProfilePickerOpened={() => setChangeDetected(true)}
								setCachedStateField={setCachedStateField}
							/>
						)}

						{/* Modes Section */}
						{renderTab === "modes" && <ModesView />}

						{/* MCP Section */}
						{renderTab === "mcp" && (
							<McpView
								mcpEnabled={mcpEnabled}
								setMcpEnabled={(value) => setCachedStateField("mcpEnabled", value)}
							/>
						)}

						{/* Worktrees Section */}
						{renderTab === "worktrees" && <WorktreesView />}

						{/* Prompts Section */}
						{renderTab === "prompts" && (
							<PromptsSettings
								customSupportPrompts={customSupportPrompts || {}}
								setCustomSupportPrompts={setCustomSupportPromptsField}
								includeTaskHistoryInEnhance={includeTaskHistoryInEnhance}
								setIncludeTaskHistoryInEnhance={(value) =>
									setCachedStateField("includeTaskHistoryInEnhance", value)
								}
							/>
						)}

						{/* UI Section */}
						{renderTab === "ui" && (
							<UISettings
								reasoningBlockCollapsed={reasoningBlockCollapsed ?? true}
								enterBehavior={enterBehavior ?? "send"}
								chatFontSize={chatFontSize ?? undefined}
								interfaceFontScale={interfaceFontScale ?? undefined}
								terminalFontSize={terminalFontSize ?? undefined}
								editorFontSize={editorFontSize ?? undefined}
								spacingScale={spacingScale ?? undefined}
								autoCloseZooOpenedFiles={autoCloseZooOpenedFiles}
								autoCloseZooOpenedFilesAfterUserEdited={autoCloseZooOpenedFilesAfterUserEdited}
								autoCloseZooOpenedNewFiles={autoCloseZooOpenedNewFiles}
								setCachedStateField={setCachedStateField}
							/>
						)}

						{/* Experimental Section */}
						{renderTab === "experimental" && (
							<ExperimentalSettings
								setExperimentEnabled={setExperimentEnabled}
								experiments={experiments}
								apiConfiguration={apiConfiguration}
								setApiConfigurationField={setApiConfigurationField}
								imageGenerationProvider={imageGenerationProvider}
								openRouterImageApiKey={openRouterImageApiKey as string | undefined}
								openRouterImageGenerationSelectedModel={
									openRouterImageGenerationSelectedModel as string | undefined
								}
								setImageGenerationProvider={setImageGenerationProvider}
								setOpenRouterImageApiKey={setOpenRouterImageApiKey}
								setImageGenerationSelectedModel={setImageGenerationSelectedModel}
							/>
						)}

						{/* Language Section */}
						{renderTab === "language" && (
							<LanguageSettings
								language={language || "en"}
								timeFormat={timeFormat}
								dateFormat={dateFormat}
								showRelativeTimes={showRelativeTimes}
								setCachedStateField={setCachedStateField}
							/>
						)}

						{/* About Section */}
						{renderTab === "about" && (
							<About
								telemetrySetting={telemetrySetting}
								setTelemetrySetting={setTelemetrySetting}
								debug={cachedState.debug}
								setDebug={setDebug}
							/>
						)}
					</SearchIndexProvider>
				</TabContent>
			</div>

			<UnsavedChangesDialog
				open={isDiscardDialogShow}
				onOpenChange={setDiscardDialogShow}
				saveOutcomeUnknown={saveOutcomeUnknown}
				onCancel={() => onConfirmDialogResult(false)}
				onDiscard={() => onConfirmDialogResult(true)}
			/>
		</Tab>
	)
})

export default SettingsView
