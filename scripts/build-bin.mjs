import { mkdir, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const productVersion = `${packageJson.version}.0`;

const windowsMetadata = {
  title: "Autryn",
  publisher: "Autryn",
  version: productVersion,
  description: "Autryn CLI",
  copyright: "Copyright (c) Autryn contributors",
};

const targetGroups = {
  current: [currentTarget()],
  all: [
    platformTarget("windows", "win32", "x64"),
    platformTarget("windows", "win32", "arm64"),
    platformTarget("darwin", "darwin", "x64"),
    platformTarget("darwin", "darwin", "arm64"),
    platformTarget("linux", "linux", "x64"),
    platformTarget("linux", "linux", "arm64"),
  ],
};

const mode = process.argv.includes("--all") ? "all" : "current";

await rm("./dist/bin", { recursive: true, force: true });
await mkdir("./dist/bin", { recursive: true });
await rm("./dist/bin/autryn", { force: true });
await rm("./dist/bin/autryn.exe", { force: true });

for (const buildTarget of targetGroups[mode]) {
  const compile = {
    target: buildTarget.target,
    outfile: buildTarget.outfile,
  };

  if (buildTarget.target.startsWith("bun-windows-")) {
    compile.windows = windowsMetadata;
  }

  const result = await Bun.build({
    entrypoints: ["./index.ts"],
    compile,
  });

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    process.exit(1);
  }
}

if (mode === "all") {
  await rm("./dist/bin/autryn", { force: true });
  await rm("./dist/bin/autryn.exe", { force: true });
}

function platformTarget(bunPlatform, nodePlatform, arch) {
  const extension = nodePlatform === "win32" ? ".exe" : "";

  return {
    target: `bun-${bunPlatform}-${arch}`,
    outfile: `./dist/bin/autryn-${nodePlatform}-${arch}${extension}`,
    platform: nodePlatform,
    arch,
  };
}

function currentTarget() {
  if (process.platform === "win32") {
    return {
      target: process.arch === "arm64" ? "bun-windows-arm64" : "bun-windows-x64",
      outfile: "./dist/bin/autryn",
    };
  }

  if (process.platform === "darwin") {
    return {
      target: process.arch === "arm64" ? "bun-darwin-arm64" : "bun-darwin-x64",
      outfile: "./dist/bin/autryn",
    };
  }

  if (process.platform === "linux") {
    return {
      target: process.arch === "arm64" ? "bun-linux-arm64" : "bun-linux-x64",
      outfile: "./dist/bin/autryn",
    };
  }

  throw new Error(`Unsupported platform: ${process.platform} ${process.arch}`);
}
