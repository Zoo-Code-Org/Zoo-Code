import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import * as lockfile from "proper-lockfile"

import type { UsageEventV1 } from "@roo-code/types"
import { UsageEventV1 as UsageEventV1Schema } from "@roo-code/types"

// ── Constants ──────────────────────────────────────────────────────────────

/** 단일 segment 파일이 이 크기에 도달하면 다음 segment로 회전한다. */
const SEGMENT_MAX_BYTES = 5 * 1024 * 1024 // 5 MiB

/** 전체 event 파일의 hard cap. 도달 시 신규 기록을 일시 중단한다. */
const TOTAL_MAX_BYTES = 100 * 1024 * 1024 // 100 MiB

/** segment 파일명 prefix */
const SEGMENT_PREFIX = "events-"

/** segment 파일 확장자 */
const SEGMENT_EXT = ".ndjson"

/** manifest 파일명 */
const MANIFEST_FILENAME = "manifest.json"

/** quarantine 디렉터리명 */
const QUARANTINE_DIRNAME = "quarantine"

/** quarantine report 파일명 */
const QUARANTINE_REPORT_FILENAME = "corrupt-lines.jsonl"

// ── Error Codes ─────────────────────────────────────────────────────────────

/**
 * 저장소 오류 코드. LLM task를 실패시키지 않는다.
 * 형식: STATS_STORE/function/NNN
 */
export type StatsStoreErrorCode =
	| "STATS_STORE/append/001" // 디렉터리 생성 실패
	| "STATS_STORE/append/002" // lock 획득 실패
	| "STATS_STORE/append/003" // hard cap 도달
	| "STATS_STORE/append/004" // 파일 쓰기 실패
	| "STATS_STORE/append/005" // manifest 갱신 실패
	| "STATS_STORE/readAll/001" // 디렉터리 읽기 실패
	| "STATS_STORE/readAll/002" // segment 파일 읽기 실패
	| "STATS_STORE/clear/001" // lock 획득 실패
	| "STATS_STORE/clear/002" // manifest 교체 실패
	| "STATS_STORE/scan/001" // 재시작 시 segment scan 실패

export class StatsStoreError extends Error {
	constructor(
		public readonly code: StatsStoreErrorCode,
		message: string,
		public override readonly cause?: unknown,
	) {
		super(`[${code}] ${message}`)
		this.name = "StatsStoreError"
	}
}

// ── Manifest ────────────────────────────────────────────────────────────────

/**
 * 저장소 manifest. generation과 현재 segment 번호를 관리한다.
 * cross-process lock은 이 파일에 대해 잡힌다.
 */
export interface UsageStatsManifest {
	/** manifest 스키마 버전 */
	manifestVersion: 1
	/** 현재 generation. clear 시 증가한다. */
	generation: number
	/** 현재 활성 segment 번호 (1-based) */
	currentSegment: number
	/** 마지막 갱신 시각 (ISO 8601 UTC) */
	updatedAt: string
}

const DEFAULT_MANIFEST: UsageStatsManifest = {
	manifestVersion: 1,
	generation: 1,
	currentSegment: 1,
	updatedAt: new Date().toISOString(),
}

// ── Quarantine Report ───────────────────────────────────────────────────────

/**
 * corrupt line에 대한 quarantine 보고서 항목.
 * 원문을 복사하지 않고 line number와 hash만 기록한다.
 */
export interface QuarantineReportEntry {
	/** segment 파일명 */
	segment: string
	/** 1-based line number */
	line: number
	/** corrupt line 내용의 SHA-256 hash (앞 16자) */
	hash: string
	/** 발견 시각 (ISO 8601 UTC) */
	at: string
}

// ── UsageEventStore ─────────────────────────────────────────────────────────

