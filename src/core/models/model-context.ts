import type { NonSystemMessage } from "../messages";
import type { Tool } from "../tools";

export interface ModelContext {
  prompt: string;
  messages: NonSystemMessage[];
  tools?: Tool[];
  signal?: AbortSignal;
}
