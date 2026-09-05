#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

import ts from "typescript"

export const MAX_CHANGED_LINES = 500
export const MAX_MUTANTS = 400

export const PACKAGE_CONFIGS = [
	{
		id: "core",
		root: "packages/core",
		sourceRoot: "packages/core/src/",
		vitestConfig: "vitest.unit.config.ts",
	},
	{
		id: "cloud",
		root: "packages/cloud",
		sourceRoot: "packages/cloud/src/",
		vitestConfig: "vitest.config.ts",
	},
	{
		id: "telemetry",
		root: "packages/telemetry",
		sourceRoot: "packages/telemetry/src/",
		vitestConfig: "vitest.config.ts",
	},
	{
		id: "vscode-shim",
		root: "packages/vscode-shim",
		sourceRoot: "packages/vscode-shim/src/",
		vitestConfig: "vitest.config.ts",
	},
	{
		id: "webview",
		root: "webview-ui",
		runRoot: ".",
		sourceRoot: "webview-ui/src/",
		vitestConfig: "vitest.stryker.config.ts",
		vitestRelated: false,
		discoverRelatedTests: true,
		excludedPaths: ["webview-ui/src/main.tsx"],
	},
	{
		id: "extension",
		root: "src",
		sourceRoot: "src/",
		vitestConfig: "vitest.config.ts",
		vitestRelated: false,
		discoverRelatedTests: true,
		excludedPaths: ["src/esbuild.mjs", "src/eslint.config.mjs", "src/utils/vitest-verbosity.ts"],
	},
]

const VALID_MUTANT_STATUSES = new Set(["Killed", "Timeout", "Survived", "NoCoverage"])
const BLOCKING_MUTANT_STATUSES = new Set(["Survived", "NoCoverage"])
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"])
const EXCLUDED_PATH_SEGMENTS = ["/__mocks__/", "/__tests__/", "/fixtures/", "/test-utils/"]
const DISABLE_DIRECTIVE =
	/^\s*\/\/\s*Stryker disable next-line ([A-Za-z][A-Za-z0-9]*(?:,[A-Za-z][A-Za-z0-9]*)*)\s*:\s*(\S.*)$/

export function parseNameStatus(output) {
	const tokens = output.split("\0")
	const entries = []

	for (let index = 0; index < tokens.length; ) {
		const statusToken = tokens[index++]
		if (!statusToken) break

		const status = statusToken[0]
		if (status === "R" || status === "C") {
			const oldPath = tokens[index++]
			const newPath = tokens[index++]
			if (!oldPath || !newPath) throw new Error(`Malformed git name-status entry: ${statusToken}`)
			entries.push({ status, oldPath, path: newPath })
		} else {
			const filePath = tokens[index++]
			if (!filePath) throw new Error(`Malformed git name-status entry: ${statusToken}`)
			entries.push({ status, path: filePath })
		}
	}

	return entries
}

export function parseChangedLines(diff) {
	const lines = new Set()
	const hunkPattern = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/

	for (const line of diff.split("\n")) {
		const match = hunkPattern.exec(line)
		if (!match) continue

		const start = Number(match[1])
		const count = match[2] === undefined ? 1 : Number(match[2])
		for (let offset = 0; offset < count; offset++) lines.add(start + offset)
	}

	return lines
}

function isTypeOnlyNode(node) {
	return (
		ts.isImportDeclaration(node) ||
		ts.isImportEqualsDeclaration(node) ||
		ts.isInterfaceDeclaration(node) ||
		ts.isTypeAliasDeclaration(node) ||
		ts.isTypeNode(node) ||
		ts.isExportDeclaration(node) ||
		(ts.isImportSpecifier(node) && node.isTypeOnly) ||
		(ts.isExportSpecifier(node) && node.isTypeOnly)
	)
}

