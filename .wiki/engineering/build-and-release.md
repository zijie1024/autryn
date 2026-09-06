---
title: 构建与发布
summary: 说明 JavaScript Library、类型声明、平台二进制、GitHub Release 资产和 Package Export 验证边界。
sources:
  - package.json
  - bunfig.toml
  - scripts/build-bin.mjs
  - scripts/package-exports-smoke.mjs
  - scripts/publish-github-release.mjs
  - bin/autryn.mjs
  - index.ts
related:
  - interfaces/public-api.md
  - engineering/repository-layout.md
  - engineering/testing.md
---

# 构建与发布

Autryn 分发 JavaScript Library 和平台原生 CLI。GitHub Release 提供一个包含 Library JavaScript、类型声明和启动器的 `.tgz`，以及 Windows、macOS、Linux 的 x64 与 arm64 二进制。GitHub 还会根据 Tag 自动生成完整源码归档。

## JavaScript Library

`build:js` 输出 CLI JavaScript 和八个 Public Export 到 `dist/js/lib`；`build:types` 从 Public Entry 生成 `dist/types` 声明，并用 `tsc-alias` 清理内部路径别名。`build:library` 依次执行这两个构建。

`package.json#exports` 为 Root 与各 Subpath 同时声明 JavaScript 和类型入口。`build:package` 调用 `bun pm pack` 生成 `dist/package/autryn-<version>.tgz`，包内包含 `bin/`、`dist/js/lib`、`dist/types` 及自动纳入的 README、License 和 Package Metadata。

Library 使用 Bun API，需要 Bun Runtime；构建产物不承诺 Node.js Runtime 兼容。项目不通过 npm registry 发布，`.tgz` 从 GitHub Release 安装。

## CLI 二进制

`build:bin` 使用 Bun Compile 构建当前平台，`build:bin:all` 构建六个命名资产。编译二进制包含应用、依赖和 Bun Runtime，运行时不要求用户安装 Bun、Node.js、npm 或项目 `node_modules`；文件操作、Shell、网络和 API Key 仍受宿主环境约束。

全局 npm 安装得到 `bin/autryn.mjs` 启动器。启动器需要 Node.js 20 或更高版本，并按当前平台和架构下载同版本的 Release 二进制。

## GitHub Release

`release:github:assets` 生成 `.tgz` 与六个平台二进制。`release:github` 在干净工作区中创建或验证 `v<version>` Tag，创建或更新 Release，并上传七个资产。发布脚本不重复上传完整源码压缩包，因为 GitHub 已为 Tag 提供 Source Code ZIP 与 TAR.GZ。

CLI 安装：

```bash
npm install -g github:zijie1024/autryn#v0.1.0
```

Library 安装：

```bash
npm install https://github.com/zijie1024/autryn/releases/download/v0.1.0/autryn-0.1.0.tgz
```

依赖安装由 `bunfig.toml` 固定到官方 `https://registry.npmjs.org`，Lockfile 不保存个人镜像地址。

## 验证边界

- `bun run check` 通过 TypeScript、ESLint 和全部测试。
- `bun run build:library` 后运行 Package Export 冒烟测试，验证 Root 与全部 Subpath。
- `bun run build:package` 后检查 `.tgz` 内容和类型入口。
- 当前平台二进制运行 `--help`；其他平台至少核对目标、命名和文件存在性。

发布物和源码目录关系见[Public API](../interfaces/public-api.md)与[仓库布局](repository-layout.md)。
