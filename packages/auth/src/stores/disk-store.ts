import { createHash, randomBytes } from "node:crypto";
import {
	chmod,
	link,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { McpOAuthConfigError } from "../mcp-oauth.errors.ts";
import type {
	McpOAuthStore,
	McpOAuthStoreMaintenance,
	McpOAuthStoreWriteOptions,
} from "./store.types.ts";

export interface McpDiskOAuthStoreOptions {
	/** Directory that holds the store's files. Created 0700 if absent. */
	readonly directory: string;
	/** Interval between background sweeps; disabled when `now` is injected (tests). */
	readonly sweepIntervalMs?: number;
	/** Grace period before a crash-orphaned staging file is reclaimed. */
	readonly orphanGraceMs?: number;
	readonly now?: () => number;
}

interface DiskRecord {
	readonly value: string;
	readonly expiresAt: number;
}

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_ORPHAN_GRACE_MS = 300_000;

/**
 * Filesystem-backed store for single-node persistence. Values should already be
 * encrypted (compose with {@link withEncryptedValues}) — this layer adds no
 * confidentiality. Files are created owner-only in an owner-only directory.
 * Keys are hashed into filenames (path-traversal- and collision-safe). Every
 * artifact becomes visible only once fully written, and `take`/`setIfAbsent`
 * are single-winner across processes via `rename`/`link`.
 */
export class McpDiskOAuthStore implements McpOAuthStore, McpOAuthStoreMaintenance {
	readonly #directory: string;
	readonly #now: () => number;
	readonly #orphanGraceMs: number;
	/** Serializes setIfAbsent per key within this process; cross-process safety rests on `link`. */
	readonly #locks = new Map<string, Promise<unknown>>();
	#ready: Promise<void> | undefined;
	#sweepTimer: ReturnType<typeof setInterval> | undefined;

	constructor(options: McpDiskOAuthStoreOptions) {
		if (typeof options.directory !== "string" || options.directory.length === 0) {
			throw new McpOAuthConfigError("INVALID_OPTIONS", "McpDiskOAuthStore requires a directory.");
		}
		this.#directory = options.directory;
		this.#now = options.now ?? Date.now;
		this.#orphanGraceMs = options.orphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS;
		// A test that injects a clock opts out of the wall-clock background sweep.
		if (options.now === undefined) {
			this.#sweepTimer = setInterval(
				() => void this.sweep().catch(() => undefined),
				options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS,
			);
			this.#sweepTimer.unref?.();
		}
	}

	async get(key: string): Promise<string | undefined> {
		await this.#ensureDir();
		const path = this.#path(key);
		const record = await readRecord(path);
		if (record === undefined || record.value === undefined) return undefined;
		if (record.value.expiresAt <= this.#now()) {
			await rm(path, { force: true });
			return undefined;
		}
		return record.value.value;
	}

	async set(key: string, value: string, options: McpOAuthStoreWriteOptions): Promise<void> {
		assertTtl(options);
		await this.#ensureDir();
		await this.#writeAtomic(this.#path(key), {
			value,
			expiresAt: this.#now() + options.ttlSeconds * 1_000,
		});
	}

	async setIfAbsent(
		key: string,
		value: string,
		options: McpOAuthStoreWriteOptions,
	): Promise<boolean> {
		assertTtl(options);
		await this.#ensureDir();
		// Serialize same-key writers in this process so concurrent callers cannot
		// each observe an empty path; cross-process, `link` remains the atomic gate.
		return this.#withKeyLock(key, async () => {
			const path = this.#path(key);
			const temp = `${path}.tmp-${randomBytes(8).toString("hex")}`;
			await writeFile(
				temp,
				JSON.stringify({ value, expiresAt: this.#now() + options.ttlSeconds * 1_000 }),
				{ mode: FILE_MODE },
			);
			try {
				// `link` fails EEXIST rather than clobbering, and the file is complete
				// the instant it becomes visible — no racer can observe a partial file.
				await link(temp, path);
				return true;
			} catch (error) {
				if (!isErrno(error, "EEXIST")) throw error;
				// An occupant exists. Only replace it if it is actually expired/corrupt,
				// and never move a live record aside (which would open a claim window).
				const occupant = await readRecord(path);
				const live = occupant?.value !== undefined && occupant.value.expiresAt > this.#now();
				if (live) return false;
				await rm(path, { force: true });
				try {
					await link(temp, path);
					return true;
				} catch (retryError) {
					if (isErrno(retryError, "EEXIST")) return false; // a concurrent writer won
					throw retryError;
				}
			} finally {
				await rm(temp, { force: true });
			}
		});
	}

	#withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const prior = this.#locks.get(key) ?? Promise.resolve();
		const run = prior.then(fn, fn);
		const tail = run.then(
			() => undefined,
			() => undefined,
		);
		this.#locks.set(key, tail);
		void tail.then(() => {
			// Drop the map entry once this call is the tail of the chain.
			if (this.#locks.get(key) === tail) this.#locks.delete(key);
		});
		return run;
	}

	async take(key: string): Promise<string | undefined> {
		await this.#ensureDir();
		const path = this.#path(key);
		const claimed = `${path}.taking-${randomBytes(8).toString("hex")}`;
		try {
			await rename(path, claimed);
		} catch (error) {
			if (isErrno(error, "ENOENT")) return undefined; // already taken or never existed
			throw error;
		}
		try {
			const record = await readRecord(claimed);
			if (record?.value === undefined || record.value.expiresAt <= this.#now()) return undefined;
			return record.value.value;
		} finally {
			await rm(claimed, { force: true });
		}
	}

	async delete(key: string): Promise<void> {
		await rm(this.#path(key), { force: true });
	}

	async sweep(): Promise<void> {
		await this.#ensureDir();
		let entries: string[];
		try {
			entries = await readdir(this.#directory);
		} catch {
			return;
		}
		const now = this.#now();
		await Promise.all(
			entries.map(async (name) => {
				const path = join(this.#directory, name);
				if (name.endsWith(".rec")) {
					const record = await readRecord(path);
					if (record === undefined || record.value === undefined || record.value.expiresAt <= now) {
						await rm(path, { force: true });
					}
					return;
				}
				// Reclaim crash-orphaned staging files by age, never immediately (a
				// concurrent take/set may still hold one between its rename and read).
				if (name.includes(".rec.tmp-") || name.includes(".rec.taking-")) {
					try {
						const info = await stat(path);
						if (now - info.mtimeMs > this.#orphanGraceMs) await rm(path, { force: true });
					} catch {
						// Raced with its owner's cleanup; nothing to do.
					}
				}
			}),
		);
	}

	/** Stops the background sweep timer. Records remain readable until expiry. */
	close(): void {
		if (this.#sweepTimer !== undefined) clearInterval(this.#sweepTimer);
		this.#sweepTimer = undefined;
	}

	#ensureDir(): Promise<void> {
		this.#ready ??= mkdir(this.#directory, { recursive: true, mode: DIR_MODE })
			.then(async () => {
				// Tighten a pre-existing directory that mkdir did not create.
				await chmod(this.#directory, DIR_MODE).catch(() => undefined);
			})
			.catch((error: unknown) => {
				this.#ready = undefined; // never cache a failed mkdir
				throw error;
			});
		return this.#ready;
	}

	#path(key: string): string {
		// Hash the full key: traversal-safe and collision-free (distinct keys map
		// to distinct files, unlike a character-sanitizing scheme).
		const name = createHash("sha256").update(key, "utf8").digest("hex");
		return join(this.#directory, `${name}.rec`);
	}

	async #writeAtomic(path: string, record: DiskRecord): Promise<void> {
		const temp = `${path}.tmp-${randomBytes(8).toString("hex")}`;
		try {
			await writeFile(temp, JSON.stringify(record), { mode: FILE_MODE });
			await rename(temp, path);
		} catch (error) {
			await rm(temp, { force: true });
			throw error;
		}
	}
}

interface RecordRead {
	/** The parsed record, or undefined when the file is absent, empty, or corrupt. */
	readonly value: DiskRecord | undefined;
}

async function readRecord(path: string): Promise<RecordRead | undefined> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (isErrno(error, "ENOENT")) return undefined; // absent
		throw error;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return { value: undefined };
		const value = Reflect.get(parsed, "value");
		const expiresAt = Reflect.get(parsed, "expiresAt");
		if (typeof value !== "string" || typeof expiresAt !== "number") return { value: undefined };
		return { value: { value, expiresAt } };
	} catch {
		return { value: undefined }; // present but corrupt (e.g. half-written)
	}
}

function assertTtl(options: McpOAuthStoreWriteOptions): void {
	if (!Number.isFinite(options.ttlSeconds) || options.ttlSeconds <= 0) {
		throw new McpOAuthConfigError(
			"INVALID_OPTIONS",
			"MCP OAuth store writes require a positive ttlSeconds.",
		);
	}
}

function isErrno(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && Reflect.get(error, "code") === code;
}
