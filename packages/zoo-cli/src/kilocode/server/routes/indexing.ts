import { lazy } from "@/util/lazy"
import { Hono } from "hono"

export const IndexingRoutes = lazy(() =>
	new Hono().get("/status", async (c) => {
		const mod = await import("@/kilocode/indexing")
		return c.json(await mod.KiloIndexing.current())
	}),
)
