import React, {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react"
import {
	CheckCheck,
	GitBranch,
	Bell,
	Database,
	SquareTerminal,
	FlaskConical,
	TriangleAlert,
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
	DEFAULT_TASK_TITLE_GENERATION_ENABLED,
	ImageGenerationProvider,
} from "@roo-code/types"

import { vscode } from "@src/utils/vscode"
import { cn } from "@src/lib/utils"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { ExtensionStateContextType, useExtensionState } from "@src/context/ExtensionStateContext"
import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogTitle,
	AlertDialogDescription,
	AlertDialogCancel,
	AlertDialogAction,
	AlertDialogHeader,
	AlertDialogFooter,
	Button,
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
	StandardTooltip,
} from "@src/components/ui"

import { Tab, TabContent, TabHeader, TabList, TabTrigger } from "../common/Tab"
import { SetCachedStateField, SetExperimentEnabled } from "./types"
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
import ModesView from "../modes/ModesView"
import McpView from "../mcp/McpView"
import { WorktreesView } from "../worktrees/WorktreesView"
import { SettingsSearch } from "./SettingsSearch"
import { useSearchIndexRegistry, SearchIndexProvider } from "./useSettingsSearch"
import { nextSaveRequestId } from "./saveRequestId"

/**
 * How long the form waits for the host to answer a save that changes a time or date setting. The host always answers
 * (success or failure), but a write that never settles would otherwise leave Save disabled until the webview reloads.
 * After this the save is treated as failed: the edits stay unsaved and Save works again.
 */
export const SAVE_ANSWER_TIMEOUT_MS = 20_000

export const settingsTabsContainer = "flex flex-1 overflow-hidden [&.narrow_.tab-label]:hidden"
export const settingsTabList =
	"w-48 data-[compact=true]:w-12 flex-shrink-0 flex flex-col overflow-y-auto overflow-x-hidden border-r border-vscode-sideBar-background"
export const settingsTabTrigger =
	"whitespace-nowrap overflow-hidden min-w-0 h-12 px-4 py-3 box-border flex items-center border-l-2 border-transparent text-vscode-foreground opacity-70 hover:bg-vscode-list-hoverBackground data-[compact=true]:w-12 data-[compact=true]:p-4"
export const settingsTabTriggerActive = "opacity-100 border-vscode-focusBorder bg-vscode-list-activeSelectionBackground"

// Command-list snapshot of a settings state object. Entries are compared by value because every
// state post delivers freshly deserialized arrays; reference identity carries no meaning here.
interface CommandListSnapshot {
	allowedCommands?: string[]
	deniedCommands?: string[]
	workspaceCommandListsEnabled?: boolean
}

const commandListSnapshot = (state: CommandListSnapshot): string =>
	JSON.stringify([
		state.allowedCommands ?? [],
		state.deniedCommands ?? [],
		state.workspaceCommandListsEnabled ?? false,
	])

const commandListsEquivalent = (left?: string[], right?: string[]) =>
	left === right ||
	(!!left && !!right && left.length === right.length && left.every((entry, index) => entry === right[index]))

