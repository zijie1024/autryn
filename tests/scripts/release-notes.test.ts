import { describe, expect, test } from "bun:test";

import { buildReleaseNotes } from "../../scripts/release-notes.mjs";

describe("GitHub release notes", () => {
  test("pins every installation path to the release tag and lists all assets", () => {
    const assets = [
      "autryn-0.1.0.tgz",
      "autryn-win32-x64.exe",
      "autryn-win32-arm64.exe",
      "autryn-darwin-x64",
      "autryn-darwin-arm64",
      "autryn-linux-x64",
      "autryn-linux-arm64",
    ];
    const notes = buildReleaseNotes({
      repository: "zijie1024/autryn",
      version: "0.1.0",
      tag: "v0.1.0",
      assetNames: assets,
    });

    expect(notes).toContain("npm install -g github:zijie1024/autryn#v0.1.0");
    expect(notes).toContain(
      "npm install https://github.com/zijie1024/autryn/releases/download/v0.1.0/autryn-0.1.0.tgz",
    );
    expect(notes).not.toMatch(/npm install -g github:zijie1024\/autryn\s*$/m);
    for (const asset of assets) expect(notes).toContain(`- ${asset}`);
  });
});