export function executableChangedLines(source, changedLines, filePath = "source.ts") {
	const scriptKind = filePath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
	const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind)
	const executable = new Set()

	function mark(node, fullSpan) {
		const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
		const end = fullSpan ? sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1 : start
		for (let line = start; line <= end; line++) {
			if (changedLines.has(line)) executable.add(line)
		}
	}

	function visit(node) {
		if (isTypeOnlyNode(node)) return

		if (ts.isExpression(node)) {
			mark(node, true)
		} else if (ts.isStatement(node) && !ts.isBlock(node) && !ts.isEmptyStatement(node)) {
			mark(node, false)
		}

		ts.forEachChild(node, visit)
	}

	visit(sourceFile)
	return executable
}

export function validateDisableDirectives(source, changedLines, filePath) {
	const lines = source.split(/\r?\n/)
	for (const lineNumber of changedLines) {
		const line = lines[lineNumber - 1] ?? ""
		if (!line.includes("Stryker disable")) continue

		const match = DISABLE_DIRECTIVE.exec(line)
		if (!match || match[1].split(",").some((mutator) => mutator.toLowerCase() === "all")) {
			throw new Error(
				`${filePath}:${lineNumber}: mutation exclusions must use ` +
					'"// Stryker disable next-line MutatorName: concrete reason"; broad or unreasoned exclusions are not allowed.',
			)
		}
	}
}

export function toRanges(lines) {
	const sorted = [...lines].sort((left, right) => left - right)
	const ranges = []

	for (const line of sorted) {
		const previous = ranges.at(-1)
		if (previous && line === previous.end + 1) {
			previous.end = line
		} else {
			ranges.push({ start: line, end: line })
		}
	}

	return ranges
}

export function packageForPath(filePath) {
	if (
		!SOURCE_EXTENSIONS.has(path.posix.extname(filePath)) ||
		EXCLUDED_PATH_SEGMENTS.some((segment) => filePath.includes(segment)) ||
		/(?:^|\/)[^/]+\.(?:test|spec|visual)(?:\.[^.]+)?\.[cm]?[jt]sx?$/.test(filePath) ||
		filePath.endsWith(".d.ts") ||
		path.posix.basename(filePath).startsWith("vitest.config.") ||
		path.posix.basename(filePath).startsWith("vite.config.") ||
		path.posix.basename(filePath).startsWith("vitest.setup.") ||
		path.posix.basename(filePath).startsWith("test-utils.")
	) {
		return undefined
	}

	const packageConfig = PACKAGE_CONFIGS.find((candidate) => filePath.startsWith(candidate.sourceRoot))
	return packageConfig?.excludedPaths?.includes(filePath) ? undefined : packageConfig
}

export function buildManifest(entries, readSource, diffForPath) {
	const packages = new Map()

	for (const entry of entries) {
		if (!new Set(["A", "M", "R"]).has(entry.status)) continue
		const packageConfig = packageForPath(entry.path)
		if (!packageConfig) continue

		const source = readSource(entry.path)
		const sourceLineCount = source.split(/\r?\n/).length
		const changedLines =
			entry.status === "A"
				? new Set(Array.from({ length: sourceLineCount }, (_, index) => index + 1))
				: parseChangedLines(diffForPath(entry.path))

		validateDisableDirectives(source, new Set(source.split(/\r?\n/).map((_, index) => index + 1)), entry.path)
		const executableLines = executableChangedLines(source, changedLines, entry.path)
		if (executableLines.size === 0) continue

		const relativePath = path.posix.relative(packageConfig.runRoot ?? packageConfig.root, entry.path)
		const selectors = toRanges(executableLines).map(({ start, end }) => `${relativePath}:${start}-${end}`)

		const packageEntry = packages.get(packageConfig.id) ?? {
			...packageConfig,
			changedExecutableLines: 0,
			files: [],
			selectors: [],
		}
		packageEntry.changedExecutableLines += executableLines.size
		packageEntry.files.push({
			path: entry.path,
			status: entry.status,
			executableLines: [...executableLines].sort((a, b) => a - b),
		})
		packageEntry.selectors.push(...selectors)
		packages.set(packageConfig.id, packageEntry)
	}

	for (const packageEntry of packages.values()) {
		if (packageEntry.changedExecutableLines > MAX_CHANGED_LINES) {
			throw new Error(
				`${packageEntry.id} has ${packageEntry.changedExecutableLines} changed executable lines (limit ${MAX_CHANGED_LINES}). ` +
					"Split the PR or obtain a maintainer-reviewed narrow exclusion.",
			)
		}
	}

	return { packages: [...packages.values()] }
}

