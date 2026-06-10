import type { JWTInput } from "google-auth-library"

import { looksLikeFilePath } from "@roo-code/types"
import { safeJsonParse } from "@roo-code/core"

// Detects when the "Google Cloud Credentials" field has received a filesystem
// path instead of the raw JSON contents of a service-account key file. Users
// often confuse this with GOOGLE_APPLICATION_CREDENTIALS (which IS a path),
// and the sibling "Google Cloud Key File Path" field is where a path belongs.
// Returns the parsed credentials object when the input looks like JSON, or
// undefined when the field is empty, path-shaped, or unparseable.
//
// The path-shape predicate is shared with the webview UI warning via
// @roo-code/types/looksLikeFilePath so both surfaces stay in agreement.
export function parseVertexJsonCredentials(value: string | undefined): JWTInput | undefined {
	const trimmed = value?.trim()
	if (!trimmed) {
		return undefined
	}

	if (looksLikeFilePath(trimmed)) {
		// Intentionally static — the user's actual value is not interpolated
		// into the warning so usernames and directory names don't leak into
		// extension logs. The message still identifies the correct field and
		// the env var fallback.
		console.warn(
			"[Vertex] The 'Google Cloud Credentials' field appears to contain a file path, " +
				"but this field expects the raw JSON contents of a service-account key file. " +
				"If you have a path to the credentials file, paste it into the 'Google Cloud Key File Path' field instead, " +
				"or leave both fields empty and use the GOOGLE_APPLICATION_CREDENTIALS environment variable.",
		)
		return undefined
	}

	return safeJsonParse<JWTInput>(trimmed, undefined, "Vertex credentials")
}
