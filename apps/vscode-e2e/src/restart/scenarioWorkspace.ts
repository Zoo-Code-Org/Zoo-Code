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

const FAILURE_ARTIFACTS_DIR = "test-failures"

/**
 * Copies the diagnosable parts of a failed scenario workspace into a stable
 * directory inside the checkout, then removes the temporary scenario root.
 * CI uploads that directory as a run artifact, so the failure that used to be
 * deleted in the cleanup path stays inspectable: phase results, VS Code logs,
 * and the extension's task files. Global state databases are excluded.
 *
 * The directory is keyed by the unique scenario root name and cleared before
 * copying, so retried runs cannot mix artifacts from different failures.
 */
export async function preserveScenarioWorkspace(scenarioWorkspace: ScenarioWorkspace): Promise<string> {
	const destinationRoot = path.resolve(
		__dirname,
		"../../",
		FAILURE_ARTIFACTS_DIR,
		path.basename(scenarioWorkspace.root),
	)
	await fs.rm(destinationRoot, { recursive: true, force: true })
	await fs.mkdir(destinationRoot, { recursive: true })

	const selections: Array<{ label: string; source: string; destination: string }> = [
		{
			label: "phase results",
			source: scenarioWorkspace.results,
			destination: path.join(destinationRoot, "phase-results"),
		},
		{
			label: "VS Code logs",
			source: path.join(scenarioWorkspace.userData, "logs"),
			destination: path.join(destinationRoot, "vscode-logs"),
		},
		{
			label: "task files",
			source: path.join(
				scenarioWorkspace.userData,
				"User",
				"globalStorage",
				"zoocodeorganization.zoo-code",
				"tasks",
			),
			destination: path.join(destinationRoot, "tasks"),
		},
	]

	for (const selection of selections) {
		try {
			await fs.cp(selection.source, selection.destination, { recursive: true, force: true })
		} catch (error) {
			// A missing subdirectory must not hide the other artifacts.
			console.error(`Failed to preserve ${selection.label} from ${selection.source}:`, error)
		}
	}

	await removeScenarioWorkspace(scenarioWorkspace)
	return destinationRoot
}
