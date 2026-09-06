import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { spawn } from "node:child_process";

import { buildReleaseNotes } from "./release-notes.mjs";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const version = packageJson.version;
const tag = `v${version}`;
const repository = process.env.AUTRYN_RELEASE_REPOSITORY ?? packageJson.autryn?.releaseRepository;
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;

const assets = [
  { name: `autryn-${version}.tgz`, path: `dist/package/autryn-${version}.tgz` },
  { name: "autryn-win32-x64.exe", path: "dist/bin/autryn-win32-x64.exe" },
  { name: "autryn-win32-arm64.exe", path: "dist/bin/autryn-win32-arm64.exe" },
  { name: "autryn-darwin-x64", path: "dist/bin/autryn-darwin-x64" },
  { name: "autryn-darwin-arm64", path: "dist/bin/autryn-darwin-arm64" },
  { name: "autryn-linux-x64", path: "dist/bin/autryn-linux-x64" },
  { name: "autryn-linux-arm64", path: "dist/bin/autryn-linux-arm64" },
];

if (!repository) {
  fail("Set autryn.releaseRepository in package.json or AUTRYN_RELEASE_REPOSITORY.");
}

if (!token) {
  fail("Set GITHUB_TOKEN or GH_TOKEN with permission to create releases and upload assets.");
}

await ensureCleanGit();
await run("bun", ["run", "release:github:assets"]);
await ensureReleaseAssetsExist();
await ensureTag();
await run("git", ["push", "origin", tag]);

const release = await upsertRelease();
await uploadAssets(release);

console.log(`Published ${tag}: https://github.com/${repository}/releases/tag/${tag}`);

async function ensureCleanGit() {
  const status = await output("git", ["status", "--porcelain"]);
  if (status.trim()) {
    fail("Working tree is not clean. Commit changes before publishing.");
  }
}

async function ensureReleaseAssetsExist() {
  for (const asset of assets) {
    await stat(asset.path);
  }
}

async function ensureTag() {
  const head = (await output("git", ["rev-parse", "HEAD"])).trim();
  const existing = await outputOrNull("git", ["rev-list", "-n", "1", tag]);

  if (existing === null) {
    await run("git", ["tag", tag]);
    return;
  }

  if (existing.trim() !== head) {
    fail(`${tag} already exists and does not point at HEAD.`);
  }
}

async function upsertRelease() {
  const existing = await github(`https://api.github.com/repos/${repository}/releases/tags/${tag}`, {
    allowNotFound: true,
  });

  const body = {
    tag_name: tag,
    name: `Autryn ${tag}`,
    body: buildReleaseNotes({
      repository,
      version,
      tag,
      assetNames: assets.map((asset) => asset.name),
    }),
    draft: false,
    prerelease: isPrerelease(version),
  };

  if (existing) {
    return github(`https://api.github.com/repos/${repository}/releases/${existing.id}`, {
      method: "PATCH",
      json: body,
    });
  }

  return github(`https://api.github.com/repos/${repository}/releases`, {
    method: "POST",
    json: body,
  });
}

async function uploadAssets(release) {
  for (const asset of release.assets ?? []) {
    if (assets.some((candidate) => candidate.name === asset.name)) {
      await github(asset.url, { method: "DELETE" });
    }
  }

  for (const asset of assets) {
    const fileStat = await stat(asset.path);
    const url = `${release.upload_url.split("{")[0]}?name=${encodeURIComponent(basename(asset.name))}`;

    console.log(`Uploading ${asset.name}`);
    await github(url, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(fileStat.size),
      },
      body: createReadStream(asset.path),
      duplex: "half",
    });
  }
}

function isPrerelease(value) {
  return value.includes("-");
}

async function github(url, options = {}) {
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
    ...(options.headers ?? {}),
  };

  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers,
    body: options.json ? JSON.stringify(options.json) : options.body,
    duplex: options.duplex,
  });

  if (options.allowNotFound && response.status === 404) {
    return null;
  }

  if (!response.ok) {
    fail(
      `${options.method ?? "GET"} ${url} failed: ${response.status} ${response.statusText}\n${await response.text()}`,
    );
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", shell: process.platform === "win32" });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
      }
    });
    child.on("error", reject);
  });
}

function output(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: process.platform === "win32" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr || `${command} ${args.join(" ")} exited with ${code}`));
      }
    });
    child.on("error", reject);
  });
}

async function outputOrNull(command, args) {
  try {
    return await output(command, args);
  } catch {
    return null;
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
