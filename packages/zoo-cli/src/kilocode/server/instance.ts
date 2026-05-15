// kilocode_change - new file
// Registers all Kilo-specific instance routes on a Hono app.
// Called from ../../server/instance/index.ts before the UI fallback route.

import { Hono } from "hono"
import { TelemetryRoutes } from "../../server/routes/instance/telemetry"
import { CommitMessageRoutes } from "./routes/commit-message"
import { EnhancePromptRoutes } from "../../server/routes/instance/enhance-prompt"
import { KilocodeRoutes } from "../../server/routes/instance/kilocode"
import { PermissionKilocodeRoutes } from "../permission/routes"
import { RemoteRoutes } from "../../server/routes/instance/remote"
import { NetworkRoutes } from "../../server/routes/instance/network"
import { SuggestionRoutes } from "../suggestion/routes"
import { IndexingRoutes } from "./routes/indexing"

export function register(app: Hono): Hono {
	return app
		.route("/permission", PermissionKilocodeRoutes())
		.route("/network", NetworkRoutes())
		.route("/indexing", IndexingRoutes()) // kilocode_change
		.route("/suggestion", SuggestionRoutes())
		.route("/telemetry", TelemetryRoutes())
		.route("/remote", RemoteRoutes())
		.route("/commit-message", CommitMessageRoutes())
		.route("/enhance-prompt", EnhancePromptRoutes())
		.route("/kilocode", KilocodeRoutes())
}
