// Shared, declaration-only harness for the skills tests: the platform-agnostic path constants,
// the path helper and the real not-found error factory. The vi.hoisted mock functions and every
// vi.mock call stay in SkillsManager.spec.ts, because moving those would change when the mocks are
// created relative to vitest's hoisting rather than only where the declarations live.

import * as path from "path"

// Platform-agnostic test paths
// Use forward slashes for consistency, then normalize with path.normalize
const HOME_DIR = process.platform === "win32" ? "C:\\Users\\testuser" : "/home/user"
const PROJECT_DIR = process.platform === "win32" ? "C:\\test\\project" : "/test/project"
const SHARED_DIR = process.platform === "win32" ? "C:\\shared\\skills" : "/shared/skills"
// Helper to create platform-appropriate paths
const p = (...segments: string[]) => path.join(...segments)
// A real not-found error, as fs throws for a missing path or broken symlink
const enoent = () => Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
// Global roo directory - computed once
const GLOBAL_ROO_DIR = p(HOME_DIR, ".roo")
const GLOBAL_AGENTS_DIR = p(HOME_DIR, ".agents")

export { enoent, GLOBAL_AGENTS_DIR, GLOBAL_ROO_DIR, HOME_DIR, p, PROJECT_DIR, SHARED_DIR }
