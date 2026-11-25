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
 * How long the form waits for the host to answer a watched save. A write that
 * never settles would otherwise leave Save disabled until reload. After this,
 * treat the save as failed: edits stay unsaved, Save works again.
 */
export const SAVE_ANSWER_TIMEOUT_MS = 20_000

export const settingsTabsContainer = "flex flex-1 overflow-hidden [&.narrow_.tab-label]:hidden"
export const settingsTabList =
	"w-48 data-[compact=true]:w-12 flex-shrink-0 flex flex-col overflow-y-auto overflow-x-hidden border-r border-vscode-sideBar-background"
export const settingsTabTrigger =
	"whitespace-nowrap overflow-hidden min-w-0 h-12 px-4 py-3 box-border flex items-center border-l-2 border-transparent text-vscode-foreground opacity-70 hover:bg-vscode-list-hoverBackground data-[compact=true]:w-12 data-[compact=true]:p-4"
export const settingsTabTriggerActive = "opacity-100 border-vscode-focusBorder bg-vscode-list-activeSelectionBackground"

// Snapshot of the command lists in a state object. Compare entries by value:
// each state post delivers freshly deserialized arrays.
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
	// The save waiting for the host's answer. The "unsaved changes" flag stays on until the
	// host says it was stored, and then goes off only if the user has not edited anything since.
	const [pendingSaveId, setPendingSaveId] = useState<string | undefined>(undefined)
	// Raised by every user edit to a cached field and lowered at each save dispatch. The
	// settle reads it instead of comparing the buffer's identity, because the host's own
	// refresh replaces the buffer as well, and an identity check cannot tell the two apart.
	// It is deliberately not cleared when a save settles or times out: the settle has
	// already read it, and the next dispatch resets it. `commandListsTouched` has the other
	// lifetime - it is cleared only on a clean settle - so the two flags reset at different
	// points by design.
	const userEditedDuringSave = useRef(false)
	const latestCachedState = useRef(cachedState)
	latestCachedState.current = cachedState
	// The live host state, read when a save settles.
	const latestExtensionState = useRef(extensionState)
	// Refresh synchronously at commit. The save answer can follow its state post
	// immediately, so it must see that post, not the state before it.
	useLayoutEffect(() => {
		latestExtensionState.current = extensionState
	}, [extensionState])
	// Records the baseline and the lists of the save the host must answer. The
	// save-result effect reconciles each list against its own write outcome.
	const submittedListSave = useRef<{ baselined: [string[], string[]]; sent: [string[], string[]] } | undefined>(
		undefined,
	)

	// What the dialog last displayed, so a later post counts as an external
	// change, not a repeat.
	const lastDisplayedCommandSnapshot = useRef(commandListSnapshot(extensionState))
	// An in-flight list edit holds the lists until Save, discard, or reseed.
	// External updates must not overwrite it.
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

	// The host can change the command lists while this dialog is open. Fold the
	// changed list fields into the edit buffer on every state post, so a later
	// Save cannot rewrite the file from a list that never showed the new entry.
	// An in-flight list edit holds the list fields back. Other fields are
	// untouched, and this effect never clears the dirty flag.
	useEffect(() => {
		const snapshot = commandListSnapshot(extensionState)
		if (snapshot === lastDisplayedCommandSnapshot.current) {
			return
		}

		// Compute the merge here, outside the state update, because a state update
		// must stay a pure function of the state it applies to.
		const prevState = latestCachedState.current
		const merged: CommandListSnapshot = {}

		if (!commandListsTouched.current) {
			if (!commandListsEquivalent(prevState.allowedCommands, extensionState.allowedCommands)) {
				merged.allowedCommands = extensionState.allowedCommands
			}
			if (!commandListsEquivalent(prevState.deniedCommands, extensionState.deniedCommands)) {
				merged.deniedCommands = extensionState.deniedCommands
			}
		}
		if (prevState.workspaceCommandListsEnabled !== extensionState.workspaceCommandListsEnabled) {
			merged.workspaceCommandListsEnabled = extensionState.workspaceCommandListsEnabled
		}

		// The stamp records what this merge leaves on screen, never the posted state.
		// A held-back entry was never displayed. Claiming it had been lets the save
		// erase it as a user deletion. While the lists are held back, keep the prior
		// lists. A deletion inside the buffered edit must stay in the baseline so the
		// save applies it. The gate holds back with the lists, so the stamp describes
		// one displayed state.
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

		if (Object.keys(merged).length > 0) {
			setCachedState((prevCachedState) => ({ ...prevCachedState, ...merged }))
		}
	}, [extensionState])

	// One raising point for the form's dirty signal and the save settle's edit signal,
	// so no user-edit path can mark the form dirty without telling the settle that the
	// buffer holds work the host's own refresh did not produce.
	const markUserEdit = useCallback(() => {
		setChangeDetected(true)
		userEditedDuringSave.current = true
	}, [])

	const setCachedStateField: SetCachedStateField<keyof ExtensionStateContextType> = useCallback(
		(field, value) => {
			// A no-op set must own neither the lists nor the edit signal, so the guard runs
			// before the update and stays outside the pure updater.
			if (latestCachedState.current[field] === value) {
				return
			}

			// Only a changed command list is an edit the save has to claim ownership of.
			if (field === "allowedCommands" || field === "deniedCommands") {
				commandListsTouched.current = true
			}

			markUserEdit()
			setCachedState((prevState) => ({ ...prevState, [field]: value }))
		},
		[markUserEdit],
	)

	const setApiConfigurationField = useCallback(
		<K extends keyof ProviderSettings>(field: K, value: ProviderSettings[K], isUserAction: boolean = true) => {
			const previousValue = latestCachedState.current.apiConfiguration[field]

			if (previousValue === value) {
				return
			}

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
				markUserEdit()
			}

			setCachedState((prevState) => ({
				...prevState,
				apiConfiguration: { ...prevState.apiConfiguration, [field]: value },
			}))
		},
		[markUserEdit],
	)

	const setExperimentEnabled: SetExperimentEnabled = useCallback(
		(id: ExperimentId, enabled: boolean) => {
			if (latestCachedState.current.experiments?.[id] === enabled) {
				return
			}

			markUserEdit()
			setCachedState((prevState) => ({ ...prevState, experiments: { ...prevState.experiments, [id]: enabled } }))
		},
		[markUserEdit],
	)

	const setTelemetrySetting = useCallback(
		(setting: TelemetrySetting) => {
			if (latestCachedState.current.telemetrySetting === setting) {
				return
			}

			markUserEdit()
			setCachedState((prevState) => ({ ...prevState, telemetrySetting: setting }))
		},
		[markUserEdit],
	)

	const setDebug = useCallback(
		(debug: boolean) => {
			if (latestCachedState.current.debug === debug) {
				return
			}

			markUserEdit()
			setCachedState((prevState) => ({ ...prevState, debug }))
		},
		[markUserEdit],
	)

	const setImageGenerationProvider = useCallback(
		(provider: ImageGenerationProvider) => {
			if (latestCachedState.current.imageGenerationProvider === provider) {
				return
			}

			markUserEdit()
			setCachedState((prevState) => ({ ...prevState, imageGenerationProvider: provider }))
		},
		[markUserEdit],
	)

	const setOpenRouterImageApiKey = useCallback(
		(apiKey: string) => {
			if (latestCachedState.current.openRouterImageApiKey === apiKey) {
				return
			}

			markUserEdit()
			setCachedState((prevState) => ({ ...prevState, openRouterImageApiKey: apiKey }))
		},
		[markUserEdit],
	)

	const setImageGenerationSelectedModel = useCallback(
		(model: string) => {
			if (latestCachedState.current.openRouterImageGenerationSelectedModel === model) {
				return
			}

			markUserEdit()
			setCachedState((prevState) => ({ ...prevState, openRouterImageGenerationSelectedModel: model }))
		},
		[markUserEdit],
	)

	const setCustomSupportPromptsField = useCallback(
		(prompts: Record<string, string | undefined>) => {
			if (JSON.stringify(latestCachedState.current.customSupportPrompts) === JSON.stringify(prompts)) {
				return
			}

			markUserEdit()
			setCachedState((prevState) => ({ ...prevState, customSupportPrompts: prompts }))
		},
		[markUserEdit],
	)

	const isSettingValid = !errorMessage

	// The host writes time and date settings one at a time, and a write can fail.
	// A save that changes one waits for the host's answer, like a list edit. A
	// save that changes neither asks for no answer.
	const displayChanged =
		(cachedState.timeFormat ?? "auto") !== (extensionState.timeFormat ?? "auto") ||
		(cachedState.dateFormat ?? "auto") !== (extensionState.dateFormat ?? "auto") ||
		(cachedState.showRelativeTimes ?? true) !== (extensionState.showRelativeTimes ?? true)

	const handleSubmit = () => {
		if (isSettingValid) {
			const [lastDisplayedAllowed, lastDisplayedDenied, gateAtSubmit] = JSON.parse(
				lastDisplayedCommandSnapshot.current,
			) as [string[], string[], boolean]

			// The host reports a rejected list write in the same answer as a failed
			// display write, so a save carrying either one waits for it. Without an id, a
			// rejected list edit would look saved.
			const saveId = displayChanged || commandListsTouched.current ? nextSaveRequestId() : undefined
			if (saveId) {
				submittedListSave.current = {
					baselined: [lastDisplayedAllowed, lastDisplayedDenied],
					sent: [allowedCommands ?? [], deniedCommands ?? []],
				}
				setPendingSaveId(saveId)
			}

			// Lowered at dispatch, so an edit that lands before the post counts as one made
			// before the save. No suspension point sits between this line and the post.
			userEditedDuringSave.current = false
			vscode.postMessage({
				type: "updateSettings",
				requestId: saveId,
				commandListBaseline: {
					allowedCommands: lastDisplayedAllowed,
					deniedCommands: lastDisplayedDenied,
					// The stamp carries the gate its lists were displayed under, so a gate flip
					// cannot reclassify a shown entry as a new global promotion. If the host never
					// delivered the gate, post none. The save path then uses the older
					// classification.
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
			// The stamp moves at submit, and the settle below re-derives each edited list
			// from its own write outcome. The lists' hold does not move at submit:
			// releasing early would let the refresh after a rejected write overwrite the
			// user's edit. An unwatched save needs no answer, so it clears the hold here.
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
			// The answer's flag reports the whole payload. Each list's own write result
			// comes from the refresh the host posts before its answer. Reconcile each
			// edited list: one equal to what was submitted landed, so its baseline stays
			// advanced. Every other edited list rolls back to the pre-submit baseline, so
			// an unwritten deletion stays a user deletion on retry. Unedited lists keep
			// the stamp's baseline.
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
			// Clear the flag only when nothing is left unsaved. An edit made during the
			// save, or a list whose write never landed, keeps the hold so a host refresh
			// cannot replace the user's edit.
			if (success && everyEditedWriteLanded && !userEditedDuringSave.current) {
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
