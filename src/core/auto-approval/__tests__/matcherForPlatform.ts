// Shared harness for the two specs that pin down the allowlist matcher's
// platform-dependent behaviour: windowsPaths.spec.ts and posixPaths.spec.ts.
//
// Those are two files rather than two `describe` blocks because a platform can
// only be chosen once per file. `ignore` reads `process.platform` when it is
// imported, to install Windows-only path checks, and it lives in `node_modules`,
// which Vitest externalises: `vi.resetModules()` clears the module graph it
// transforms but hands back the same already-initialised `ignore`, patches and
// all. Verified rather than assumed: after resetting and re-importing under
// `linux`, the instance still converted backslashes in the candidate path, and
// was the very same module object.
//
// So whichever platform is in force at the first import wins for the rest of the
// file, and the second platform's tests would silently run against the first
// one's `ignore`.

type Matcher = typeof import("../filePatterns")

/**
 * Report `platform` as the one in use for the whole surrounding spec file, and
 * hand it a matcher module imported under that platform.
 *
 * The platform stays patched for the whole run, not just across the import,
 * because the matcher's own `isWindows` default reads it again on every call.
 *
 * @returns A getter, since the module can only be imported once the platform is
 * patched, which is inside `beforeAll` rather than at collection time.
 */
export function matcherForPlatform(platform: "win32" | "linux"): () => Matcher {
	const realPlatform = process.platform
	let matcher: Matcher | undefined

	beforeAll(async () => {
		Object.defineProperty(process, "platform", { value: platform, configurable: true })
		matcher = await import("../filePatterns")
	})

	afterAll(() => {
		Object.defineProperty(process, "platform", { value: realPlatform, configurable: true })
		matcher = undefined
	})

	return () => {
		if (!matcher) {
			throw new Error("The matcher is only available while the tests that asked for a platform run")
		}

		return matcher
	}
}
