import { Injectable, StandardSchemaValidationPipe, type ArgumentMetadata } from "@nestjs/common";
import type { StandardSchemaV1 } from "@standard-schema/spec";

const STANDARD_SCHEMA_DTO = Symbol("control-plane-api/standard-schema-dto");

/**
 * Runtime class created by `createStandardSchemaDto`.
 *
 * Its instance type is the schema's parsed object output.
 */
export interface StandardSchemaDtoClass<
	Schema extends StandardSchemaV1<unknown, object> = StandardSchemaV1<unknown, object>,
> {
	new (): StandardSchemaV1.InferOutput<Schema>;
	readonly [STANDARD_SCHEMA_DTO]: true;
	readonly schema: Schema;
}

/**
 * Creates a runtime DTO base class whose instance type is the schema's parsed
 * object output.
 *
 * Nest reflects a concrete subclass at runtime, allowing the DTO-aware pipe to
 * discover the schema from `@Body()` or `@Query()` metadata.
 */
export function createStandardSchemaDto<const Schema extends StandardSchemaV1<unknown, object>>(
	schema: Schema,
): StandardSchemaDtoClass<Schema> {
	if (!isStandardSchema(schema)) {
		throw new TypeError("createStandardSchemaDto() expected a Standard Schema.");
	}

	// Nest reflects a class as the parameter metatype, so the schema rides on statics.
	// oxlint-disable-next-line typescript/no-extraneous-class
	class StandardSchemaDto {
		static readonly [STANDARD_SCHEMA_DTO] = true as const;
		static readonly schema = schema;
	}

	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	return StandardSchemaDto as StandardSchemaDtoClass<Schema>;
}

/** Returns whether a value is a branded Standard Schema DTO class. */
export function isStandardSchemaDto(value: unknown): value is StandardSchemaDtoClass {
	return (
		typeof value === "function" &&
		isObjectLike(value) &&
		value[STANDARD_SCHEMA_DTO] === true &&
		isStandardSchema(value["schema"])
	);
}

/** Resolves the schema carried by a generated DTO class. */
export function getStandardSchema<Schema extends StandardSchemaV1<unknown, object>>(
	source: StandardSchemaDtoClass<Schema>,
): Schema;
export function getStandardSchema(
	source: StandardSchemaDtoClass,
): StandardSchemaV1<unknown, object>;
export function getStandardSchema(
	source: StandardSchemaDtoClass,
): StandardSchemaV1<unknown, object> {
	if (!isStandardSchemaDto(source)) {
		throw new TypeError("Expected a class created by createStandardSchemaDto().");
	}

	return source.schema;
}

/**
 * Adds DTO-carried schemas to Nest argument metadata, then delegates parsing
 * and error handling to Nest's native `StandardSchemaValidationPipe`.
 */
@Injectable()
export class StandardSchemaDtoValidationPipe extends StandardSchemaValidationPipe {
	override transform<T = unknown>(value: T, metadata: ArgumentMetadata): Promise<T> {
		const schema =
			metadata.schema ??
			(isStandardSchemaDto(metadata.metatype) ? metadata.metatype.schema : undefined);

		return super.transform(value, {
			...metadata,
			...(schema === undefined ? {} : { schema }),
		});
	}
}

function isStandardSchema(value: unknown): value is StandardSchemaV1 {
	if (!isObjectLike(value)) return false;

	const standard = value["~standard"];

	return (
		isObjectLike(standard) &&
		standard["version"] === 1 &&
		typeof standard["validate"] === "function"
	);
}

function isObjectLike(value: unknown): value is Record<PropertyKey, unknown> {
	return (typeof value === "object" && value !== null) || typeof value === "function";
}
