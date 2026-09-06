export function buildReleaseNotes({ repository, version, tag, assetNames }) {
  return [
    `Autryn ${tag}`,
    "",
    "Assets:",
    ...assetNames.map((name) => `- ${name}`),
    "",
    "Install from GitHub:",
    "",
    "```bash",
    `npm install -g github:${repository}#${tag}`,
    "```",
    "",
    "Install the Library from this release:",
    "",
    "```bash",
    `npm install https://github.com/${repository}/releases/download/${tag}/autryn-${version}.tgz`,
    "```",
  ].join("\n");
}
