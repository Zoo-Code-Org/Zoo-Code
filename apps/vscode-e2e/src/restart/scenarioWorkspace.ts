import * as os from "os"
import * as path from "path"
import * as fs from "fs/promises"

const SCENARIO_ROOT_PREFIX = "roo-vscode-e2e-restart-"

export type ScenarioWorkspace = {
	root: string
	workspace: string
	userData: string
	extensions: string
	results: string
}

function childPath(root: string, name: string): string {
	const resolvedRoot = path.resolve(root)
	const resolvedChild = path.resolve(resolvedRoot, name)
	if (path.dirname(resolvedChild) !== resolvedRoot) {
		throw new Error(`Scenario path escaped its root: ${name}`)
	}
	return resolvedChild
}

export async function createScenarioWorkspace(): Promise<ScenarioWorkspace> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), SCENARIO_ROOT_PREFIX))
	const scenarioWorkspace: ScenarioWorkspace = {
		root,
		workspace: childPath(root, "workspace"),
		userData: childPath(root, "user-data"),
		extensions: childPath(root, "extensions"),
		results: childPath(root, "results"),
	}

	await Promise.all(
		[
			scenarioPath(scenarioWorkspace, "workspace"),
			scenarioPath(scenarioWorkspace, "userData"),
			scenarioPath(scenarioWorkspace, "extensions"),
			scenarioPath(scenarioWorkspace, "results"),
		].map((directory) => fs.mkdir(directory, { recursive: true })),
	)

	return scenarioWorkspace
}

function scenarioPath(scenarioWorkspace: ScenarioWorkspace, key: "workspace" | "userData" | "extensions" | "results") {
	return scenarioWorkspace[key]
}

export async function removeScenarioWorkspace(scenarioWorkspace: ScenarioWorkspace): Promise<void> {
	const root = path.resolve(scenarioWorkspace.root)
	const tempRoot = path.resolve(os.tmpdir())
	if (path.dirname(root) !== tempRoot || !path.basename(root).startsWith(SCENARIO_ROOT_PREFIX)) {
		throw new Error(`Refusing to remove an unowned scenario root: ${scenarioWorkspace.root}`)
	}

	await fs.rm(root, { recursive: true, force: true })
}
