import { randomUUID } from "node:crypto";

import { Injectable } from "@nestjs/common";

import { ControlPlaneError } from "../common/control-plane.error.ts";
import type {
	CatalogSnapshot,
	ConnectionRecord,
	ConnectionReplacement,
	CreateConnectionInput,
	DesiredConnectionState,
	ReplaceConnectionInput,
} from "./connection.types.ts";
import { connectionGenerationKey } from "./connection.types.ts";

@Injectable()
export class ConnectionRepository {
	readonly #connections = new Map<string, ConnectionRecord>();
	readonly #connectionsByGeneration = new Map<string, ConnectionRecord>();
	readonly #connectionNames = new Map<string, string>();
	readonly #catalogs = new Map<string, CatalogSnapshot>();

	create(input: CreateConnectionInput): ConnectionRecord {
		this.#assertNameAvailable(input.displayName);
		const id = randomUUID();
		const timestamp = new Date().toISOString();
		const record = freezeConnection({
			id,
			revision: 1,
			runtimeGeneration: 1,
			generationKey: connectionGenerationKey(id, 1),
			displayName: input.displayName,
			authenticationKind: input.authenticationKind,
			desiredState: input.desiredState,
			deletionPending: false,
			endpoint: input.endpoint,
			endpointHost: input.endpointHost,
			createdAt: timestamp,
			updatedAt: timestamp,
		});
		this.#connections.set(id, record);
		this.#connectionsByGeneration.set(record.generationKey, record);
		this.#connectionNames.set(normalizeName(record.displayName), id);
		return record;
	}