export interface SettingsViewRef {
	checkUnsaveChanges: (then: () => void) => void
}

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
	const { currentApiConfigName, listApiConfigMeta, uriScheme, settingsImportedAt, mode } = extensionState

	const [isDiscardDialogShow, setDiscardDialogShow] = useState(false)
	const [isChangeDetected, setChangeDetected] = useState(false)
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
	// The save waiting for the host's answer, and the form state it sent. The "unsaved changes" flag stays on until the
	// host says it was stored, and then goes off only if the user has not edited anything since.
	const [pendingSaveId, setPendingSaveId] = useState<string | undefined>(undefined)
	const sentState = useRef<typeof extensionState | undefined>(undefined)
	const latestCachedState = useRef(cachedState)
	latestCachedState.current = cachedState
	// The live host state, read when a save settles without re-subscribing the result handler on every post.
	const latestExtensionState = useRef(extensionState)
	latestExtensionState.current = extensionState
	// The save the host must answer records the baseline it stamped and the lists it submitted, so the
	// save-result effect can reconcile each list's baseline against that list's own write outcome.
	const submittedListSave = useRef<{ baselined: [string[], string[]]; sent: [string[], string[]] } | undefined>(
		undefined,
	)

	// Command-list values the dialog last displayed, so a later state post can be recognized as
	// an external change rather than a restatement of what is already shown.
	const lastDisplayedCommandSnapshot = useRef(commandListSnapshot(extensionState))
	// An in-flight user edit of either list claims ownership of the lists until Save, discard, or
	// a full reseed; external list updates must not silently overwrite it.
	const commandListsTouched = useRef(false)

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
		taskTitleGenerationEnabled,
		taskTitleApiConfigId,
		imageGenerationProvider,
		openRouterImageApiKey,
		openRouterImageGenerationSelectedModel,
		reasoningBlockCollapsed,
		chatFontSize,
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
		lastDisplayedCommandSnapshot.current = commandListSnapshot(extensionState)
		commandListsTouched.current = false
		setChangeDetected(false)
	}, [currentApiConfigName, mode, extensionState])

	// Bust the cache when settings are imported.
	useEffect(() => {
		if (!settingsImportedAt || handledSettingsImportedAt.current === settingsImportedAt) {
			return
		}

		handledSettingsImportedAt.current = settingsImportedAt
		setCachedState((prevCachedState) => ({ ...prevCachedState, ...extensionState }))
		lastDisplayedCommandSnapshot.current = commandListSnapshot(extensionState)
		commandListsTouched.current = false
		setChangeDetected(false)
	}, [settingsImportedAt, extensionState])

	// The command lists can change in the extension host while this dialog is open (for example,
	// a settings-file edit landing mid-session). Fold exactly those fields into the edit buffer on
	// every state post that changes them, so a later Save cannot rewrite the configuration layer
	// from a list that never showed the new entry. List fields are held back while the user has an
	// in-flight list edit (in-flight edits win); every other buffered field is left untouched and
	// the dirty flag is never cleared here, keeping the buffer's Save-gated semantics.
	useEffect(() => {
		const snapshot = commandListSnapshot(extensionState)
		if (snapshot === lastDisplayedCommandSnapshot.current) {
			return
		}

		setCachedState((prevState) => {
			const merged: CommandListSnapshot = {}
			let changedFields = 0

			if (!commandListsTouched.current) {
				if (!commandListsEquivalent(prevState.allowedCommands, extensionState.allowedCommands)) {
					merged.allowedCommands = extensionState.allowedCommands
					changedFields++
				}
				if (!commandListsEquivalent(prevState.deniedCommands, extensionState.deniedCommands)) {
					merged.deniedCommands = extensionState.deniedCommands
					changedFields++
				}
			}
			if (prevState.workspaceCommandListsEnabled !== extensionState.workspaceCommandListsEnabled) {
				merged.workspaceCommandListsEnabled = extensionState.workspaceCommandListsEnabled
				changedFields++
			}

			// The stamp records the lists this merge leaves on screen, never the posted
			// state outright: an entry held back by an in-flight edit was never displayed,
			// and a baseline claiming it had been lets the save erase it as a user
			// deletion without warning. While the lists are held back the buffered lists
			// are themselves unposted, so the stamp keeps its prior lists instead - a
			// deletion inside the buffered edit must stay in the baseline for the save to
			// apply it rather than resurrect the deleted entry as an external addition.
			// The gate slot holds back with those lists because the stamp has to describe
			// one displayed state: pairing held-back lists with an externally-flipped gate
			// would claim the held-back entries were displayed under a gate they never
			// appeared alongside.
			const [stampAllowed, stampDenied, stampGate] = commandListsTouched.current
				? (JSON.parse(lastDisplayedCommandSnapshot.current) as [string[], string[], boolean])
				: [
						merged.allowedCommands ?? prevState.allowedCommands,
						merged.deniedCommands ?? prevState.deniedCommands,
						merged.workspaceCommandListsEnabled ?? prevState.workspaceCommandListsEnabled,
					]
			lastDisplayedCommandSnapshot.current = commandListSnapshot({
				allowedCommands: stampAllowed,
				deniedCommands: stampDenied,
				workspaceCommandListsEnabled: stampGate,
			})

			if (changedFields === 0) {
				return prevState
			}
			return { ...prevState, ...merged }
		})
	}, [extensionState])

	const setCachedStateField: SetCachedStateField<keyof ExtensionStateContextType> = useCallback((field, value) => {
		setCachedState((prevState) => {
			if (prevState[field] === value) {
				return prevState
			}

			if (field === "allowedCommands" || field === "deniedCommands") {
				commandListsTouched.current = true
			}

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

	// The time and date values are written one at a time on the host, and a write can fail: a save that changes one of
	// them waits for the host's answer. Every other save behaves as it always did.
	const displayChanged =
		(cachedState.timeFormat ?? "auto") !== (extensionState.timeFormat ?? "auto") ||
		(cachedState.dateFormat ?? "auto") !== (extensionState.dateFormat ?? "auto") ||
		(cachedState.showRelativeTimes ?? true) !== (extensionState.showRelativeTimes ?? true)

	const handleSubmit = () => {
		if (isSettingValid) {
			const [lastDisplayedAllowed, lastDisplayedDenied, gateAtSubmit] = JSON.parse(
				lastDisplayedCommandSnapshot.current,
			) as [string[], string[], boolean]

			const saveId = displayChanged ? nextSaveRequestId() : undefined
			if (saveId) {
				sentState.current = cachedState
				submittedListSave.current = {
					baselined: [lastDisplayedAllowed, lastDisplayedDenied],
					sent: [allowedCommands ?? [], deniedCommands ?? []],
				}
				setPendingSaveId(saveId)
			}

			vscode.postMessage({
				type: "updateSettings",
				requestId: saveId,
				commandListBaseline: {
					allowedCommands: lastDisplayedAllowed,
					deniedCommands: lastDisplayedDenied,
					// The gate travels with the lists it was displayed alongside: the stamp
					// always carries the gate that was on screen with its lists, so a gate
					// flip between display and save cannot pair old-gate entries with a
					// new-gate label and reclassify a baseline-shown entry as a brand-new
					// promotion into the global layer. A dialog whose host never delivered
					// the gate has no displayed gate to accompany the baseline: it posts
					// none, and the save path keeps the legacy classification for an
					// absent flag.
					workspaceCommandListsEnabled:
						cachedState.workspaceCommandListsEnabled === undefined ? undefined : gateAtSubmit,
				},
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
					taskTitleGenerationEnabled: taskTitleGenerationEnabled ?? DEFAULT_TASK_TITLE_GENERATION_ENABLED,
					taskTitleApiConfigId: taskTitleApiConfigId ?? "",
					reasoningBlockCollapsed: reasoningBlockCollapsed ?? true,
					chatFontSize: chatFontSize ?? null,
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

			lastDisplayedCommandSnapshot.current = commandListSnapshot({
				allowedCommands,
				deniedCommands,
				workspaceCommandListsEnabled: gateAtSubmit,
			})
			// The stamp records what is on screen, so it moves at submit; the settle below then re-derives each
			// edited list's entry from whether that list's own write landed. The lists' ownership of the buffer
			// does not move at submit. A save releases that hold - and with it the unsaved flag - only once the
			// refresh shows every submitted write landed: releasing earlier would let the state refresh that
			// follows a rejected list write overwrite the edit the user is still looking at. A save the host never
			// answers has no result to wait for, so it clears the hold at submit.
			if (!saveId) {
				commandListsTouched.current = false
				setChangeDetected(false)
			}
		}
	}

	useEffect(() => {
		if (!pendingSaveId) return

		const settle = (success: boolean) => {
			setPendingSaveId(undefined)
			// The answer's flag reports one outcome for the whole payload, but the payload's lists are written
			// separately, and a report of success says only that the other settings stored: a rejected
			// command-list write is absent from the flag. Each edited list's own write result comes from the
			// refresh the host posts before its answer, so every save reconciles each list against what was
			// submitted: a list equal to what was submitted records that its own write landed, and its baseline
			// stays advanced, since restoring the pre-submit baseline of a written list claims an entry the file
			// no longer holds was displayed. Every other edited list's baseline rolls back to what was displayed
			// before the submit, so a deletion whose write never ran is still classified as a user deletion on
			// retry instead of an external addition to re-admit. Lists the save did not edit keep the stamp's
			// baseline, which the external-update merge already maintains.
			const save = submittedListSave.current
			submittedListSave.current = undefined
			let everyEditedWriteLanded = true
			if (save) {
				const [stampAllowed, stampDenied, stampGate] = JSON.parse(lastDisplayedCommandSnapshot.current) as [
					string[],
					string[],
					boolean,
				]
				const reconcileList = (
					baselined: string[],
					sent: string[],
					refreshed: string[] | undefined,
					stamped: string[],
				) =>
					commandListsEquivalent(baselined, sent)
						? stamped
						: commandListsEquivalent(refreshed, sent)
							? sent
							: baselined
				const writeLanded = (baselined: string[], sent: string[], refreshed: string[] | undefined) =>
					commandListsEquivalent(baselined, sent) || commandListsEquivalent(refreshed, sent)
				everyEditedWriteLanded =
					writeLanded(save.baselined[0], save.sent[0], latestExtensionState.current.allowedCommands) &&
					writeLanded(save.baselined[1], save.sent[1], latestExtensionState.current.deniedCommands)
				lastDisplayedCommandSnapshot.current = commandListSnapshot({
					allowedCommands: reconcileList(
						save.baselined[0],
						save.sent[0],
						latestExtensionState.current.allowedCommands,
						stampAllowed,
					),
					deniedCommands: reconcileList(
						save.baselined[1],
						save.sent[1],
						latestExtensionState.current.deniedCommands,
						stampDenied,
					),
					workspaceCommandListsEnabled: stampGate,
				})
			}
			// The unsaved flag goes off only when nothing is left unsaved: an edit made while the save was in
			// flight is not in what was sent, and an edited list whose write never landed still holds its edit.
			// In both cases the buffered lists keep holding off external updates, so a host refresh cannot
			// replace the edit the user is looking at.
			if (success && everyEditedWriteLanded && latestCachedState.current === sentState.current) {
				commandListsTouched.current = false
				setChangeDetected(false)
			}
		}

		const onResult = (event: MessageEvent) => {
			const message = event.data
			if (message?.type !== "settingsSaveResult" || message.requestId !== pendingSaveId) return
			settle(message.success === true)
		}

		window.addEventListener("message", onResult)
		const timer = setTimeout(() => settle(false), SAVE_ANSWER_TIMEOUT_MS)
		return () => {
			clearTimeout(timer)
			window.removeEventListener("message", onResult)
		}
	}, [pendingSaveId])

	const checkUnsaveChanges = useCallback(
		(then: () => void) => {
			if (isChangeDetected) {
				confirmDialogHandler.current = then
				setDiscardDialogShow(true)
			} else {
				then()
			}
		},
		[isChangeDetected],
	)

	useImperativeHandle(ref, () => ({ checkUnsaveChanges }), [checkUnsaveChanges])

	const onConfirmDialogResult = useCallback(
		(confirm: boolean) => {
			if (confirm) {
				// Discard changes: Reset state and flag
				setCachedState(extensionState) // Revert to original state
				lastDisplayedCommandSnapshot.current = commandListSnapshot(extensionState)
				commandListsTouched.current = false // Buffered edits are gone, so live lists are not held off
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
						<Button variant="ghost" className="px-1.5 -ml-2" onClick={() => checkUnsaveChanges(onDone)}>
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
								taskTitleGenerationEnabled={
									taskTitleGenerationEnabled ?? DEFAULT_TASK_TITLE_GENERATION_ENABLED
								}
								setTaskTitleGenerationEnabled={(value) =>
									setCachedStateField("taskTitleGenerationEnabled", value)
								}
								taskTitleApiConfigId={taskTitleApiConfigId}
								setTaskTitleApiConfigId={(value) => setCachedStateField("taskTitleApiConfigId", value)}
							/>
						)}

						{/* UI Section */}
						{renderTab === "ui" && (
							<UISettings
								reasoningBlockCollapsed={reasoningBlockCollapsed ?? true}
								enterBehavior={enterBehavior ?? "send"}
								chatFontSize={chatFontSize ?? undefined}
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

			<AlertDialog open={isDiscardDialogShow} onOpenChange={setDiscardDialogShow}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<TriangleAlert className="w-5 h-5 text-yellow-500" />
							{t("settings:unsavedChangesDialog.title")}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{t("settings:unsavedChangesDialog.description")}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel onClick={() => onConfirmDialogResult(false)}>
							{t("settings:unsavedChangesDialog.cancelButton")}
						</AlertDialogCancel>
						<AlertDialogAction onClick={() => onConfirmDialogResult(true)}>
							{t("settings:unsavedChangesDialog.discardButton")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</Tab>
	)
})

export default SettingsView