function validateSha(value, name) {
	if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error(`${name} must be a full 40-character commit SHA`)
}

function git(repoRoot, args) {
	return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 })
}

export function selectFromGit(repoRoot, baseSha, headSha) {
	validateSha(baseSha, "base SHA")
	validateSha(headSha, "head SHA")
	const mergeBase = git(repoRoot, ["merge-base", baseSha, headSha]).trim()
	const nameStatus = git(repoRoot, ["diff", "--name-status", "-z", "--find-renames", `${mergeBase}...${headSha}`])
	const entries = parseNameStatus(nameStatus)
	const manifest = buildManifest(
		entries,
		(filePath) => fs.readFileSync(path.join(repoRoot, filePath), "utf8"),
		(filePath) =>
			git(repoRoot, [
				"diff",
				"--unified=0",
				"--no-color",
				"--no-ext-diff",
				`${mergeBase}...${headSha}`,
				"--",
				filePath,
			]),
	)

	return { baseSha, headSha, mergeBase, ...manifest }
}

function stripAnsi(value) {
	return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
}

function selectorFile(selector) {
	return selector.replace(/:\d+(?::\d+)?-\d+(?::\d+)?$/, "")
}

export function parseVitestTestFiles(report, runRoot) {
	return [
		...new Set((report.testResults ?? []).map(({ name }) => path.relative(runRoot, name).replaceAll("\\", "/"))),
	]
}

export function preferDirectTestFiles(testFiles, sourceFiles) {
	// Spec files follow the lowerCamel source-name convention (e.g.
	// writeToFileTool.spec.ts for WriteToFileTool.ts), so match case-insensitively.
	const sourceNames = sourceFiles.map((sourceFile) => path.posix.basename(sourceFile, path.posix.extname(sourceFile)))
	const direct = testFiles.filter((testFile) => {
		const testName = path.posix.basename(testFile).toLowerCase()
		return sourceNames.some(
			(sourceName) =>
				testName.startsWith(`${sourceName.toLowerCase()}.`) && /\.(?:test|spec)(?:\.[^.]+)?\.[cm]?[jt]sx?$/.test(testName),
		)
	})
	return direct.length > 0 ? direct : testFiles
}

export function resolveVitestBinary(repoRoot, packageEntry) {
	const packageRoot = path.join(repoRoot, packageEntry.root)
	const runRoot = path.join(repoRoot, packageEntry.runRoot ?? packageEntry.root)
	const candidates = [...new Set([runRoot, packageRoot, repoRoot])].map((root) =>
		path.join(root, "node_modules/.bin/vitest"),
	)
	return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates.at(-1)
}

export function discoverRelatedTestFiles(repoRoot, packageEntry, reportDirectory) {
	const packageRoot = path.join(repoRoot, packageEntry.root)
	const runRoot = path.join(repoRoot, packageEntry.runRoot ?? packageEntry.root)
	const outputFile = path.join(reportDirectory, "vitest-related.json")
	const configFile = path.relative(runRoot, path.join(packageRoot, packageEntry.vitestConfig)).replaceAll("\\", "/")
	const sourceFiles = [...new Set(packageEntry.selectors.map(selectorFile))]
	const result = spawnSync(
		resolveVitestBinary(repoRoot, packageEntry),
		["related", ...sourceFiles, "--run", "--config", configFile, "--reporter=json", `--outputFile=${outputFile}`],
		{
			cwd: runRoot,
			encoding: "utf8",
			timeout: 5 * 60 * 1_000,
			maxBuffer: 50 * 1024 * 1024,
			env: process.env,
		},
	)

	if (result.error?.code === "ETIMEDOUT") {
		throw new Error(`${packageEntry.id} related-test discovery exceeded 5 minutes`)
	}
	if (result.error) {
		throw new Error(`${packageEntry.id} related-test discovery could not start: ${result.error.message}`)
	}
	if (result.status !== 0) {
		throw new Error(
			`${packageEntry.id} related-test discovery failed:\n${stripAnsi(`${result.stdout ?? ""}${result.stderr ?? ""}`).trim()}`,
		)
	}

	const testFiles = preferDirectTestFiles(
		parseVitestTestFiles(JSON.parse(fs.readFileSync(outputFile, "utf8")), runRoot),
		sourceFiles,
	)
	if (testFiles.length === 0)
		throw new Error(`${packageEntry.id} has no tests related to the changed executable lines`)
	return testFiles
}

