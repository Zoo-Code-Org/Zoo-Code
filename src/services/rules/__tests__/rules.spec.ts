import fs from "fs/promises"
import * as path from "path"
import { tmpdir } from "node:os"

const mockHome = vi.hoisted(() => ({ path: "" }))

vi.mock("os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("os")>()
	return {
		...actual,
		homedir: () => mockHome.path,
	}
})

import { createRule, deleteRule, getRules, resolveRuleFile, shouldIncludeRuleFile } from "../rules"

describe("rules service", () => {
	let tempDir: string
	let homeDir: string
	let cwd: string

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(tmpdir(), "zoo-rules-"))
		homeDir = path.join(tempDir, "home")
		cwd = path.join(tempDir, "workspace")
		mockHome.path = homeDir
		await fs.mkdir(cwd, { recursive: true })
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	it("returns global and workspace generic rules with deterministic metadata", async () => {
		await fs.mkdir(path.join(homeDir, ".roo", "rules"), { recursive: true })
		await fs.mkdir(path.join(cwd, ".roo", "rules"), { recursive: true })
		await fs.writeFile(path.join(homeDir, ".roo", "rules", "global-rule.md"), "# Global")
		await fs.writeFile(path.join(cwd, ".roo", "rules", "workspace-rule.md"), "# Workspace")

		const rules = await getRules(cwd, { modes: [] })

		expect(rules).toEqual([
			expect.objectContaining({
				id: "global:generic:generic:global-rule.md",
				name: "global-rule.md",
				scope: "global",
				kind: "generic",
				relativePath: "global-rule.md",
			}),
			expect.objectContaining({
				id: "project:generic:generic:workspace-rule.md",
				name: "workspace-rule.md",
				scope: "project",
				kind: "generic",
				relativePath: "workspace-rule.md",
			}),
		])
	})

	it("returns mode-specific rules for provided modes", async () => {
		await fs.mkdir(path.join(cwd, ".roo", "rules-code"), { recursive: true })
		await fs.writeFile(path.join(cwd, ".roo", "rules-code", "code-rule.md"), "# Code")

		const rules = await getRules(cwd, { modes: [{ slug: "code", name: "Code" }] })

		expect(rules).toEqual([
			expect.objectContaining({
				id: "project:mode:code:code-rule.md",
				kind: "mode",
				modeSlug: "code",
				modeName: "Code",
				relativePath: "code-rule.md",
			}),
		])
	})

	it("creates global generic and workspace mode rules", async () => {
		const globalPath = await createRule(cwd, {
			scope: "global",
			kind: "generic",
			fileName: "global-new",
		})
		const projectPath = await createRule(cwd, {
			scope: "project",
			kind: "mode",
			modeSlug: "code",
			fileName: "workspace-new.md",
		})

		expect(globalPath).toBe(path.join(homeDir, ".roo", "rules", "global-new.md"))
		expect(projectPath).toBe(path.join(cwd, ".roo", "rules-code", "workspace-new.md"))
		expect(await fs.readFile(globalPath, "utf-8")).toContain("# global-new")
		expect(await fs.readFile(projectPath, "utf-8")).toContain("for code mode")
	})

	it("rejects path traversal, absolute paths, and invalid file names", async () => {
		await expect(createRule(cwd, { scope: "global", kind: "generic", fileName: "../bad" })).rejects.toThrow(
			"not a path",
		)
		await expect(
			createRule(cwd, { scope: "global", kind: "generic", fileName: path.join(tempDir, "bad.md") }),
		).rejects.toThrow("not a path")
		await expect(createRule(cwd, { scope: "global", kind: "generic", fileName: "Bad Name" })).rejects.toThrow(
			"lowercase letters",
		)
	})

	it("deletes only resolved files inside an allowed rules directory", async () => {
		const rulePath = await createRule(cwd, { scope: "project", kind: "generic", fileName: "delete-me" })

		await deleteRule(cwd, {
			scope: "project",
			kind: "generic",
			relativePath: "delete-me.md",
		})

		await expect(fs.stat(rulePath)).rejects.toMatchObject({ code: "ENOENT" })
		await expect(
			resolveRuleFile(cwd, { scope: "project", kind: "generic", relativePath: "../outside.md" }),
		).rejects.toThrow("Invalid rule path")
	})

	it("ignores non-markdown, cache, and system files", async () => {
		await fs.mkdir(path.join(cwd, ".roo", "rules"), { recursive: true })
		await fs.writeFile(path.join(cwd, ".roo", "rules", "good.md"), "# Good")
		await fs.writeFile(path.join(cwd, ".roo", "rules", "debug.log"), "log")
		await fs.writeFile(path.join(cwd, ".roo", "rules", ".DS_Store"), "store")
		await fs.writeFile(path.join(cwd, ".roo", "rules", "notes.txt"), "notes")

		const rules = await getRules(cwd, { modes: [] })

		expect(rules.map((rule) => rule.name)).toEqual(["good.md"])
		expect(shouldIncludeRuleFile("debug.log")).toBe(false)
		expect(shouldIncludeRuleFile("notes.txt")).toBe(false)
		expect(shouldIncludeRuleFile("good.md")).toBe(true)
		expect(shouldIncludeRuleFile("backup.md.bak")).toBe(false)
		expect(shouldIncludeRuleFile("Thumbs.db")).toBe(false)
	})

	it("skips non-directory rule paths", async () => {
		await fs.mkdir(path.join(cwd, ".roo"), { recursive: true })
		await fs.writeFile(path.join(cwd, ".roo", "rules"), "not a directory")

		await expect(getRules(cwd, { modes: [] })).resolves.toEqual([])
	})

	it("skips symlinked directory rules outside the rules directory", async () => {
		const projectRulesDir = path.join(cwd, ".roo", "rules")
		const targetRulesDir = path.join(tempDir, "target-rules")
		const targetRulePath = path.join(targetRulesDir, "nested", "symlinked.md")
		await fs.mkdir(path.dirname(targetRulePath), { recursive: true })
		await fs.mkdir(projectRulesDir, { recursive: true })
		await fs.writeFile(targetRulePath, "# Symlinked")
		await fs.symlink(targetRulesDir, path.join(projectRulesDir, "linked"), "dir")

		const rules = await getRules(cwd, { modes: [] })

		expect(rules).toEqual([])
		await expect(
			resolveRuleFile(cwd, {
				scope: "project",
				kind: "generic",
				relativePath: path.join("linked", "nested", "symlinked.md"),
			}),
		).rejects.toThrow("Rule path must stay inside the rules directory")
		await expect(
			deleteRule(cwd, {
				scope: "project",
				kind: "generic",
				relativePath: path.join("linked", "nested", "symlinked.md"),
			}),
		).rejects.toThrow("Rule path must stay inside the rules directory")
		await expect(fs.stat(targetRulePath)).resolves.toBeDefined()
	})

	it("round-trips symlinked directory rules that stay inside the rules directory", async () => {
		const projectRulesDir = path.join(cwd, ".roo", "rules")
		const targetRulesDir = path.join(projectRulesDir, "target-rules")
		const targetRulePath = path.join(targetRulesDir, "nested", "symlinked.md")
		await fs.mkdir(path.dirname(targetRulePath), { recursive: true })
		await fs.writeFile(targetRulePath, "# Symlinked")
		await fs.symlink(targetRulesDir, path.join(projectRulesDir, "linked"), "dir")

		const rules = await getRules(cwd, { modes: [] })
		const symlinkedRule = rules.find((rule) => rule.name === "symlinked.md")

		expect(symlinkedRule).toEqual(
			expect.objectContaining({
				isSymlink: true,
				relativePath: path.join("linked", "nested", "symlinked.md"),
				filePath: targetRulePath,
			}),
		)
		expect(symlinkedRule!.relativePath).not.toContain("..")

		const resolvedPath = await resolveRuleFile(cwd, {
			scope: "project",
			kind: "generic",
			relativePath: symlinkedRule!.relativePath,
		})
		expect(resolvedPath).toBe(path.join(projectRulesDir, "linked", "nested", "symlinked.md"))

		await deleteRule(cwd, {
			scope: "project",
			kind: "generic",
			relativePath: symlinkedRule!.relativePath,
		})
		await expect(fs.stat(targetRulePath)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("skips symlinked rule file targets outside the rules directory", async () => {
		const projectRulesDir = path.join(cwd, ".roo", "rules")
		const targetRulePath = path.join(tempDir, "linked-rule.md")
		await fs.mkdir(projectRulesDir, { recursive: true })
		await fs.writeFile(targetRulePath, "# Linked")
		await fs.symlink(targetRulePath, path.join(projectRulesDir, "linked-file.md"), "file")

		const rules = await getRules(cwd, { modes: [] })

		expect(rules).toEqual([])
		await expect(
			resolveRuleFile(cwd, { scope: "project", kind: "generic", relativePath: "linked-file.md" }),
		).rejects.toThrow("Rule path must stay inside the rules directory")
	})

	it("discovers a symlinked rule file target inside the rules directory", async () => {
		const projectRulesDir = path.join(cwd, ".roo", "rules")
		const targetRulePath = path.join(projectRulesDir, "target-rule.md")
		await fs.mkdir(projectRulesDir, { recursive: true })
		await fs.writeFile(targetRulePath, "# Linked")
		await fs.symlink(targetRulePath, path.join(projectRulesDir, "linked-file.md"), "file")

		const rules = await getRules(cwd, { modes: [] })

		expect(rules).toEqual([
			expect.objectContaining({
				name: "linked-file.md",
				filePath: targetRulePath,
				isSymlink: true,
			}),
			expect.objectContaining({
				name: "target-rule.md",
				filePath: targetRulePath,
			}),
		])
	})

	it("skips broken symlinks while scanning rules", async () => {
		const projectRulesDir = path.join(cwd, ".roo", "rules")
		await fs.mkdir(projectRulesDir, { recursive: true })
		await fs.symlink(path.join(tempDir, "missing-target"), path.join(projectRulesDir, "broken.md"), "file")

		await expect(getRules(cwd, { modes: [] })).resolves.toEqual([])
	})

	it("handles duplicate creation and invalid target rule directory inputs", async () => {
		await createRule(cwd, { scope: "global", kind: "generic", fileName: "duplicate" })

		await expect(createRule(cwd, { scope: "global", kind: "generic", fileName: "duplicate.md" })).rejects.toThrow(
			"Rule file already exists: duplicate.md",
		)
		await expect(createRule(cwd, { scope: "team" as any, kind: "generic", fileName: "bad" })).rejects.toThrow(
			"Invalid rule scope",
		)
		await expect(createRule(cwd, { scope: "global", kind: "team" as any, fileName: "bad" })).rejects.toThrow(
			"Invalid rule kind",
		)
		await expect(createRule(cwd, { scope: "global", kind: "mode", fileName: "bad" })).rejects.toThrow(
			"Mode-specific rules require a mode",
		)
		await expect(
			createRule(cwd, { scope: "global", kind: "generic", modeSlug: "code", fileName: "bad" }),
		).rejects.toThrow("Generic rules cannot specify a mode")
		await expect(createRule("", { scope: "project", kind: "generic", fileName: "bad" })).rejects.toThrow(
			"Workspace rules require an open workspace",
		)
		await expect(
			createRule(cwd, { scope: "global", kind: "mode", modeSlug: "../bad", fileName: "bad" }),
		).rejects.toThrow("Invalid mode slug")
	})

	it("validates additional invalid rule names and paths", async () => {
		await expect(createRule(cwd, { scope: "global", kind: "generic", fileName: "   " })).rejects.toThrow(
			"Rule name is required",
		)
		await expect(
			createRule(cwd, { scope: "global", kind: "generic", fileName: `${"a".repeat(65)}.md` }),
		).rejects.toThrow("Rule name must be 64 characters or less (excluding the .md suffix)")
		await expect(
			resolveRuleFile(cwd, { scope: "project", kind: "generic", relativePath: "notes.txt" }),
		).rejects.toThrow("Invalid rule file")
		await expect(resolveRuleFile(cwd, { scope: "project", kind: "generic", relativePath: "   " })).rejects.toThrow(
			"Rule path is required",
		)
	})

	it("returns undefined when resolving missing paths and directories", async () => {
		await fs.mkdir(path.join(cwd, ".roo", "rules", "nested"), { recursive: true })

		await expect(
			resolveRuleFile(cwd, { scope: "project", kind: "generic", relativePath: "missing.md" }),
		).resolves.toBeUndefined()
		await expect(
			resolveRuleFile(cwd, { scope: "project", kind: "generic", relativePath: "nested" }),
		).rejects.toThrow("Invalid rule file")
		await expect(
			resolveRuleFile(cwd, { scope: "project", kind: "generic", relativePath: "nested/missing.md" }),
		).resolves.toBeUndefined()
	})

	it("handles missing directories as empty lists", async () => {
		await expect(getRules(cwd, { modes: [] })).resolves.toEqual([])
	})
})
