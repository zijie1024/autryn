import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_REL = ".autryn";

/** 当 `AUTRYN_HOME` 未设置时的默认 `~/.autryn`。 */
export function getDefaultAutrynHome(): string {
  return path.join(homedir(), DEFAULT_REL);
}

/** 从环境变量解析 `AUTRYN_HOME`（调用前必须先设置）。 */
export function getAutrynHomePath(): string {
  const v = Bun.env.AUTRYN_HOME?.trim();
  if (!v) {
    throw new Error("AUTRYN_HOME is not set");
  }
  return path.resolve(v);
}
