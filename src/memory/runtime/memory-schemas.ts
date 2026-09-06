import { z } from "zod";

import type { MemoryDocumentReference } from "../domain";
import { parseReference } from "../file/file-memory-paths";

/**
 * 与 {@link parseReference} 保持一致的 Tool Schema 校验：
 * 只接受 `MEMORY.md` 或小写 kebab-case `.md` 的 Topic 名称。
 */
export const memoryReferenceSchema = z.string().refine((value): value is MemoryDocumentReference => {
    try {
      parseReference(value);
      return true;
    } catch {
      return false;
    }
  }, "Reference must be MEMORY.md or a lowercase kebab-case .md topic name.");
