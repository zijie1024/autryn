#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = await readPackageJson();
const platform = process.platform;
const arch = process.arch;

const supportedPlatforms = new Set(["win32", "darwin", "linux"]);
const supportedArchitectures = new Set(["x64", "arm64"]);

if (!supportedPlatforms.has(platform) || !supportedArchitectures.has(arch)) {
  fail(`Unsupported platform: ${platform} ${arch}`);
}

const binaryName = platform === "win32" ? "autryn.exe" : "autryn";
const assetName = `autryn-${platform}-${arch}${platform === "win32" ? ".exe" : ""}`;
const cacheDir = join(homedir(), ".autryn", "bin", packageJson.version);
const cachedExecutable = join(cacheDir, assetName);

const candidates = [
  join(packageRoot, "dist", "bin", assetName),
  join(packageRoot, "dist", "bin", binaryName),
  cachedExecutable,
].filter(Boolean);

let executable = candidates.find((candidate) => existsSync(candidate));

if (!executable) {
  executable = await downloadReleaseBinary(cachedExecutable, assetName);
}

const child = spawn(executable, process.argv.slice(2), {
  stdio: "inherit",
  windowsHide: false,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  fail(error.message);
});

async function downloadReleaseBinary(destination, name) {
  const url = releaseAssetUrl(name);

  console.error(`Downloading Autryn ${packageJson.version} for ${platform} ${arch}...`);
  console.error(url);

  const response = await fetch(url, { headers: { "user-agent": `autryn/${packageJson.version}` } });
  if (!response.ok) {
    fail(`Failed to download Autryn binary: ${response.status} ${response.statusText}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { mode: 0o755 });

  if (platform !== "win32") {
    await chmod(destination, 0o755);
  }

  return destination;
}

function releaseAssetUrl(name) {
  if (process.env.AUTRYN_RELEASE_BASE_URL) {
    return `${process.env.AUTRYN_RELEASE_BASE_URL.replace(/\/$/, "")}/${name}`;
  }

  const repository = process.env.AUTRYN_RELEASE_REPOSITORY ?? packageJson.autryn?.releaseRepository;
  if (!repository) {
    fail("Autryn release repository is not configured.");
  }

  return `https://github.com/${repository}/releases/download/v${packageJson.version}/${name}`;
}

async function readPackageJson() {
  const text = await readFile(join(packageRoot, "package.json"), "utf8");
  return JSON.parse(text);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