function runStryker(repoRoot, packageEntry, reportRoot, dryRunOnly) {
	const packageRoot = path.join(repoRoot, packageEntry.root)
	const runRoot = path.join(repoRoot, packageEntry.runRoot ?? packageEntry.root)
	const reportDirectory = path.join(reportRoot, packageEntry.id)
	fs.mkdirSync(reportDirectory, { recursive: true })

	const args = [
		"run",
		path.join(repoRoot, "stryker.config.mjs"),
		"--force",
		"--mutate",
		packageEntry.selectors.join(","),
	]
	if (dryRunOnly) args.push("--dryRunOnly", "--reporters", "clear-text", "--logLevel", "info")

	const result = spawnSync(path.join(repoRoot, "node_modules/.bin/stryker"), args, {
		cwd: runRoot,
		encoding: "utf8",
		timeout: 12 * 60 * 1_000,
		maxBuffer: 50 * 1024 * 1024,
		env: {
			...process.env,
			STRYKER_VITEST_CONFIG: path
				.relative(runRoot, path.join(packageRoot, packageEntry.vitestConfig))
				.replaceAll("\\", "/"),
			STRYKER_REPORT_DIR: reportDirectory,
			STRYKER_IN_PLACE: "false",
			STRYKER_VITEST_RELATED: packageEntry.vitestRelated === false ? "false" : "true",
			STRYKER_TEST_FILES: JSON.stringify(packageEntry.testFiles ?? []),
		},
	})

	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
	if (result.error?.code === "ETIMEDOUT") {
		throw new Error(
			`${packageEntry.id} mutation run exceeded 12 minutes. Split the PR or obtain a maintainer-reviewed narrow exclusion.`,
		)
	}
	if (result.error) {
		throw new Error(
			`${packageEntry.id} Stryker ${dryRunOnly ? "preflight" : "run"} could not start: ${result.error.message}`,
		)
	}
	if (result.status !== 0) {
		throw new Error(
			`${packageEntry.id} Stryker ${dryRunOnly ? "preflight" : "run"} failed:\n${stripAnsi(output).trim()}`,
		)
	}

	return output
}

export function mutantCounts(report) {
	const counts = { valid: 0, killed: 0, timeout: 0, survived: 0, noCoverage: 0, ignored: 0, blocking: [] }

	for (const [filePath, file] of Object.entries(report.files ?? {})) {
		for (const mutant of file.mutants ?? []) {
			if (VALID_MUTANT_STATUSES.has(mutant.status)) counts.valid++
			if (mutant.status === "Killed") counts.killed++
			if (mutant.status === "Timeout") counts.timeout++
			if (mutant.status === "Survived") counts.survived++
			if (mutant.status === "NoCoverage") counts.noCoverage++
			if (mutant.status === "Ignored") counts.ignored++
			if (BLOCKING_MUTANT_STATUSES.has(mutant.status)) counts.blocking.push({ filePath, ...mutant })
		}
	}

	return counts
}

function escapeWorkflowData(value) {
	return String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")
}

function escapeWorkflowProperty(value) {
	return escapeWorkflowData(value).replaceAll(":", "%3A").replaceAll(",", "%2C")
}

export function formatAnnotationCommand(annotation) {
	return `::error file=${escapeWorkflowProperty(annotation.file)},line=${annotation.line},title=Mutation test gap::${escapeWorkflowData(annotation.message)}`
}