	list(): readonly ConnectionRecord[] {
		return Object.freeze([...this.#connections.values()]);
	}

	get(connectionId: string): ConnectionRecord {
		const record = this.#connections.get(connectionId);
		if (record === undefined) throw connectionNotFoundError();
		return record;
	}

	resolveGeneration(generationKey: string): ConnectionRecord {
		const record = this.#connectionsByGeneration.get(generationKey);
		if (record === undefined) {
			throw new ControlPlaneError(
				"MCP_GENERATION_RETIRED",
				409,
				"The requested MCP runtime generation has been retired.",
			);
		}
		return record;
	}

	replace(
		connectionId: string,
		expectedRevision: number,
		input: ReplaceConnectionInput,
	): ConnectionReplacement {
		const previous = this.get(connectionId);
		assertRevision(previous, expectedRevision);
		assertMutable(previous);
		this.#assertNameAvailable(input.displayName, connectionId);
		const generationChanged = input.endpoint !== previous.endpoint;
		const runtimeGeneration = previous.runtimeGeneration + (generationChanged ? 1 : 0);
		const current = freezeConnection({
			...previous,
			revision: previous.revision + 1,
			runtimeGeneration,
			generationKey: connectionGenerationKey(connectionId, runtimeGeneration),
			displayName: input.displayName,
			endpoint: input.endpoint,
			endpointHost: input.endpointHost,
			updatedAt: new Date().toISOString(),
		});
		this.#connections.set(connectionId, current);
		this.#connectionsByGeneration.set(current.generationKey, current);
		if (previous.displayName !== current.displayName) {
			this.#connectionNames.delete(normalizeName(previous.displayName));
			this.#connectionNames.set(normalizeName(current.displayName), connectionId);
		}
		if (generationChanged) this.#catalogs.delete(connectionId);
		return Object.freeze({ previous, current, generationChanged });
	}

	setDesiredState(
		connectionId: string,
		expectedRevision: number,
		desiredState: DesiredConnectionState,
	): ConnectionRecord {
		const previous = this.get(connectionId);
		assertRevision(previous, expectedRevision);
		assertMutable(previous);
		const current = freezeConnection({
			...previous,
			revision: previous.revision + 1,
			desiredState,
			updatedAt: new Date().toISOString(),
		});
		this.#connections.set(connectionId, current);
		this.#connectionsByGeneration.set(current.generationKey, current);
		return current;
	}

	rotateRuntimeGeneration(
		connectionId: string,
		expectedGenerationKey: string,
	): ConnectionReplacement {
		const previous = this.get(connectionId);
		assertMutable(previous);
		if (previous.generationKey !== expectedGenerationKey) {
			throw new ControlPlaneError(
				"MCP_GENERATION_RETIRED",
				409,
				"The requested MCP runtime generation has been retired.",
			);
		}
		const runtimeGeneration = previous.runtimeGeneration + 1;
		const current = freezeConnection({
			...previous,
			revision: previous.revision + 1,
			runtimeGeneration,
			generationKey: connectionGenerationKey(connectionId, runtimeGeneration),
			updatedAt: new Date().toISOString(),
		});
		this.#connections.set(connectionId, current);
		this.#connectionsByGeneration.set(current.generationKey, current);
		this.#catalogs.delete(connectionId);
		return Object.freeze({ previous, current, generationChanged: true });
	}

	beginRemoval(connectionId: string, expectedRevision: number): ConnectionRecord {
		const previous = this.get(connectionId);
		assertRevision(previous, expectedRevision);
		if (previous.deletionPending) return previous;
		const tombstone = freezeConnection({
			...previous,
			revision: previous.revision + 1,
			desiredState: "offline",
			deletionPending: true,
			updatedAt: new Date().toISOString(),
		});
		this.#connections.set(connectionId, tombstone);
		this.#connectionsByGeneration.delete(previous.generationKey);
		this.#catalogs.delete(connectionId);
		return tombstone;
	}

	commitRemoval(connectionId: string, expectedRevision: number): void {
		const tombstone = this.get(connectionId);
		assertRevision(tombstone, expectedRevision);
		if (!tombstone.deletionPending) {
			throw new Error("An MCP connection must be fenced before removal is committed.");
		}
		this.#connections.delete(connectionId);
		this.#connectionsByGeneration.delete(tombstone.generationKey);
		this.#connectionNames.delete(normalizeName(tombstone.displayName));
		this.#catalogs.delete(connectionId);
	}

	forgetGeneration(generationKey: string): void {
		const current = this.#connectionsByGeneration.get(generationKey);
		if (
			current !== undefined &&
			this.#connections.get(current.id)?.generationKey === generationKey
		) {
			return;
		}
		this.#connectionsByGeneration.delete(generationKey);
	}

	putCatalog(snapshot: CatalogSnapshot): CatalogSnapshot {
		const current = this.get(snapshot.connectionId);
		if (current.deletionPending || current.runtimeGeneration !== snapshot.runtimeGeneration) {
			throw new ControlPlaneError(
				"MCP_GENERATION_RETIRED",
				409,
				"The discovered MCP generation is no longer authoritative.",
			);
		}
		const frozen = Object.freeze({
			...snapshot,
			tools: Object.freeze([...snapshot.tools]),
			resources: Object.freeze([...snapshot.resources]),
			resourceTemplates: Object.freeze([...snapshot.resourceTemplates]),
			prompts: Object.freeze([...snapshot.prompts]),
		});
		this.#catalogs.set(snapshot.connectionId, frozen);
		return frozen;
	}

	getCatalog(connectionId: string): CatalogSnapshot | undefined {
		this.get(connectionId);
		return this.#catalogs.get(connectionId);
	}

	#assertNameAvailable(displayName: string, ownId?: string): void {
		const existingId = this.#connectionNames.get(normalizeName(displayName));
		if (existingId !== undefined && existingId !== ownId) {
			throw new ControlPlaneError(
				"MCP_CONNECTION_EXISTS",
				409,
				"An MCP connection with that display name already exists.",
			);
		}
	}
}

function freezeConnection(record: ConnectionRecord): ConnectionRecord {
	return Object.freeze(record);
}

function normalizeName(value: string): string {
	return value.trim().toLocaleLowerCase("en-US");
}

function assertRevision(record: ConnectionRecord, expectedRevision: number): void {
	if (record.revision === expectedRevision) return;
	throw new ControlPlaneError(
		"MCP_REVISION_CONFLICT",
		409,
		"The MCP connection changed after it was read.",
	);
}

function assertMutable(record: ConnectionRecord): void {
	if (!record.deletionPending) return;
	throw new ControlPlaneError(
		"MCP_CONNECTION_DELETING",
		409,
		"The MCP connection is fenced for deletion.",
	);
}

function connectionNotFoundError(): ControlPlaneError {
	return new ControlPlaneError(
		"MCP_CONNECTION_NOT_FOUND",
		404,
		"The MCP connection does not exist.",
	);
}
