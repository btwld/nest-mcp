import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { assertFixedGroup, assertFixedVersions } from "./publish-state.mjs";

const expectedRef = "refs/heads/main";
const registryPropagationAttempts = 60;
const registryPropagationDelayMs = 5_000;

if (
	process.env.GITHUB_ACTIONS !== "true" ||
	process.env.GITHUB_REF !== expectedRef ||
	typeof process.env.GITHUB_SHA !== "string"
) {
	throw new Error(`Publishing is restricted to GitHub Actions on ${expectedRef}`);
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const gitStatus = spawnSync("git", ["status", "--porcelain"], {
	cwd: repositoryRoot,
	encoding: "utf8",
});

if (gitStatus.error) {
	throw new Error("Could not inspect the git worktree", { cause: gitStatus.error });
}

if (gitStatus.status !== 0) {
	throw new Error(`git status exited with status ${gitStatus.status ?? "unknown"}`);
}

if (gitStatus.stdout.trim().length !== 0) {
	throw new Error("Refusing to publish from a dirty git worktree");
}

const headResult = spawnSync("git", ["rev-parse", "HEAD"], {
	cwd: repositoryRoot,
	encoding: "utf8",
});

if (headResult.error) {
	throw new Error("Could not resolve the git commit", { cause: headResult.error });
}

if (headResult.status !== 0) {
	throw new Error(`git rev-parse exited with status ${headResult.status ?? "unknown"}`);
}

if (headResult.stdout.trim() !== process.env.GITHUB_SHA) {
	throw new Error("Git HEAD does not match the GitHub Actions commit");
}

const packagesRoot = join(repositoryRoot, "packages");
const workspacePackages = readdirSync(packagesRoot, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => join(packagesRoot, entry.name, "package.json"))
	.filter((manifestPath) => existsSync(manifestPath))
	.map((manifestPath) => ({
		directory: dirname(manifestPath),
		manifest: JSON.parse(readFileSync(manifestPath, "utf8")),
	}))
	.filter(({ manifest }) => manifest.private !== true);

const changesetConfig = JSON.parse(
	readFileSync(join(repositoryRoot, ".changeset", "config.json"), "utf8"),
);

assertFixedGroup(
	workspacePackages.map(({ manifest }) => manifest.name),
	changesetConfig.fixed,
);

const preStateUrl = new URL("../.changeset/pre.json", import.meta.url);
const preState = existsSync(preStateUrl)
	? JSON.parse(readFileSync(preStateUrl, "utf8"))
	: undefined;
const publishState = workspacePackages.map(({ manifest }) => ({
	name: manifest.name,
	version: manifest.version,
}));
const { tag: prereleaseTag } = assertFixedVersions(publishState, preState);
const publishTag = prereleaseTag ?? "latest";

// Native npm trusted publishing exchanges a short-lived OIDC credential for
// each publish. Changesets publishes up to ten packages concurrently, which
// can invalidate a sibling exchange and leave only part of a fixed release
// available. Keep the release deterministic and verify each tarball before
// moving to the next package.
for (const entry of sortForPublishing(workspacePackages)) {
	const { name, version, publishConfig } = entry.manifest;
	const state = await registryVersionState(name, version);
	if (state === "available") {
		console.log(`Already published: ${name}@${version}`);
		await recordPublishedVersion(name, version);
		continue;
	}
	if (state === "incomplete") {
		console.log(`Waiting for npm to finish publishing: ${name}@${version}`);
		await waitForAvailableVersion(name, version);
		await recordPublishedVersion(name, version);
		continue;
	}

	console.log(`Publishing: ${name}@${version}`);
	const publishResult = spawnSync(
		"pnpm",
		[
			"publish",
			"--access",
			publishConfig?.access ?? changesetConfig.access,
			"--tag",
			publishTag,
			"--no-git-checks",
			"--json",
		],
		{
			cwd: entry.directory,
			env: withoutOtp(process.env),
			stdio: "inherit",
		},
	);

	if (publishResult.error) {
		throw new Error(`Could not publish ${name}@${version}`, {
			cause: publishResult.error,
		});
	}
	if (publishResult.signal !== null) {
		throw new Error(`Publishing ${name}@${version} terminated with ${publishResult.signal}`);
	}
	if (publishResult.status !== 0) {
		throw new Error(
			`Publishing ${name}@${version} exited with status ${publishResult.status ?? "unknown"}`,
		);
	}

	await waitForAvailableVersion(name, version);
	await recordPublishedVersion(name, version);
}

function sortForPublishing(entries) {
	const remaining = new Map(entries.map((entry) => [entry.manifest.name, entry]));
	const ordered = [];

	while (remaining.size > 0) {
		const ready = [...remaining.values()]
			.filter(({ manifest }) =>
				Object.keys(manifest.dependencies ?? {}).every((dependency) => !remaining.has(dependency)),
			)
			.toSorted((left, right) => left.manifest.name.localeCompare(right.manifest.name));
		if (ready.length === 0) {
			throw new Error("Could not determine a dependency-safe package publish order");
		}
		for (const entry of ready) {
			remaining.delete(entry.manifest.name);
			ordered.push(entry);
		}
	}

	return ordered;
}

async function registryVersionState(name, version) {
	const metadataUrl = `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
	const metadataResponse = await fetch(metadataUrl, { cache: "no-store" });
	if (metadataResponse.status === 404) return "missing";
	if (!metadataResponse.ok) {
		throw new Error(
			`Could not inspect ${name}@${version}: npm returned ${metadataResponse.status}`,
		);
	}

	const metadata = await metadataResponse.json();
	const tarballUrl = metadata?.dist?.tarball;
	if (typeof tarballUrl !== "string") return "incomplete";
	const tarballResponse = await fetch(tarballUrl, {
		cache: "no-store",
		method: "HEAD",
	});
	return tarballResponse.ok ? "available" : "incomplete";
}

async function waitForAvailableVersion(name, version) {
	for (let attempt = 0; attempt < registryPropagationAttempts; attempt += 1) {
		if ((await registryVersionState(name, version)) === "available") return;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, registryPropagationDelayMs));
	}
	throw new Error(`${name}@${version} did not become installable within five minutes`);
}

async function recordPublishedVersion(name, version) {
	const outputPath = process.env.CHANGESETS_OUTPUT;
	if (typeof outputPath !== "string" || outputPath.length === 0) return;
	const tag = `${name}@${version}`;
	// A partially successful run can already have created this GitHub release.
	// Changesets rejects duplicate releases, so emit only missing release metadata.
	const existing = await fetch(
		`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/releases/tags/${encodeURIComponent(tag)}`,
		{
			headers: {
				accept: "application/vnd.github+json",
				authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
			},
			signal: AbortSignal.timeout(30_000),
		},
	);
	if (existing.status === 200) return;
	if (existing.status !== 404) {
		throw new Error(`Could not inspect the GitHub release for ${tag}: HTTP ${existing.status}`);
	}
	appendFileSync(outputPath, `${JSON.stringify({ type: "git-tag", tag, packageName: name })}\n`);
}

function withoutOtp(environment) {
	return {
		...environment,
		NPM_CONFIG_OTP: undefined,
		PNPM_CONFIG_OTP: undefined,
		npm_config_otp: undefined,
		pnpm_config_otp: undefined,
	};
}
