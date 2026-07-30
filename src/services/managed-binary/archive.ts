import { spawn } from "child_process"
import * as path from "path"

export interface ProcessResult {
	stdout: string
	stderr: string
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

export function escapePowerShellLiteral(value: string): string {
	return value.replace(/'/g, "''")
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
		await runProcess("powershell", [
			"-NoProfile",
			"-Command",
			`Expand-Archive -Path '${escapePowerShellLiteral(archivePath)}' -DestinationPath '${escapePowerShellLiteral(destination)}' -Force`,
		])
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
	const outputPath = path.join(destination, expectedFile)
	const script = [
		"$ErrorActionPreference = 'Stop'",
		"Add-Type -AssemblyName System.IO.Compression.FileSystem",
		`$archive = [System.IO.Compression.ZipFile]::OpenRead('${escapePowerShellLiteral(archivePath)}')`,
		"try {",
		"  $entries = @($archive.Entries | Where-Object { -not [string]::IsNullOrEmpty($_.Name) })",
		`  if ($entries.Count -ne 1 -or $entries[0].FullName -ne '${escapePowerShellLiteral(expectedFile)}') { throw '${escapePowerShellLiteral(archiveName)} archive has an unexpected layout' }`,
		`  [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entries[0], '${escapePowerShellLiteral(outputPath)}', $false)`,
		"} finally { $archive.Dispose() }",
	].join("; ")

	await runProcess("powershell", ["-NoProfile", "-NonInteractive", "-Command", script])
}

export async function extractSingleFileTarXzArchive(
	archivePath: string,
	destination: string,
	expectedFile: string,
	archiveName: string,
): Promise<void> {
	const listing = await runProcess("tar", ["-tJf", archivePath])
	const entries = listing.stdout
		.split(/\r?\n/)
		.map((entry) => entry.trim().replace(/^\.\//, ""))
		.filter(Boolean)
	if (entries.length !== 1 || entries[0] !== expectedFile) {
		throw new Error(`${archiveName} archive has an unexpected layout`)
	}

	await runProcess("tar", ["-xJf", archivePath, "-C", destination, expectedFile])
}