export function formatAnnotations(blockingMutants, packageRoot, state = { total: 0, perFile: new Map() }) {
	const annotations = []

	for (const mutant of blockingMutants.sort((left, right) => {
		const pathOrder = left.filePath.localeCompare(right.filePath)
		return pathOrder || left.location.start.line - right.location.start.line
	})) {
		const repositoryPath = path.posix.join(packageRoot, mutant.filePath.replaceAll("\\", "/"))
		const key = `${repositoryPath}:${mutant.location.start.line}`
		const fileCount = state.perFile.get(repositoryPath) ?? 0
		if (annotations.some((annotation) => annotation.key === key) || fileCount >= 7 || state.total >= 20) continue

		const replacement = String(mutant.replacement ?? "")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 160)
		annotations.push({
			key,
			file: repositoryPath,
			line: mutant.location.start.line,
			message:
				`${mutant.status} ${mutant.mutatorName} mutant${replacement ? ` (replacement: ${replacement})` : ""}. ` +
				"See the job summary for the complete list and resolution guidance.",
		})
		state.perFile.set(repositoryPath, fileCount + 1)
		state.total++
	}

	return annotations
}

function markdownCell(value) {
	return String(value ?? "—")
		.replace(/\s+/g, " ")
		.trim()
		.replaceAll("|", "\\|")
		.slice(0, 120)
}

export function testsFromMutationReport(report, fallback = []) {
	const testFiles = Object.keys(report.testFiles ?? {})
	return testFiles.length > 0 ? testFiles : fallback
}

export function formatBlockingMutants(blockingMutants, packageRoot) {
	const grouped = new Map()
	for (const mutant of [...blockingMutants].sort((left, right) => {
		const pathOrder = left.filePath.localeCompare(right.filePath)
		return pathOrder || left.location.start.line - right.location.start.line
	})) {
		const repositoryPath = path.posix.join(packageRoot, mutant.filePath.replaceAll("\\", "/"))
		const group = grouped.get(repositoryPath) ?? []
		group.push(mutant)
		grouped.set(repositoryPath, group)
	}

	const lines = []
	for (const [filePath, mutants] of grouped) {
		lines.push(
			`#### \`${filePath}\``,
			"",
			"| Line | Status | Mutator | Replacement |",
			"| ---: | --- | --- | --- |",
		)
		for (const mutant of mutants) {
			lines.push(
				`| ${mutant.location.start.line} | ${markdownCell(mutant.status)} | ${markdownCell(mutant.mutatorName)} | ${markdownCell(mutant.replacement)} |`,
			)
		}
		lines.push("")
	}
	return lines
}

