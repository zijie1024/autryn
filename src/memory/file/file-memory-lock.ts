import { readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";

import { MemoryError } from "../domain/errors";

export interface MemoryLockInfo {
  owner: string;
  pid: number;
  host: string;
  createdAt: string;
}

/**
 * 短期 Scope Mutation Lock。Read 与 Bootstrap 不持有长期 lease，
 * Mutation 在读取当前 digest、写入和提交期间持有。
 * 只清理能够证明持有进程已终止的**本机**过期 Lock；无法确认时返回 MEMORY_LOCKED。
 */
export class FileMemoryLock {
  private readonly hostname: string;
  private readonly pid: number;

  constructor(options: { hostname?: string; pid?: number } = {}) {
    this.hostname = options.hostname ?? os.hostname();
    this.pid = options.pid ?? process.pid;
  }

  async acquire(lockFilePath: string, owner: string): Promise<void> {
    const info: MemoryLockInfo = {
      owner,
      pid: this.pid,
      host: this.hostname,
      createdAt: new Date().toISOString(),
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await writeFile(lockFilePath, JSON.stringify(info, null, 2), { flag: "wx" });
        return;
      } catch (error) {
        if (!isEexist(error)) throw error;
        if (!(await this.isStale(lockFilePath))) {
          throw new MemoryError("MEMORY_LOCKED", "The memory scope is locked by another process.", {
            retryable: true,
          });
        }
        await rm(lockFilePath, { force: true });
      }
    }
    throw new MemoryError("MEMORY_LOCKED", "Could not acquire the memory scope lock.", { retryable: true });
  }

  async release(lockFilePath: string): Promise<void> {
    await rm(lockFilePath, { force: true });
  }

  private async isStale(lockFilePath: string): Promise<boolean> {
    try {
      const raw = await readFile(lockFilePath, "utf8");
      const info = JSON.parse(raw) as Partial<MemoryLockInfo>;
      if (typeof info.pid !== "number") return false;
      if (info.host !== this.hostname) return false;
      return !isProcessAlive(info.pid);
    } catch {
      // 无法读取或解析锁文件时保守处理：不判定为过期。
      return false;
    }
  }
}

function isEexist(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "EEXIST";
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}