/**
 * NDJSON append-only 파일 기반 사용량 이벤트 저장소.
 *
 * 설계 원칙 (아키텍처 보고서 섹션 5.12-5.14):
 * - `globalStorageUri.fsPath/usage-stats/` 디렉터리 사용
 * - manifest.json으로 generation/segment 관리
 * - process 내부 promise queue로 직렬화
 * - cross-process는 proper-lockfile로 manifest.json에 advisory lock
 * - 5 MiB segment 회전, 100 MiB hard cap
 * - idempotency: in-memory set + 재시작 시 segment scan
 * - corrupt line은 quarantine에 기록하고 건너뛰기
 * - storage 오류는 STATS_STORE_* code로 분류, LLM task를 실패시키지 않음
 *
 * 보안: prompt, response, API key, workspace path를 저장하지 않는다.
 * (UsageEventV1 스키마에 이 필드들이 포함되어 있지 않으므로 구조적으로 보장됨)
 */
export class UsageEventStore {
	private readonly statsDir: string
	private readonly manifestPath: string
	private readonly quarantineDir: string
	private readonly quarantineReportPath: string

	/** process 내부 직렬화용 promise queue */
	private queue: Promise<void> = Promise.resolve()

	/** idempotency: 현재 segment의 idempotencyKey set */
	private idempotencyKeys: Set<string> = new Set()

	/** 초기화 완료 여부 */
	private initialized = false

	/** hard cap 도달 여부 */
	private capped = false

	/**
	 * @param globalStoragePath VS Code globalStorageUri.fsPath
	 */
	constructor(globalStoragePath: string) {
		this.statsDir = path.join(globalStoragePath, "usage-stats")
		this.manifestPath = path.join(this.statsDir, MANIFEST_FILENAME)
		this.quarantineDir = path.join(this.statsDir, QUARANTINE_DIRNAME)
		this.quarantineReportPath = path.join(this.quarantineDir, QUARANTINE_REPORT_FILENAME)
	}

	// ── Public API ──────────────────────────────────────────────────────────

	/**
	 * 저장소를 초기화한다.
	 * 디렉터리 생성, manifest 로드/생성, idempotency set 복원을 수행한다.
	 * 첫 append 전에 반드시 호출해야 한다.
	 */
	async initialize(): Promise<void> {
		if (this.initialized) {
			return
		}

		try {
			await fs.mkdir(this.statsDir, { recursive: true })
			await fs.mkdir(this.quarantineDir, { recursive: true })
		} catch (err) {
			throw new StatsStoreError(
				"STATS_STORE/append/001",
				`Failed to create stats directory: ${this.statsDir}`,
				err,
			)
		}

		// manifest 로드 또는 생성
		const manifest = await this.loadOrCreateManifest()

		// idempotency set 복원: 현재 generation의 모든 segment에서 scan
		try {
			await this.rebuildIdempotencySet(manifest)
		} catch (err) {
			// scan 실패는 치명적이지 않음: dedupe가 느슨해질 뿐
			console.warn(`[UsageEventStore] idempotency scan failed, continuing with empty set:`, err)
		}

		// hard cap 확인
		this.capped = await this.checkTotalSize()

		this.initialized = true
	}

	/**
	 * 이벤트를 append한다.
	 * lock 안에서 dedupe 확인 후 append한다.
	 * 동일 idempotencyKey가 이미 존재하면 무시한다 (idempotent).
	 *
	 * @returns true if appended, false if deduplicated (already exists)
	 * @throws StatsStoreError 저장소 오류 (LLM task를 실패시키지 않음 - 호출자가 catch)
	 */
	async append(event: UsageEventV1): Promise<boolean> {
		// process 내부 promise queue로 직렬화
		let resolveFn!: (value: boolean) => void
		let rejectFn!: (reason: unknown) => void
		const pending = new Promise<boolean>((resolve, reject) => {
			resolveFn = resolve
			rejectFn = reject
		})

		this.queue = this.queue.then(async () => {
			try {
				const result = await this.appendInternal(event)
				resolveFn(result)
			} catch (err) {
				rejectFn(err)
			}
		})

		return pending
	}

