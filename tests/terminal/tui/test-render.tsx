import { Readable, Writable } from "node:stream";

import { render } from "ink";
import type { ReactNode } from "react";

/** 收集 Ink 写出的全部终端帧。 */
export class MemoryStdout extends Writable {
  readonly frames: string[] = [];

  // 当 `stdout.columns` 缺失时，Ink 会回退到 `terminal-size`（在 Windows 上是
  // 同步 `tput` 子进程），冷启动耗时数秒且让测试不稳定。显式给出尺寸可让渲染
  // 快速、确定、与宿主终端无关。
  columns = 100;
  rows = 24;

  override _write(chunk: unknown, _encoding: string, callback: () => void): void {
    this.frames.push(String(chunk));
    callback();
  }

  get output(): string {
    return this.frames.join("");
  }
}

export type FakeStdin = Readable & {

  setRawMode: (mode: boolean) => void;
  ref: () => void;
  unref: () => void;
  isTTY: boolean;
};

/**
 * 满足 Ink raw-mode 要求的 Readable 流，用于测试。
 *
 * Ink 的 App 在 raw mode 前后会调用 `stdin.ref()`/`stdin.unref()`（此外还有
 * `setRawMode`）；缺少它们时，第一个活动的 `useInput` 会在 passive effect 中抛错，
 * 而 Ink 的 ErrorBoundary 会静默用错误覆盖层替换树，导致断言通过但实际什么都没渲染。
 */
export function createFakeStdin(): FakeStdin {
  const stdin = new Readable({ read() {} }) as FakeStdin;

  stdin.setRawMode = (_mode: boolean) => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  stdin.isTTY = true;
  return stdin;
}

/** Renders an Ink tree against in-memory streams so output can be asserted. */
export function renderWithMemoryStreams(node: ReactNode) {
  const stdout = new MemoryStdout();
  const stderr = new MemoryStdout();
  const stdin = createFakeStdin();
  // Ink 的公开类型要求 TTY 流；这些内存替身提供 Ink 实际用到的面
  //（write/read/setRawMode），仅此而已。debug 让 CI 中的交互式帧也写入测试流。
  const options = { stdout, stdin, stderr, patchConsole: false, debug: true } as unknown as Parameters<typeof render>[1];
  const instance = render(node, options);
  return { instance, stdout, stderr, stdin };
}

/** 让 Ink/React 在断言前完成异步 effects 与批量输出；CI Runner 的首次渲染可能稍慢。 */
export function nextRenderTick(ms = 150): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
