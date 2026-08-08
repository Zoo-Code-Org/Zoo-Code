import React from "react"

import { TranslationContext } from "@src/i18n/TranslationContext"
import type { DisplayHistoryItem, TaskGroup } from "../types"
import { ManualFolderItem } from "../ManualFolderItem"
import { PinnedHistoryItem } from "../PinnedHistoryItem"
import TaskItem from "../TaskItem"

const translations: Record<string, string> = {
	"history:pin": "Pin",
	"history:unpin": "Unpin",
	"history:pinLimitReached": "Pin limit reached",
	"history:folderNameRequired": "Folder name is required",
	"history:folderNameTooLong": "Folder name is too long",
	"history:folderNameInvalidChars": "Folder name contains invalid characters",
	"history:renameFolder": "Rename folder",
	"history:deleteFolder": "Delete folder",
	"history:folderOptions": "Folder options",
	"history:expandFolder": "Expand folder",
	"history:collapseFolder": "Collapse folder",
	"history:recentTasks": "Recent Tasks",
	"history:viewAllHistory": "View All",
	"history:dropToRemoveFromFolder": "Drop here to remove from folder",
	"history:unfiled": "Unfiled",
}

const createTask = (id: string, task: string, isSubtask = false): DisplayHistoryItem => ({
	id,
	number: 1,
	ts: Date.now(),
	task,
	tokensIn: 100,
	tokensOut: 50,
	totalCost: 0.01,
	isSubtask,
})

const taskGroup = (parent: DisplayHistoryItem, subtasks: DisplayHistoryItem[] = []): TaskGroup => ({
	parent,
	subtasks: subtasks.map((t) => ({ item: t, children: [], isExpanded: false })),
	isExpanded: false,
})

interface TaskOrganizationFixtureProps {
	expandFolder?: boolean
	showPinned?: boolean
}

export const TaskOrganizationFixture: React.FC<TaskOrganizationFixtureProps> = ({
	expandFolder = false,
	showPinned = false,
}) => {
	const [expanded, setExpanded] = React.useState(expandFolder)

	const task1 = createTask("task-1", "Implement user authentication")
	const task2 = createTask("task-2", "Fix login redirect bug")
	const task3 = createTask("task-3", "Add password reset flow")

	return (
		<TranslationContext.Provider
			value={{
				t: (key) => translations[key] ?? key,
				i18n: null as unknown as typeof import("../../../i18n/setup").default,
			}}>
			<div className="w-[480px] bg-vscode-editor-background p-4 text-vscode-foreground">
				{showPinned && (
					<div className="mb-4">
						<PinnedHistoryItem
							folderName="Pinned Tasks"
							isPinned
							canPin
							onTogglePin={() => {}}
							isExpanded={false}
							onClick={() => {}}
							data-testid="pinned-folder">
							<TaskItem item={task1} variant="compact" />
						</PinnedHistoryItem>
					</div>
				)}

				<ManualFolderItem
					folderId="folder-1"
					name="Auth Work"
					unitCount={2}
					isExpanded={expanded}
					isPinned={false}
					canPin
					onToggleExpand={() => setExpanded(!expanded)}
					onRename={() => {}}
					onDelete={() => {}}
					onTogglePin={() => {}}
					data-testid="manual-folder-1">
					<TaskItem item={task1} variant="compact" />
					<TaskItem item={task2} variant="compact" />
				</ManualFolderItem>

				<ManualFolderItem
					folderId="folder-2"
					name="Bug Fixes"
					unitCount={1}
					isExpanded={false}
					isPinned={false}
					canPin
					onToggleExpand={() => {}}
					onRename={() => {}}
					onDelete={() => {}}
					onTogglePin={() => {}}
					data-testid="manual-folder-2">
					<TaskItem item={task3} variant="compact" />
				</ManualFolderItem>

				<TaskItem item={task1} variant="full" showPin isPinned={false} canPin />
			</div>
		</TranslationContext.Provider>
	)
}
