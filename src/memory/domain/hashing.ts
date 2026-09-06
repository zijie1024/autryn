import { createHash } from "node:crypto";

/** 内容字节的 SHA-256 Hex（小写、不截断），承担乐观并发版本语义。 */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
