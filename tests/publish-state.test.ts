import { readdir, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
	assertFixedGroup,
	assertFixedVersions,
	resolvePrereleaseTag,
} from "../scripts/publish-state.mjs";

const FIXED_GROUP = [
	"@nest-mcp/core",
	"@nest-mcp/client",
	"@nest-mcp/manager",
	"@nest-mcp/conformance",
	"@nest-mcp/server",
	"@nest-mcp/apps",
	"@nest-mcp/auth",
	"@nest-mcp/observability",
	"@nest-mcp/gateway",
	"@nest-mcp/nestjs",
];

const packageManifestSchema = z.object({
	name: z.string().min(1),
	private: z.boolean().optional(),
});
const changesetConfigSchema = z.object({ fixed: z.array(z.array(z.string().min(1))) });
const changesetPreStateSchema = z.object({
	mode: z.literal("pre"),
	tag: z.string().min(1),
});

const atVersion = (version: string) => FIXED_GROUP.map((name) => ({ name, version }));

describe("resolvePrereleaseTag", () => {
	it("returns the matching Changesets pre-mode tag", () => {
		expect(resolvePrereleaseTag("0.1.0-alpha.2", { mode: "pre", tag: "alpha" })).toBe("alpha");
		expect(resolvePrereleaseTag("0.1.0-alpha+build.1", { mode: "pre", tag: "alpha" })).toBe(
			"alpha",
		);
	});

	it("allows a stable version outside pre mode", () => {
		expect(resolvePrereleaseTag("1.0.0", undefined)).toBeUndefined();
		expect(resolvePrereleaseTag("1.0.0", { mode: "exit", tag: "alpha" })).toBeUndefined();
	});

	it("rejects a prerelease without Changesets pre mode", () => {
		expect(() => resolvePrereleaseTag("0.1.0-alpha.2", undefined)).toThrow(
			"requires Changesets pre mode",
		);
	});

	it("rejects a prerelease identifier that differs from the tag", () => {
		expect(() => resolvePrereleaseTag("0.1.0-beta.1", { mode: "pre", tag: "alpha" })).toThrow(
			"does not match Changesets tag",
		);
	});

	it("rejects a stable version while pre mode is active", () => {
		expect(() => resolvePrereleaseTag("1.0.0", { mode: "pre", tag: "alpha" })).toThrow(
			"cannot publish in Changesets pre mode",
		);
	});

	it("rejects a non-string version", () => {
		expect(() => resolvePrereleaseTag(undefined, undefined)).toThrow("requires a string version");
	});
});

describe("assertFixedVersions", () => {
	it("returns the shared version and prerelease tag", () => {
		expect(assertFixedVersions(atVersion("0.1.0-alpha.2"), { mode: "pre", tag: "alpha" })).toEqual({
			version: "0.1.0-alpha.2",
			tag: "alpha",
		});
	});

	it("returns no tag for a stable fixed group outside pre mode", () => {
		expect(assertFixedVersions(atVersion("1.2.3"), undefined)).toEqual({
			version: "1.2.3",
			tag: undefined,
		});
	});

	it("refuses to publish a diverged fixed group", () => {
		const packages = [
			...atVersion("0.1.0-alpha.2").slice(0, 6),
			{ name: "@nest-mcp/nestjs", version: "0.1.0-alpha.1" },
		];

		expect(() => assertFixedVersions(packages, { mode: "pre", tag: "alpha" })).toThrow(
			/diverged fixed-group versions/,
		);
		expect(() => assertFixedVersions(packages, { mode: "pre", tag: "alpha" })).toThrow(
			/@nest-mcp\/nestjs/,
		);
	});

	it("rejects malformed input", () => {
		expect(() => assertFixedVersions([], undefined)).toThrow("at least one package");
		expect(() => assertFixedVersions([{ version: "1.0.0" }], undefined)).toThrow(
			"requires a string name",
		);
		expect(() => assertFixedVersions([{ name: "@nest-mcp/nestjs" }], undefined)).toThrow(
			"requires a string version",
		);
	});
});

describe("assertFixedGroup", () => {
	it("matches every public workspace package and the documented bootstrap loops", async () => {
		const packagesRoot = new URL("../packages/", import.meta.url);
		const entries = await readdir(packagesRoot, { withFileTypes: true });
		const manifests = await Promise.all(
			entries
				.filter((entry) => entry.isDirectory())
				.map(async (entry) => {
					const source = await readFile(
						new URL(`${entry.name}/package.json`, packagesRoot),
						"utf8",
					);
					return packageManifestSchema.parse(JSON.parse(source));
				}),
		);
		const publicNames = manifests
			.filter((manifest) => manifest.private !== true)
			.map((manifest) => manifest.name)
			.toSorted();
		const config = changesetConfigSchema.parse(
			JSON.parse(await readFile(new URL("../.changeset/config.json", import.meta.url), "utf8")),
		);
		expect(assertFixedGroup(publicNames, config.fixed)).toEqual(publicNames);
		const preState = changesetPreStateSchema.parse(
			JSON.parse(await readFile(new URL("../.changeset/pre.json", import.meta.url), "utf8")),
		);
		expect(preState).toEqual({ mode: "pre", tag: "alpha" });

		const guide = await readFile(new URL("../CONTRIBUTING.md", import.meta.url), "utf8");
		const publishPackages = readDocumentedLoop(guide, /for PKG in ([^;]+); do\n  \(cd/u);
		const trustedPackages = readDocumentedLoop(guide, /for PKG in ([^;]+); do\n  npm trust/u);
		expect(publishPackages.map((name) => `@nest-mcp/${name}`).toSorted()).toEqual(publicNames);
		expect(trustedPackages.toSorted()).toEqual(publicNames);
	});

	it("accepts a group that matches the workspace packages", () => {
		expect(assertFixedGroup(FIXED_GROUP, [FIXED_GROUP])).toEqual(FIXED_GROUP.toSorted());
	});

	it("rejects a workspace package missing from the group", () => {
		expect(() => assertFixedGroup(FIXED_GROUP, [FIXED_GROUP.slice(1)])).toThrow(
			/missing: @nest-mcp\/core/,
		);
	});

	it("rejects an unknown fixed-group entry", () => {
		expect(() => assertFixedGroup(FIXED_GROUP, [[...FIXED_GROUP, "@nest-mcp/extra"]])).toThrow(
			/unknown: @nest-mcp\/extra/,
		);
	});

	it("requires exactly one fixed group", () => {
		expect(() => assertFixedGroup(FIXED_GROUP, [])).toThrow("exactly one `fixed` group");
		expect(() => assertFixedGroup(FIXED_GROUP, undefined)).toThrow("exactly one `fixed` group");
	});
});

function readDocumentedLoop(source: string, pattern: RegExp): string[] {
	const packages = pattern.exec(source)?.[1];
	if (packages === undefined) throw new Error("The documented package loop is missing.");
	return packages.trim().split(/\s+/u);
}
