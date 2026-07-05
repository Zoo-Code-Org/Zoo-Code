import fs from "fs/promises"
import * as path from "path"
import * as os from "os"
import { exec } from "node:child_process"
import { promisify } from "node:util"
import { writeManifest } from "./manifest"
import type { BooManifest } from "./manifest"

const execAsync = promisify(exec)

export type GenerateDescription = (folderName: string) => Promise<string>

async function fileExists(filePath: string): Promise<boolean> {
	try {
		const stat = await fs.stat(filePath)
		return stat.isFile()
	} catch {
		return false
	}
}

async function ensureDir(dirPath: string): Promise<void> {
	await fs.mkdir(dirPath, { recursive: true })
}

async function writeIfAbsent(filePath: string, content: string): Promise<void> {
	if (await fileExists(filePath)) return
	await fs.writeFile(filePath, content, "utf-8")
}

async function inferAuthor(): Promise<string> {
	try {
		const { stdout } = await execAsync("git config user.name")
		const name = stdout.trim()
		if (name) return name
	} catch {
		// fall through
	}
	return os.userInfo().username
}

function toTitleCase(str: string): string {
	return str.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

async function copyAgentsTemplate(workspaceRoot: string, extensionPath: string): Promise<void> {
	const targetPath = path.join(workspaceRoot, ".boo", "agents.yaml")
	if (await fileExists(targetPath)) return

	const templatePath = path.join(extensionPath, "assets", "boo-workspace", "agents.yaml")
	const template = await fs.readFile(templatePath, "utf-8")
	await fs.writeFile(targetPath, template, "utf-8")
}

export async function initWorkspace(
	workspaceRoot: string,
	generateDescription: GenerateDescription,
	extensionPath?: string,
): Promise<void> {
	const folderName = path.basename(workspaceRoot)

	await ensureDir(path.join(workspaceRoot, ".boo"))
	await ensureDir(path.join(workspaceRoot, "knowledge"))
	await ensureDir(path.join(workspaceRoot, "components"))

	await writeIfAbsent(path.join(workspaceRoot, ".boo", "style.md"), "Describe your writing style here.\n")
	await writeIfAbsent(
		path.join(workspaceRoot, ".boo", "instructions.md"),
		"Describe how you want the AI to behave.\n",
	)
	await writeIfAbsent(path.join(workspaceRoot, ".boo", "settings.json"), "{}\n")

	if (extensionPath) {
		await copyAgentsTemplate(workspaceRoot, extensionPath)
	}

	await writeIfAbsent(
		path.join(workspaceRoot, "knowledge", "knowledge.boo.md"),
		`---\nbackend: markdown\nindexed: false\n---\n\n## Knowledge Base\n\nDescribe what this knowledge base covers.\n`,
	)

	await writeIfAbsent(
		path.join(workspaceRoot, "knowledge", "glossary.md"),
		`# Glossary

Add characters, settings, concepts here as you develop them.
Use format: \`name (@tag:value)\`

## Characters
- (empty, add as you go)

## Settings
- (empty, add as you go)

## Concepts
- (empty, add as you go)
`,
	)

	const manifestPath = path.join(workspaceRoot, "workspace.boo.md")
	if (!(await fileExists(manifestPath))) {
		const author = await inferAuthor()

		let aboutSection: string
		try {
			aboutSection = await generateDescription(folderName)
		} catch {
			aboutSection = `Project ${folderName}`
		}

		const manifest: BooManifest = {
			frontmatter: {
				title: toTitleCase(folderName),
				author,
			},
			aboutSection,
			relationshipsSection: "",
		}
		await writeManifest(workspaceRoot, manifest)
	}
}
