import fs from "node:fs"

export default (project) => {
	if (!fs.existsSync(new URL("./bundle-ready", import.meta.url))) throw new Error("Tests started before bundling")
	const data = JSON.parse(fs.readFileSync(new URL("./runner-data.json", import.meta.url), "utf8"))
	fs.writeFileSync(
		data.output,
		JSON.stringify({
			workers: project.config.maxWorkers,
			isolate: project.config.isolate,
			value: process.env.VITEST_MAX_WORKERS,
		}),
	)
}
