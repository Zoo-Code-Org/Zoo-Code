import React, { createContext, useCallback, useContext, useMemo } from "react"

import type {
	TaskOrganizationMutationRequestV1,
	TaskOrganizationMutationResultV1,
	TaskOrganizationStateV1,
	TaskOrganizationTargetV1,
} from "@roo-code/types"
import { MAX_PINNED_TARGETS } from "@roo-code/types"

import { useExtensionState } from "@/context/ExtensionStateContext"

export interface TaskOrganizationInteractionContextValue {
	/** Current authoritative organization state from the extension host. */
	organization: TaskOrganizationStateV1
	/** Raw mutation dispatcher. Prefer the typed helpers below. */
	mutate: (mutation: TaskOrganizationMutationRequestV1["mutation"]) => Promise<TaskOrganizationMutationResultV1>
	/** True if the user can pin one more target. */
	canPin: boolean
	/** Returns true when the target is currently pinned. */
	isPinned: (target: TaskOrganizationTargetV1) => boolean
	/** Toggle pin state for a target. Returns the host result or a local validation failure. */
	togglePin: (target: TaskOrganizationTargetV1) => Promise<TaskOrganizationMutationResultV1>
	/** Create a folder with a validated name from two canonical units. */
	createFolder: (
		name: string,
		source: TaskOrganizationTargetV1,
		destination: TaskOrganizationTargetV1,
	) => Promise<TaskOrganizationMutationResultV1>
	/**
	 * Atomically create a folder from an explicit selection of canonical units.
	 * The folder ID is generated in the interaction layer, consistently with createFolder.
	 * Returns the host result without throwing and without optimistic state changes.
	 */
	createFolderFromSelection: (
		name: string,
		targets: TaskOrganizationTargetV1[],
	) => Promise<TaskOrganizationMutationResultV1>
	/** Rename an existing folder. */
	renameFolder: (folderId: string, name: string) => Promise<TaskOrganizationMutationResultV1>
	/** Delete a folder and its matching pin. */
	deleteFolder: (folderId: string) => Promise<TaskOrganizationMutationResultV1>
	/**
	 * Atomically delete multiple folders (and their matching pins) in one revision.
	 * Returns the host result without throwing and without optimistic state changes.
	 */
	deleteFolders: (folderIds: string[]) => Promise<TaskOrganizationMutationResultV1>
	/** Move a canonical unit into an existing folder. */
	moveToFolder: (source: TaskOrganizationTargetV1, folderId: string) => Promise<TaskOrganizationMutationResultV1>
	/** Remove a canonical unit from its folder. */
	removeFromFolder: (source: TaskOrganizationTargetV1, folderId: string) => Promise<TaskOrganizationMutationResultV1>
}

const TaskOrganizationInteractionContext = createContext<TaskOrganizationInteractionContextValue | null>(null)

export interface TaskOrganizationInteractionProviderProps {
	children: React.ReactNode
}

function targetKey(target: TaskOrganizationTargetV1): string {
	switch (target.kind) {
		case "task":
			return `task:${target.taskId}`
		case "autoGroup":
			return `group:${target.rootTaskId}`
		case "folder":
			return `folder:${target.folderId}`
	}
}

/**
 * Wraps task organization mutation helpers with local canonicalization and
 * validation so child components do not need to construct raw IPC payloads.
 */