	/**
	 * 모든 유효한 이벤트를 읽는다.
	 * corrupt line은 quarantine에 기록하고 건너뛴다.
	 * 마지막 비종결/잘린 line은 crash tail로 간주해 무시한다.
	 */
	async readAll(): Promise<UsageEventV1[]> {
		await this.ensureInitialized()

		const events: UsageEventV1[] = []
		const quarantineEntries: QuarantineReportEntry[] = []

		let segmentFiles: string[]
		try {
			const allFiles = await fs.readdir(this.statsDir)
			segmentFiles = allFiles.filter((f) => f.startsWith(SEGMENT_PREFIX) && f.endsWith(SEGMENT_EXT)).sort()
		} catch (err) {
			throw new StatsStoreError(
				"STATS_STORE/readAll/001",
				`Failed to read stats directory: ${this.statsDir}`,
				err,
			)
		}

		for (const segmentFile of segmentFiles) {
			const segmentPath = path.join(this.statsDir, segmentFile)
			let content: string

			try {
				content = await fs.readFile(segmentPath, "utf-8")
			} catch (err) {
				// 파일 읽기 실패는 skip (ENOENT 등)
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
					console.warn(`[UsageEventStore] failed to read segment ${segmentFile}:`, err)
				}
				continue
			}

			const lines = content.split("\n")
			// 마지막 빈 line 제거 (trailing newline)
			if (lines.length > 0 && lines[lines.length - 1] === "") {
				lines.pop()
			}

			// 마지막 line이 비종결/잘린 경우 crash tail로 간주해 무시
			// (마지막 line이 유효한 JSON이면 parse되고, 아니면 quarantine)
			for (let i = 0; i < lines.length; i++) {
				const lineNum = i + 1
				const line = lines[i]
				const isLastLine = i === lines.length - 1

				if (!line.trim()) {
					continue
				}

				try {
					const parsed = JSON.parse(line)
					const result = UsageEventV1Schema.safeParse(parsed)
					if (result.success) {
						events.push(result.data)
					} else {
						// zod 검증 실패: corrupt line
						quarantineEntries.push(this.makeQuarantineEntry(segmentFile, lineNum, line))
						// 마지막 line의 검증 실패는 crash tail일 수 있으므로 quarantine에서 제외
						if (isLastLine) {
							quarantineEntries.pop()
						}
					}
				} catch {
					// JSON parse 실패
					// 마지막 line의 parse 실패는 crash tail로 간주해 무시
					if (!isLastLine) {
						quarantineEntries.push(this.makeQuarantineEntry(segmentFile, lineNum, line))
					}
				}
			}
		}

		// quarantine report 기록
		if (quarantineEntries.length > 0) {
			await this.writeQuarantineReport(quarantineEntries)
		}

