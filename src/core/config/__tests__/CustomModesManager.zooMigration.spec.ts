// npx vitest run core/config/__tests__/CustomModesManager.zooMigration.spec.ts

import type { Mock } from "vitest"

import * as path from "path"
import * as fs from "fs/promises"
import * as yaml from "yaml"
import * as vscode from "vscode"

import type { ModeConfig } from "@roo-code/types"

import { fileExistsAtPath } from "../../../utils/fs"
import { getWorkspacePath } from "../../../utils/path"
import { GlobalFileNames } from "../../../shared/globalFileNames"

import { CustomModesManager } from "../CustomModesManager"

vi.mock("vscode", () => ({
	workspace: {
		workspaceFolders: [],
		onDidSaveTextDocument: vi.fn(),
		createFileSystemWatcher: vi.fn(),
	},
	window: {
		showErrorMessage: vi.fn(),
	},
}))

vi.mock("fs/promises", () => ({
	mkdir: vi.fn(),
	readFile: vi.fn(),
	writeFile: vi.fn(),
	stat: vi.fn(),
	readdir: vi.fn(),
	rm: vi.fn(),
}))

vi.mock("../../../utils/fs")
vi.mock("../../../utils/path")

describe("CustomModesManager Zoo migration", () => {
	let manager: CustomModesManager
	let mockContext: vscode.ExtensionContext
	let mockOnUpdate: Mock

	const mockStoragePath = `${path.sep}mock${path.sep}settings`
	const mockSettingsPath = path.join(mockStoragePath, "settings", GlobalFileNames.customModes)
	const mockWorkspacePath = path.resolve("/mock/workspace")
	const mockZoomodes = path.join(mockWorkspacePath, ".zoomodes")
	const mockRoomodes = path.join(mockWorkspacePath, ".roomodes")

	let existingPaths: Set<string>
	let fileContents: Record<string, string>

	beforeEach(() => {
		vi.clearAllMocks()

		mockOnUpdate = vi.fn()
		mockContext = {
			globalState: {
				get: vi.fn(),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn(() => []),
				setKeysForSync: vi.fn(),
			},
			globalStorageUri: {
				fsPath: mockStoragePath,
			},
		} as unknown as vscode.ExtensionContext
		;(vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: mockWorkspacePath } }]
		;(getWorkspacePath as Mock).mockReturnValue(mockWorkspacePath)

		existingPaths = new Set([mockSettingsPath])
		fileContents = {
			[mockSettingsPath]: yaml.stringify({
				customModes: [
					{ slug: "global-mode", name: "Global Mode", roleDefinition: "Global Role", groups: ["read"] },
				],
			}),
		}
		;(fileExistsAtPath as Mock).mockImplementation(async (filePath: string) => existingPaths.has(filePath))
		;(fs.readFile as Mock).mockImplementation(async (filePath: string) => {
			const content = fileContents[filePath]
			if (content === undefined) {
				throw new Error("File not found")
			}
			return content
		})
		;(fs.writeFile as Mock).mockImplementation(async (filePath: string, content: string) => {
			existingPaths.add(filePath)
			fileContents[filePath] = content
		})
		;(fs.mkdir as Mock).mockResolvedValue(undefined)
		;(fs.stat as Mock).mockResolvedValue({ isDirectory: () => true })
		;(fs.readdir as Mock).mockResolvedValue([])
		;(fs.rm as Mock).mockResolvedValue(undefined)

		manager = new CustomModesManager(mockContext, mockOnUpdate)
	})

	it("falls back to [.roomodes](src/core/config/__tests__/CustomModesManager.zooMigration.spec.ts:44) when [.zoomodes](src/core/config/__tests__/CustomModesManager.zooMigration.spec.ts:43) is absent", async () => {
		existingPaths.add(mockRoomodes)
		fileContents[mockRoomodes] = yaml.stringify({
			customModes: [
				{ slug: "legacy-project", name: "Legacy Project", roleDefinition: "Legacy Role", groups: ["read"] },
			],
		})

		const modes = await manager.getCustomModes()

		expect(modes.map((mode) => mode.slug)).toEqual(["legacy-project", "global-mode"])
		expect(modes.find((mode) => mode.slug === "legacy-project")?.source).toBe("project")
	})

	it("prefers [.zoomodes](src/core/config/__tests__/CustomModesManager.zooMigration.spec.ts:43) over [.roomodes](src/core/config/__tests__/CustomModesManager.zooMigration.spec.ts:44) when both exist", async () => {
		existingPaths.add(mockZoomodes)
		existingPaths.add(mockRoomodes)
		fileContents[mockZoomodes] = yaml.stringify({
			customModes: [{ slug: "project-mode", name: "Zoo Project", roleDefinition: "Zoo Role", groups: ["read"] }],
		})
		fileContents[mockRoomodes] = yaml.stringify({
			customModes: [
				{ slug: "legacy-only", name: "Legacy Only", roleDefinition: "Legacy Only Role", groups: ["read"] },
			],
		})

		const modes = await manager.getCustomModes()

		expect(modes.map((mode) => mode.slug)).toEqual(["project-mode", "global-mode"])
		expect(modes.find((mode) => mode.slug === "project-mode")?.name).toBe("Zoo Project")
		expect(modes.find((mode) => mode.slug === "legacy-only")).toBeUndefined()
	})

	it("bootstraps from [.roomodes](src/core/config/__tests__/CustomModesManager.zooMigration.spec.ts:44) and writes project updates to canonical [.zoomodes](src/core/config/__tests__/CustomModesManager.zooMigration.spec.ts:43)", async () => {
		existingPaths.add(mockRoomodes)
		fileContents[mockRoomodes] = yaml.stringify({
			customModes: [
				{ slug: "legacy-mode", name: "Legacy Mode", roleDefinition: "Legacy Role", groups: ["read"] },
			],
		})

		const newProjectMode: ModeConfig = {
			slug: "new-project-mode",
			name: "New Project Mode",
			roleDefinition: "New Project Role",
			groups: ["read"],
			source: "project",
		}

		await manager.updateCustomMode("new-project-mode", newProjectMode)

		expect(existingPaths.has(mockZoomodes)).toBe(true)
		expect((fs.writeFile as Mock).mock.calls.some(([filePath]) => filePath === mockRoomodes)).toBe(false)

		const zoomodesData = yaml.parse(fileContents[mockZoomodes])
		expect(zoomodesData.customModes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ slug: "legacy-mode", name: "Legacy Mode" }),
				expect.objectContaining({ slug: "new-project-mode", name: "New Project Mode", source: "project" }),
			]),
		)

		const roomodesData = yaml.parse(fileContents[mockRoomodes])
		expect(roomodesData.customModes).toEqual([
			expect.objectContaining({ slug: "legacy-mode", name: "Legacy Mode" }),
		])
	})
})