export const TaskOrganizationInteractionProvider: React.FC<TaskOrganizationInteractionProviderProps> = ({
	children,
}) => {
	const { taskOrganization, mutateTaskOrganization } = useExtensionState()
	const organization = useMemo<TaskOrganizationStateV1>(
		() =>
			taskOrganization ?? {
				schemaVersion: 1,
				revision: 0,
				folders: [],
				pins: [],
				updatedAt: 0,
			},
		[taskOrganization],
	)

	const mutate = useCallback(
		async (mutation: TaskOrganizationMutationRequestV1["mutation"]): Promise<TaskOrganizationMutationResultV1> => {
			return mutateTaskOrganization(mutation)
		},
		[mutateTaskOrganization],
	)

	const pinnedKeys = useMemo(() => {
		const keys = new Set<string>()
		for (const pin of organization.pins) {
			keys.add(targetKey(pin.target))
		}
		return keys
	}, [organization.pins])

	const canPin = pinnedKeys.size < MAX_PINNED_TARGETS

	const isPinned = useCallback(
		(target: TaskOrganizationTargetV1) => {
			return pinnedKeys.has(targetKey(target))
		},
		[pinnedKeys],
	)

	const togglePin = useCallback(
		async (target: TaskOrganizationTargetV1): Promise<TaskOrganizationMutationResultV1> => {
			const desired = !isPinned(target)
			if (desired && pinnedKeys.size >= MAX_PINNED_TARGETS) {
				return {
					requestId: "",
					success: false,
					committedRevision: organization.revision,
					error: {
						code: "TASK_ORG/PIN_LIMIT/003",
						message: "TASK_ORG/PIN_LIMIT/003",
					},
				}
			}
			return mutate({ kind: "setPinned", target, pinned: desired })
		},
		[isPinned, mutate, organization.revision, pinnedKeys.size],
	)

	const createFolder = useCallback(
		async (
			name: string,
			source: TaskOrganizationTargetV1,
			destination: TaskOrganizationTargetV1,
		): Promise<TaskOrganizationMutationResultV1> => {
			const folderId = `folder-${Date.now()}-${Math.random().toString(36).slice(2)}`
			return mutate({ kind: "createFolder", folderId, name, source, destination })
		},
		[mutate],
	)

	const createFolderFromSelection = useCallback(
		async (name: string, targets: TaskOrganizationTargetV1[]): Promise<TaskOrganizationMutationResultV1> => {
			const folderId = `folder-${Date.now()}-${Math.random().toString(36).slice(2)}`
			return mutate({ kind: "createFolderFromSelection", folderId, name, targets })
		},
		[mutate],
	)

	const renameFolder = useCallback(
		async (folderId: string, name: string): Promise<TaskOrganizationMutationResultV1> => {
			return mutate({ kind: "renameFolder", folderId, name })
		},
		[mutate],
	)

	const deleteFolder = useCallback(
		async (folderId: string): Promise<TaskOrganizationMutationResultV1> => {
			return mutate({ kind: "deleteFolder", folderId })
		},
		[mutate],
	)

	const deleteFolders = useCallback(
		async (folderIds: string[]): Promise<TaskOrganizationMutationResultV1> => {
			return mutate({ kind: "deleteFolders", folderIds })
		},
		[mutate],
	)

	const moveToFolder = useCallback(
		async (source: TaskOrganizationTargetV1, folderId: string): Promise<TaskOrganizationMutationResultV1> => {
			return mutate({ kind: "moveToFolder", source, folderId })
		},
		[mutate],
	)

	const removeFromFolder = useCallback(
		async (source: TaskOrganizationTargetV1, folderId: string): Promise<TaskOrganizationMutationResultV1> => {
			return mutate({ kind: "removeFromFolder", source, folderId })
		},
		[mutate],
	)

	const value: TaskOrganizationInteractionContextValue = useMemo(
		() => ({
			organization,
			mutate,
			canPin,
			isPinned,
			togglePin,
			createFolder,
			createFolderFromSelection,
			renameFolder,
			deleteFolder,
			deleteFolders,
			moveToFolder,
			removeFromFolder,
		}),
		[
			organization,
			mutate,
			canPin,
			isPinned,
			togglePin,
			createFolder,
			createFolderFromSelection,
			renameFolder,
			deleteFolder,
			deleteFolders,
			moveToFolder,
			removeFromFolder,
		],
	)

	return (
		<TaskOrganizationInteractionContext.Provider value={value}>
			{children}
		</TaskOrganizationInteractionContext.Provider>
	)
}

export const useTaskOrganization = (): TaskOrganizationInteractionContextValue => {
	const context = useContext(TaskOrganizationInteractionContext)
	if (context === null) {
		throw new Error("useTaskOrganization must be used within a TaskOrganizationInteractionProvider")
	}
	return context
}