export function formatSummary(rows, failures, manifest = {}) {
	const lines = [
		"## Changed-code mutation testing",
		"",
		"| Package | Changed executable lines | Valid | Killed | Timeout | Survived | No coverage | Result |",
		"| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
	]
	for (const row of rows) {
		lines.push(
			`| ${row.id} | ${row.changedLines} | ${row.valid} | ${row.killed} | ${row.timeout} | ${row.survived} | ${row.noCoverage} | ${row.result} |`,
		)
	}
	if (rows.length === 0) lines.push("| — | 0 | 0 | 0 | 0 | 0 | 0 | Not applicable |")

	if (rows.length > 0) {
		lines.push("", "### Focused tests")
		for (const row of rows) {
			const cwd = row.runRoot ?? row.root
			if (row.testFiles?.length > 0) {
				lines.push(`- **${row.id}** (cwd \`${cwd}\`): ${row.testFiles.map((file) => `\`${file}\``).join(", ")}`)
			} else {
				lines.push(
					`- **${row.id}** (cwd \`${cwd}\`): the mutation run did not complete far enough to report its selected tests; use the exact reproduction command below.`,
				)
			}
		}
	}

	const blockingRows = rows.filter((row) => row.blocking?.length > 0)
	if (blockingRows.length > 0) {
		lines.push(
			"",
			"### All surviving and uncovered mutants",
			"",
			"Annotations highlight up to 20 unique locations (maximum 7 per file). This summary lists every blocking mutant.",
			"",
		)
		for (const row of blockingRows) {
			lines.push(`### ${row.id}`, "", ...formatBlockingMutants(row.blocking, row.runRoot ?? row.root))
		}
		lines.push(
			"### Resolve a mutation gap",
			"",
			"Add or strengthen a focused test that fails under the mutation. If the mutant is equivalent, request maintainer approval for the narrowest mutator-specific exclusion and explain why it cannot change behavior:",
			"",
			"```ts",
			"// Stryker disable next-line ConditionalExpression: normalized input cannot reach the alternate branch",
			"const result = condition ? value : fallback",
			"```",
			"",
			"Broad `all` exclusions and exclusions without a concrete reason are rejected by the gate.",
		)
	}

	if (manifest.baseSha && manifest.headSha) {
		lines.push(
			"",
			"### Reproduce locally",
			"",
			"From a full checkout containing both commits:",
			"",
			"```bash",
			"pnpm install --frozen-lockfile",
			`node scripts/stryker-diff.mjs ci --base ${manifest.baseSha} --head ${manifest.headSha}`,
			"```",
		)
	}

	if (rows.length > 0) {
		lines.push("", "### Mutation reports", "")
		for (const row of rows) lines.push(`- **${row.id}:** \`${row.reportPath}\``)
		lines.push(
			"",
			"The workflow uploads generated reports in the `changed-code-mutation-report` artifact. A direct artifact link appears below after upload.",
		)
	}

	if (failures.length > 0) {
		lines.push(
			"",
			"### Failures",
			"",
			...failures.map((failure) => {
				const detail =
					failure.length > 4_000 ? `${failure.slice(0, 4_000)}\n[truncated; see the step log]` : failure
				return `- ${detail.replaceAll("\n", "\n  ")}`
			}),
		)
	}

	return `${lines.join("\n")}\n`
}

function appendSummary(rows, failures, manifest) {
	if (!process.env.GITHUB_STEP_SUMMARY) return
	fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, formatSummary(rows, failures, manifest))
}

export function evaluateReport(report, packageEntry) {
	const counts = mutantCounts(report)
	if (counts.valid > MAX_MUTANTS) {
		throw new Error(
			`${packageEntry.id} generated ${counts.valid} valid mutants (limit ${MAX_MUTANTS}). ` +
				"Split the PR or obtain a maintainer-reviewed narrow exclusion.",
		)
	}
	if (counts.timeout > 10 || (counts.valid > 0 && counts.timeout / counts.valid > 0.15)) {
		throw new Error(
			`${packageEntry.id} timed out ${counts.timeout} of ${counts.valid} valid mutants. ` +
				"The result is inconclusive; fix flaky or slow tests, or reduce the changed scope before merge.",
		)
	}
	if (counts.blocking.length > 0) {
		throw new Error(
			`${packageEntry.id} has ${counts.survived} surviving and ${counts.noCoverage} uncovered changed-code mutants. ` +
				"Add or strengthen focused tests before merge.",
		)
	}
	return counts
}

