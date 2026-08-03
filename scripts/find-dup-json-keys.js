// Detect duplicate keys within the same object in JSON files (merge debris).
// Usage: node find-dup-json-keys.js <file-or-dir> [...]
const fs = require("fs")
const path = require("path")

function* walk(target) {
	const stat = fs.statSync(target)
	if (stat.isDirectory()) {
		for (const entry of fs.readdirSync(target)) {
			yield* walk(path.join(target, entry))
		}
	} else if (target.endsWith(".json")) {
		yield target
	}
}

// Minimal JSON scanner that tracks the key stack and reports duplicate
// sibling keys with their line numbers. Strings/escapes handled.
function findDuplicates(text) {
	const dups = []
	const stack = [] // each frame: { keys: Set<string>, isArray: bool }
	let i = 0
	const n = text.length
	let line = 1

	const readString = () => {
		// assumes text[i] === '"'
		i++
		let out = ""
		while (i < n) {
			const c = text[i]
			if (c === "\\") {
				out += text.slice(i, i + 2)
				i += 2
				continue
			}
			if (c === '"') {
				i++
				return out
			}
			out += c
			i++
		}
		throw new Error("unterminated string")
	}

	const skipWs = () => {
		while (i < n) {
			const c = text[i]
			if (c === "\n") line++
			if (c === " " || c === "\t" || c === "\r" || c === "\n") i++
			else break
		}
	}

	const skipValue = () => {
		skipWs()
		const c = text[i]
		if (c === '"') {
			readString()
			return
		}
		if (c === "{") {
			parseObject()
			return
		}
		if (c === "[") {
			parseArray()
			return
		}
		// number / true / false / null
		while (i < n && !",}] \t\r\n".includes(text[i])) i++
	}

	const parseObject = () => {
		// text[i] === '{'
		i++
		stack.push({ keys: new Set(), isArray: false })
		skipWs()
		if (text[i] === "}") {
			i++
			stack.pop()
			return
		}
		while (i < n) {
			skipWs()
			const keyLine = line
			const key = readString()
			const frame = stack[stack.length - 1]
			if (frame.keys.has(key)) {
				dups.push({ key, line: keyLine })
			} else {
				frame.keys.add(key)
			}
			skipWs()
			// expect ':'
			i++
			skipValue()
			skipWs()
			if (text[i] === ",") {
				i++
				continue
			}
			if (text[i] === "}") {
				i++
				stack.pop()
				return
			}
			throw new Error(`unexpected char ${text[i]} at line ${line}`)
		}
	}

	const parseArray = () => {
		i++
		skipWs()
		if (text[i] === "]") {
			i++
			return
		}
		while (i < n) {
			skipValue()
			skipWs()
			if (text[i] === ",") {
				i++
				continue
			}
			if (text[i] === "]") {
				i++
				return
			}
			throw new Error(`unexpected char ${text[i]} at line ${line}`)
		}
	}

	skipWs()
	if (text[i] === "{") parseObject()
	else skipValue()
	return dups
}

let found = 0
for (const target of process.argv.slice(2)) {
	for (const file of walk(target)) {
		const text = fs.readFileSync(file, "utf8")
		let dups
		try {
			dups = findDuplicates(text)
		} catch (e) {
			console.log(`${file}: PARSE ERROR ${e.message}`)
			found++
			continue
		}
		for (const d of dups) {
			console.log(`${file}: duplicate key "${d.key}" at line ${d.line}`)
			found++
		}
	}
}
console.log(found === 0 ? "OK: no duplicate keys found" : `TOTAL: ${found} duplicate key occurrence(s)`)
process.exit(found === 0 ? 0 : 1)
