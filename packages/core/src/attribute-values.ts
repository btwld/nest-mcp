export type McpAttributeScalar = string | number | boolean;

/** Immutable, telemetry-compatible operation dimension. */
export type McpAttributeValue = McpAttributeScalar | readonly McpAttributeScalar[];

/** Low-cardinality dimensions safe to attach to operation and telemetry context. */
export type McpAttributes = Readonly<Record<string, McpAttributeValue>>;

export function copyMcpAttributes(attributes: unknown, name = "attributes"): McpAttributes {
	if (attributes === undefined) return Object.freeze({});
	if (typeof attributes !== "object" || attributes === null || Array.isArray(attributes)) {
		throw new TypeError(`${name} must be a record.`);
	}
	const copy: Record<string, McpAttributeValue> = {};
	for (const [key, value] of Object.entries(attributes)) {
		if (isAttributeScalar(value)) {
			copy[key] = value;
			continue;
		}
		if (Array.isArray(value) && value.every(isAttributeScalar)) {
			copy[key] = Object.freeze([...value]);
			continue;
		}
		throw new TypeError(`${name}.${key} must be a scalar or scalar array.`);
	}
	return Object.freeze(copy);
}

function isAttributeScalar(value: unknown): value is McpAttributeScalar {
	return (
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	);
}