export function runManifest(repoRoot, manifest, reportRoot) {
	const rows = []
	const failures = []
	const annotationState = { total: 0, perFile: new Map() }

	for (const packageEntry of manifest.packages) {
		let counts
		const reportPath = path
			.relative(repoRoot, path.join(reportRoot, packageEntry.id, "mutation.html"))
			.replaceAll("\\", "/")
		try {
			const reportDirectory = path.join(reportRoot, packageEntry.id)
			fs.mkdirSync(reportDirectory, { recursive: true })
			if (packageEntry.discoverRelatedTests) {
				packageEntry.testFiles = discoverRelatedTestFiles(repoRoot, packageEntry, reportDirectory)
			}
			const preflightOutput = stripAnsi(runStryker(repoRoot, packageEntry, reportRoot, true))
			const mutantMatch = /Instrumented \d+ source file\(s\) with (\d+) mutant\(s\)/.exec(preflightOutput)
			if (!mutantMatch) throw new Error(`${packageEntry.id} preflight did not report a mutant count`)
			const generatedMutants = Number(mutantMatch[1])
			if (generatedMutants > MAX_MUTANTS) {
				throw new Error(
					`${packageEntry.id} generated ${generatedMutants} mutants in preflight (limit ${MAX_MUTANTS}). ` +
						"Split the PR or obtain a maintainer-reviewed narrow exclusion.",
				)
			}

			if (generatedMutants === 0) {
				rows.push({
					id: packageEntry.id,
					root: packageEntry.root,
					runRoot: packageEntry.runRoot,
					selectors: packageEntry.selectors,
					testFiles: packageEntry.testFiles ?? [],
					reportPath,
					changedLines: packageEntry.changedExecutableLines,
					valid: 0,
					killed: 0,
					timeout: 0,
					survived: 0,
					noCoverage: 0,
					result: "No mutants generated",
				})
				continue
			}

			runStryker(repoRoot, packageEntry, reportRoot, false)
			const jsonReportPath = path.join(reportRoot, packageEntry.id, "mutation.json")
			const report = JSON.parse(fs.readFileSync(jsonReportPath, "utf8"))
			packageEntry.testFiles = testsFromMutationReport(report, packageEntry.testFiles)
			counts = mutantCounts(report)
			for (const annotation of formatAnnotations(
				counts.blocking,
				packageEntry.runRoot ?? packageEntry.root,
				annotationState,
			)) {
				console.log(formatAnnotationCommand(annotation))
			}
			evaluateReport(report, packageEntry)
			rows.push({
				id: packageEntry.id,
				root: packageEntry.root,
				runRoot: packageEntry.runRoot,
				selectors: packageEntry.selectors,
				testFiles: packageEntry.testFiles ?? [],
				reportPath,
				changedLines: packageEntry.changedExecutableLines,
				...counts,
				result: "Passed",
			})
		} catch (error) {
			failures.push(error.message)
			rows.push({
				id: packageEntry.id,
				root: packageEntry.root,
				runRoot: packageEntry.runRoot,
				selectors: packageEntry.selectors,
				testFiles: packageEntry.testFiles ?? [],
				reportPath,
				changedLines: packageEntry.changedExecutableLines,
				valid: counts?.valid ?? 0,
				killed: counts?.killed ?? 0,
				timeout: counts?.timeout ?? 0,
				survived: counts?.survived ?? 0,
				noCoverage: counts?.noCoverage ?? 0,
				blocking: counts?.blocking ?? [],
				result: "Failed",
			})
		}
	}

	appendSummary(rows, failures, manifest)
	if (failures.length > 0) throw new Error(failures.join("\n"))
	return rows
}

function argument(name) {
	const index = process.argv.indexOf(name)
	return index === -1 ? undefined : process.argv[index + 1]
}

function main() {
	const command = process.argv[2]
	if (command !== "ci")
		throw new Error("Usage: node scripts/stryker-diff.mjs ci --base <sha> --head <sha> [--reports <path>]")

	const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
	const baseSha = argument("--base")
	const headSha = argument("--head")
	if (!baseSha || !headSha) throw new Error("--base and --head are required")

	const reportRoot = path.resolve(repoRoot, argument("--reports") ?? "reports/mutation")
	const manifest = selectFromGit(repoRoot, baseSha, headSha)
	if (manifest.packages.length === 0) {
		appendSummary([], [], manifest)
		console.log("No changed executable lines in mutation-tested packages; mutation testing is not applicable.")
		return
	}

	console.log(
		`Mutation-testing ${manifest.packages.length} package(s) from merge base ${manifest.mergeBase.slice(0, 12)}: ` +
			manifest.packages.map((entry) => `${entry.id} (${entry.changedExecutableLines} lines)`).join(", "),
	)
	runManifest(repoRoot, manifest, reportRoot)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main()
	} catch (error) {
		console.error(`Mutation gate failed: ${error.message}`)
		process.exitCode = 1
	}
}
