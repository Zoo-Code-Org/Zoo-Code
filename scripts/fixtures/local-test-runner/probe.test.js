import fs from "node:fs"

const data = JSON.parse(fs.readFileSync(new URL("./runner-data.json", import.meta.url), "utf8"))
test("worker receives limit", () => expect(process.env.VITEST_MAX_WORKERS).toBe(String(data.workers)))
