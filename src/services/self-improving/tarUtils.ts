import * as fs from "fs/promises"
import * as fsSync from "fs"
import { createGzip, createGunzip } from "zlib"
import { pipeline } from "stream/promises"
import { Readable, Writable } from "stream"
import * as path from "path"

/**
 * Tar entry in memory: relative path + buffer content.
 */
export interface TarEntry {
	path: string
	content: Buffer
}

/**
 * Create a tar.gz file from an array of in-memory entries.
 *
 * tar format (no external libs):
 * - Each file: 512-byte header + padded content (padded to 512 multiple)
 * - End: two 512-byte zero blocks
 * - gzip compressed
 *
 * @param entries Array of {path, content} objects
 * @param outputPath File path for the .tar.gz output
 */
export async function createTarGzip(
	entries: Array<{ path: string; content: Buffer }>,
	outputPath: string,
): Promise<void> {
	// Build tar buffer
	const blocks: Buffer[] = []

	for (const entry of entries) {
		const header = buildTarHeader(entry.path, entry.content.length)
		blocks.push(header)
		blocks.push(entry.content)

		// Pad content to 512-byte boundary
		const padLen = (512 - (entry.content.length % 512)) % 512
		if (padLen > 0) {
			blocks.push(Buffer.alloc(padLen, 0))
		}
	}

	// Two 512-byte zero blocks at end
	blocks.push(Buffer.alloc(1024, 0))

	const tarBuffer = Buffer.concat(blocks)

	// gzip it and write
	const gzip = createGzip()
	const source = Readable.from([tarBuffer])
	const dest = fsSync.createWriteStream(outputPath)

	await pipeline(source, gzip, dest)
}

/**
 * Extract a tar.gz file into a target directory.
 *
 * @param archivePath Path to .tar.gz file
 * @param targetDir Directory to extract into (will be created)
 */
export async function extractTarGzip(archivePath: string, targetDir: string): Promise<void> {
	await fs.mkdir(targetDir, { recursive: true })

	// Read and decompress
	const compressed = await fs.readFile(archivePath)
	const gunzip = createGunzip()
	const chunks: Buffer[] = []

	// Decompress
	const readable = Readable.from([compressed])
	const writable = new Writable({
		write(chunk: Buffer, _encoding, callback) {
			chunks.push(chunk)
			callback()
		},
	})

	await pipeline(readable, gunzip, writable)

	const tarData = Buffer.concat(chunks)

	// Parse tar and extract files
	let offset = 0
	while (offset + 512 <= tarData.length) {
		const header = tarData.subarray(offset, offset + 512)
		offset += 512

		// Check for end-of-archive (all zeros)
		if (header[0] === 0) {
			break
		}

		// Parse file size from header (octal at bytes 124-135)
		const sizeStr = header.toString("ascii", 124, 136).replace(/\0/g, "").trim()
		const fileSize = parseInt(sizeStr, 8)
		if (isNaN(fileSize)) {
			break
		}

		// Parse file name
		const nameStr = header.toString("ascii", 0, 100).replace(/\0/g, "").trim()
		if (!nameStr) {
			break
		}

		// Get file content
		const content = tarData.subarray(offset, offset + fileSize)
		offset += fileSize

		// Skip padding
		const padLen = (512 - (fileSize % 512)) % 512
		offset += padLen

		// Resolve target path
		const targetPath = path.join(targetDir, nameStr)

		// Ensure parent dir exists
		await fs.mkdir(path.dirname(targetPath), { recursive: true })

		// Write file
		await fs.writeFile(targetPath, content)
	}
}

/**
 * Build a 512-byte tar header block for a file.
 * POSIX ustar format subset.
 */
function buildTarHeader(name: string, size: number): Buffer {
	const buf = Buffer.alloc(512, 0)

	// File name (100 bytes) — truncate if too long
	const nameBytes = Buffer.from(name, "ascii")
	if (nameBytes.length > 99) {
		nameBytes.copy(buf, 0, 0, 99)
	} else {
		nameBytes.copy(buf, 0)
	}

	// File mode (8 bytes, octal)
	buf.write("0000644", 100, 8, "ascii")

	// Owner UID (8 bytes, octal)
	buf.write("0000000", 108, 8, "ascii")

	// Group GID (8 bytes, octal)
	buf.write("0000000", 116, 8, "ascii")

	// File size (12 bytes, octal)
	const sizeOctal = size.toString(8).padStart(11, "0")
	buf.write(sizeOctal, 124, 12, "ascii")

	// Mtime (12 bytes, octal)
	const mtime = Math.floor(Date.now() / 1000)
		.toString(8)
		.padStart(11, "0")
	buf.write(mtime, 136, 12, "ascii")

	// Checksum placeholder (8 bytes of spaces)
	buf.write("        ", 148, 8, "ascii")

	// Type flag: '0' = regular file
	buf[156] = "0".charCodeAt(0)

	// Ustar indicator
	buf.write("ustar", 257, 5, "ascii")
	buf.write("00", 263, 2, "ascii")

	// Calculate and write checksum
	let checksum = 0
	for (let i = 0; i < 512; i++) {
		checksum += buf[i]
	}
	const checksumOctal = checksum.toString(8).padStart(6, "0")
	buf.write(checksumOctal, 148, 7, "ascii")
	buf[155] = 0x20 // trailing space in checksum field

	return buf
}