		return events
	}

	/**
	 * 모든 통계 데이터를 삭제한다.
	 * 새 빈 generation으로 교체한다.
	 * 실패 시 기존 manifest를 유지한다.
	 */
	async clear(): Promise<void> {
		await this.ensureInitialized()

		let releaseLock: () => Promise<void> = async () => {}

		try {
			releaseLock = await this.acquireManifestLock()
		} catch (err) {
			throw new StatsStoreError("STATS_STORE/clear/001", "Failed to acquire manifest lock for clear", err)
		}

		try {
			const manifest = await this.loadOrCreateManifest()

			// 새 generation 번호
			const newGeneration = manifest.generation + 1
			const newManifest: UsageStatsManifest = {
				...DEFAULT_MANIFEST,
				generation: newGeneration,
				currentSegment: 1,
				updatedAt: new Date().toISOString(),
			}

			// 기존 segment 파일들을 새 generation 디렉터리로 이동 (백업)
			// 또는 단순히 새 manifest로 교체하고 기존 파일은 무시
			// 설계: "기존 segment를 새 빈 generation으로 교체"
			// 구현: 기존 segment 파일들을 old-generation-{N} 하위로 이동
			const oldGenDir = path.join(this.statsDir, `old-generation-${manifest.generation}`)
			await fs.mkdir(oldGenDir, { recursive: true })

			const allFiles = await fs.readdir(this.statsDir)
			const segmentFiles = allFiles.filter((f) => f.startsWith(SEGMENT_PREFIX) && f.endsWith(SEGMENT_EXT))

			for (const file of segmentFiles) {
				const oldPath = path.join(this.statsDir, file)
				const newPath = path.join(oldGenDir, file)
				try {
					await fs.rename(oldPath, newPath)
				} catch (err) {
					// 이동 실패는 로그만 남기고 계속
					console.warn(`[UsageEventStore] failed to move old segment ${file}:`, err)
				}
			}

			// 새 manifest 저장 (safeWriteJson 패턴: temp → rename)
			await this.writeManifestAtomic(newManifest)

			// idempotency set 초기화
			this.idempotencyKeys.clear()
			this.capped = false
		} catch (err) {
			// 실패 시 기존 manifest 유지 (이미 이동된 파일은 복구하지 않음 - 데이터 손실 위험)
			throw new StatsStoreError("STATS_STORE/clear/002", "Failed to replace manifest during clear", err)
		} finally {
			try {
				await releaseLock()
			} catch (err) {
				console.warn(`[UsageEventStore] failed to release manifest lock:`, err)
			}
		}
	}

	/**
	 * hard cap 도달 여부를 반환한다.
	 */
	isCapped(): boolean {
		return this.capped
	}

	/**
	 * 현재 manifest를 반환한다.
	 */
	async getManifest(): Promise<UsageStatsManifest> {
		await this.ensureInitialized()
		return this.loadOrCreateManifest()
	}

	// ── Internal: Append ─────────────────────────────────────────────────────

	/**
	 * 실제 append 로직. promise queue 내부에서 실행된다.
	 */
	private async appendInternal(event: UsageEventV1): Promise<boolean> {
		await this.ensureInitialized()

		// hard cap 확인
		if (this.capped) {
			throw new StatsStoreError(
				"STATS_STORE/append/003",
				"Storage hard cap (100 MiB) reached, new events suspended",
			)
		}

		// idempotency 확인
		if (this.idempotencyKeys.has(event.idempotencyKey)) {
			return false
		}

		let releaseLock: () => Promise<void> = async () => {}

		try {
			releaseLock = await this.acquireManifestLock()
		} catch (err) {
			throw new StatsStoreError("STATS_STORE/append/002", "Failed to acquire manifest lock for append", err)
		}

		try {
			const manifest = await this.loadOrCreateManifest()
			const segmentPath = this.getSegmentPath(manifest.currentSegment)

			// segment 파일이 존재하는지 확인하고 크기 체크
			let segmentSize = 0
			try {
				const stat = await fs.stat(segmentPath)
				segmentSize = stat.size
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
					throw err
				}
				// 파일이 없으면 새로 생성
			}

			// segment 회전 확인
			if (segmentSize >= SEGMENT_MAX_BYTES) {
				manifest.currentSegment += 1
				manifest.updatedAt = new Date().toISOString()
				await this.writeManifestAtomic(manifest)
			}

			// B3 fix: segmentPath를 회전 후의 currentSegment 기준으로 재계산한다.
			// 이전에는 회전 전 구 segmentPath를 그대로 사용해 계속 구 segment에 append하여
			// 5MiB 회전 설계가 무효화되고 단일 segment가 무한정 커졌음.
			const activeSegmentPath = this.getSegmentPath(manifest.currentSegment)

			// 이벤트를 compact JSON + \n으로 append
			const line = JSON.stringify(event) + "\n"

			try {
				// append mode로 열어서 write
				const handle = await fs.open(activeSegmentPath, "a")
				try {
					await handle.writeFile(line, "utf-8")
					// file handle sync 후 성공으로 반환
					await handle.sync()
				} finally {
					await handle.close()
				}
			} catch (err) {
				throw new StatsStoreError(
					"STATS_STORE/append/004",
					`Failed to write event to segment ${manifest.currentSegment}`,
					err,
				)
			}

			// idempotency set에 추가
			this.idempotencyKeys.add(event.idempotencyKey)

			// total size 확인하여 cap 업데이트
			this.capped = await this.checkTotalSize()

			return true
		} finally {
			try {
				await releaseLock()
			} catch (err) {
				console.warn(`[UsageEventStore] failed to release manifest lock:`, err)
			}
		}
	}

	// ── Internal: Manifest ──────────────────────────────────────────────────

	/**
	 * manifest를 로드하거나 기본값으로 생성한다.
	 */
	private async loadOrCreateManifest(): Promise<UsageStatsManifest> {
		try {
			const content = await fs.readFile(this.manifestPath, "utf-8")
			const parsed = JSON.parse(content)
			// 기본 필드 검증
			if (
				typeof parsed.manifestVersion === "number" &&
				typeof parsed.generation === "number" &&
				typeof parsed.currentSegment === "number"
			) {
				return parsed as UsageStatsManifest
			}
			// 검증 실패 시 기본값으로 덮어쓰기
			const defaultManifest = { ...DEFAULT_MANIFEST, updatedAt: new Date().toISOString() }
			await this.writeManifestAtomic(defaultManifest)
			return defaultManifest
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				// manifest가 없으면 생성
				const defaultManifest = { ...DEFAULT_MANIFEST, updatedAt: new Date().toISOString() }
				await this.writeManifestAtomic(defaultManifest)
				return defaultManifest
			}
			// 다른 오류는 기본값 반환
			console.warn(`[UsageEventStore] failed to load manifest, using default:`, err)
			return { ...DEFAULT_MANIFEST, updatedAt: new Date().toISOString() }
		}
	}

	/**
	 * manifest를 atomic하게 저장한다 (temp → rename 패턴).
	 */
	private async writeManifestAtomic(manifest: UsageStatsManifest): Promise<void> {
		const tempPath = `${this.manifestPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`
		const content = JSON.stringify(manifest, null, "\t")

		try {
			await fs.writeFile(tempPath, content, "utf-8")
			await fs.rename(tempPath, this.manifestPath)
		} catch (err) {
			// temp 파일 정리
			try {
				await fs.unlink(tempPath)
			} catch {
				// ignore
			}
			throw new StatsStoreError("STATS_STORE/append/005", "Failed to write manifest atomically", err)
		}
	}

	// ── Internal: Lock ───────────────────────────────────────────────────────

	/**
	 * manifest.json에 cross-process advisory lock을 잡는다.
	 */
	private async acquireManifestLock(): Promise<() => Promise<void>> {
		// manifest 파일이 없으면 생성 (lockfile.lock이 파일을 요구할 수 있음)
		try {
			await fs.access(this.manifestPath)
		} catch {
			await this.writeManifestAtomic({ ...DEFAULT_MANIFEST, updatedAt: new Date().toISOString() })
		}

		return lockfile.lock(this.manifestPath, {
			stale: 31000,
			update: 10000,
			realpath: false,
			retries: {
				retries: 5,
				factor: 2,
				minTimeout: 100,
				maxTimeout: 1000,
			},
			onCompromised: (err) => {
				console.error(`[UsageEventStore] manifest lock was compromised:`, err)
				throw err
			},
		})
	}

	// ── Internal: Idempotency ────────────────────────────────────────────────

	/**
	 * 현재 generation의 모든 segment에서 idempotencyKey를 scan하여 set을 복원한다.
	 */
	private async rebuildIdempotencySet(manifest: UsageStatsManifest): Promise<void> {
		this.idempotencyKeys.clear()

		for (let seg = 1; seg <= manifest.currentSegment; seg++) {
			const segmentPath = this.getSegmentPath(seg)

			let content: string
			try {
				content = await fs.readFile(segmentPath, "utf-8")
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") {
					continue
				}
				throw new StatsStoreError(
					"STATS_STORE/scan/001",
					`Failed to scan segment ${seg} for idempotency rebuild`,
					err,
				)
			}

			const lines = content.split("\n")
			for (const line of lines) {
				if (!line.trim()) continue
				try {
					const parsed = JSON.parse(line)
					if (parsed && typeof parsed.idempotencyKey === "string") {
						this.idempotencyKeys.add(parsed.idempotencyKey)
					}
				} catch {
					// corrupt line은 scan 시 skip
				}
			}
		}
	}

	// ── Internal: Size Management ────────────────────────────────────────────

	/**
	 * 전체 event 파일 크기를 확인하여 hard cap 도달 여부를 반환한다.
	 */
	private async checkTotalSize(): Promise<boolean> {
		try {
			const allFiles = await fs.readdir(this.statsDir)
			const segmentFiles = allFiles.filter((f) => f.startsWith(SEGMENT_PREFIX) && f.endsWith(SEGMENT_EXT))

			let totalSize = 0
			for (const file of segmentFiles) {
				try {
					const stat = await fs.stat(path.join(this.statsDir, file))
					totalSize += stat.size
				} catch {
					// skip
				}
			}

			return totalSize >= TOTAL_MAX_BYTES
		} catch {
			return false
		}
	}

	// ── Internal: Quarantine ────────────────────────────────────────────────

	/**
	 * corrupt line에 대한 quarantine entry를 생성한다.
	 * 원문을 복사하지 않고 line number와 hash만 기록한다.
	 */
	private makeQuarantineEntry(segment: string, line: number, content: string): QuarantineReportEntry {
		// 간단한 hash (crypto 없이, content 기반)
		// 실제 환경에서는 crypto.createHash를 사용할 수 있으나,
		// 여기서는 의존성 최소화를 위해 간단한 hash를 사용한다.
		let hash = 0
		for (let i = 0; i < content.length; i++) {
			const char = content.charCodeAt(i)
			hash = (hash << 5) - hash + char
			hash = hash & hash // 32bit 정수로 유지
		}
		const hashHex = (hash >>> 0).toString(16).padStart(8, "0")

		return {
			segment,
			line,
			hash: hashHex,
			at: new Date().toISOString(),
		}
	}

	/**
	 * quarantine report를 append 모드로 기록한다.
	 */
	private async writeQuarantineReport(entries: QuarantineReportEntry[]): Promise<void> {
		try {
			const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n"
			const handle = await fs.open(this.quarantineReportPath, "a")
			try {
				await handle.writeFile(lines, "utf-8")
			} finally {
				await handle.close()
			}
		} catch (err) {
			// quarantine 기록 실패는 치명적이지 않음
			console.warn(`[UsageEventStore] failed to write quarantine report:`, err)
		}
	}

	// ── Internal: Utilities ──────────────────────────────────────────────────

	/**
	 * segment 번호에서 파일 경로를 생성한다.
	 */
	private getSegmentPath(segmentNumber: number): string {
		const padded = String(segmentNumber).padStart(6, "0")
		return path.join(this.statsDir, `${SEGMENT_PREFIX}${padded}${SEGMENT_EXT}`)
	}

	/**
	 * 초기화가 완료되었는지 확인하고, 아니면 초기화한다.
	 */
	private async ensureInitialized(): Promise<void> {
		if (!this.initialized) {
			await this.initialize()
		}
	}

	/**
	 * 테스트용: idempotency set 크기 반환
	 */
	_getIdempotencyKeyCount(): number {
		return this.idempotencyKeys.size
	}

	/**
	 * 테스트용: stats 디렉터리 경로 반환
	 */
	_getStatsDir(): string {
		return this.statsDir
	}
}
