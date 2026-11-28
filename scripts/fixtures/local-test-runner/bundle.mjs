import fs from "node:fs"

fs.writeFileSync(new URL("./bundle-ready", import.meta.url), "ready")
