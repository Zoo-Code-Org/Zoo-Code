import { spawn } from "child_process"
import * as path from "path"

export interface ProcessResult {
	stdout: string
	stderr: string
}

function quotePowerShellString(value: string): string {
	return `'${value.replace(/'/g, "''")}'`
}

function encodePowerShellCommand(script: string): string {
	return Buffer.from(script, "utf16le").toString("base64")
}

async function runPowerShell(script: string): Promise<ProcessResult> {
	return runProcess("powershell", [
		"-NoProfile",
		"-NonInteractive",
		"-EncodedCommand",
		encodePowerShellCommand(script),
	])
}

export function runProcess(executable: string, args: string[], timeoutMs = 30_000): Promise<ProcessResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(executable, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] })
		let stdout = ""
		let stderr = ""
		const timer = setTimeout(() => {
			child.kill("SIGKILL")
			reject(new Error(`${path.basename(executable)} timed out`))
		}, timeoutMs)
		child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()))
		child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
		child.on("error", (error) => {
			clearTimeout(timer)
			reject(error)
		})
		child.on("close", (code) => {
			clearTimeout(timer)
			if (code === 0) {
				resolve({ stdout, stderr })
			} else {
				reject(new Error(stderr.trim() || `Process exited with code ${code}`))
			}
		})
	})
}

export async function extractTarGzArchive(archivePath: string, destination: string): Promise<void> {
	const args = ["-xzf", archivePath, "-C", destination, "--no-same-owner"]
	if (process.platform === "linux") {
		args.push("--no-overwrite-dir")
	}
	await runProcess("tar", args)
}

export async function extractTarXzArchive(archivePath: string, destination: string): Promise<void> {
	const args = ["-xJf", archivePath, "-C", destination, "--no-same-owner"]
	if (process.platform === "linux") {
		args.push("--no-overwrite-dir")
	}
	await runProcess("tar", args)
}

export async function extractZipArchive(archivePath: string, destination: string): Promise<void> {
	if (process.platform === "win32") {
		const script = [
			"$ErrorActionPreference = 'Stop'",
			`$archivePath = ${quotePowerShellString(archivePath)}`,
			`$destination = ${quotePowerShellString(destination)}`,
			"Expand-Archive -LiteralPath $archivePath -DestinationPath $destination -Force",
		].join("; ")
		await runPowerShell(script)
		return
	}

	await runProcess("unzip", ["-o", archivePath, "-d", destination])
}

export async function extractSingleFileZipArchive(
	archivePath: string,
	destination: string,
	expectedFile: string,
	archiveName: string,
): Promise<void> {
	if (process.platform !== "win32") {
		throw new Error("Single-file ZIP extraction is only supported on Windows")
	}

	const script = [
		"$ErrorActionPreference = 'Stop'",
		`$archivePath = ${quotePowerShellString(archivePath)}`,
		`$outputPath = ${quotePowerShellString(path.join(destination, expectedFile))}`,
		`$expectedFile = ${quotePowerShellString(expectedFile)}`,
		`$archiveName = ${quotePowerShellString(archiveName)}`,
		"Add-Type -AssemblyName System.IO.Compression.FileSystem",
		"$archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)",
		"try {",
		"  $entries = @($archive.Entries | Where-Object { -not [string]::IsNullOrEmpty($_.Name) })",
		'  if ($entries.Count -ne 1 -or $entries[0].FullName -ne $expectedFile) { throw "$archiveName archive has an unexpected layout" }',
		"  [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entries[0], $outputPath, $false)",
		"} finally { $archive.Dispose() }",
	].join("; ")

	await runPowerShell(script)
}

export async function extractSingleFileTarXzArchive(
	archivePath: string,
	destination: string,
	expectedFile: string,
	archiveName: string,
): Promise<void> {
	const listing = await runProcess("tar", ["-tvJf", archivePath])
	const entries = listing.stdout
		.split(/\r?\n/)
		.map((entry) => entry.trim())
		.filter(Boolean)
	if (entries.length !== 1) {
		throw new Error(`${archiveName} archive has an unexpected layout`)
	}
	const archiveEntry = entries[0]
	const entryName = archiveEntry?.split(/\s+/).at(-1)
	if (
		!archiveEntry ||
		!entryName ||
		!archiveEntry.startsWith("-") ||
		entryName.replace(/^\.\//, "") !== expectedFile
	) {
		throw new Error(`${archiveName} archive has an unexpected layout`)
	}

	const args = ["-xJf", archivePath, "-C", destination, "--no-same-owner"]
	if (process.platform === "linux") {
		args.push("--no-overwrite-dir")
	}
	args.push(entryName)
	await runProcess("tar", args)
}
