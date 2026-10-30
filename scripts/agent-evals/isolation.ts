import path from "node:path"

// Inherit only host-launch necessities, never the credential-bearing parent environment.
export function buildChildEnvironment(
	env: NodeJS.ProcessEnv,
	isolatedHome: string,
	socketPath: string,
): NodeJS.ProcessEnv {
	const child: NodeJS.ProcessEnv = {}
	for (const name of ["PATH", "DISPLAY", "XAUTHORITY", "LANG", "LC_ALL", "TMPDIR", "SYSTEMROOT", "WINDIR"])
		if (env[name]) child[name] = env[name]
	return {
		...child,
		HOME: isolatedHome,
		USERPROFILE: isolatedHome,
		XDG_CONFIG_HOME: path.join(isolatedHome, ".config"),
		XDG_CACHE_HOME: path.join(isolatedHome, ".cache"),
		ROO_CODE_IPC_SOCKET_PATH: socketPath,
	}
}

export function buildLaunchArgs(workspace: string, userData: string, extensions: string, extension: string): string[] {
	return [
		workspace,
		`--user-data-dir=${userData}`,
		`--extensions-dir=${extensions}`,
		`--extensionDevelopmentPath=${extension}`,
		"--no-sandbox",
		"--disable-gpu-sandbox",
		"--password-store=basic",
		"--disable-updates",
		"--skip-welcome",
		"--skip-release-notes",
		"--disable-workspace-trust",
	]
}
