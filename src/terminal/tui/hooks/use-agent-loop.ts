import type { ReactNode, SetStateAction } from "react";
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import type { AssistantMessage, NonSystemMessage, UserMessage } from "@/core";
import type { Agent } from "@/runtime";
import { publicErrorMessage, SessionError } from "@/sessions";
import type { SessionController, SessionControllerSnapshot, TerminalMemoryStatus } from "@/terminal/session";

import type { PromptSubmission, SlashCommand } from "../command-registry";
import { formatHelp, resolveBuiltinCommand } from "../command-registry";
import { calculateTokenUsage, type TokenUsageSummary } from "../token-usage";

type AgentLoopState = {
  agent: Agent | null;
  session: SessionControllerSnapshot | null;
  streaming: boolean;
  activity: string | null;
  messages: NonSystemMessage[];
  historyEpoch: number;
  onSubmit: (submission: PromptSubmission) => Promise<void>;
  abort: () => void;
  tokenUsage: TokenUsageSummary;
};

const AgentLoopContext = createContext<AgentLoopState | null>(null);

export function AgentLoopProvider({
  agent,
  sessionController,
  commands = [],
  children,
}: {
  agent?: Agent;
  sessionController?: SessionController;
  commands?: SlashCommand[];
  children: ReactNode;
}) {
  const [streaming, setStreaming] = useState(false);
  const [activity, setActivity] = useState<string | null>(null);
  const [messages, setMessages] = useState<NonSystemMessage[]>(() => sessionController?.messages() ?? []);
  const [session, setSession] = useState<SessionControllerSnapshot | null>(() => sessionController?.snapshot() ?? null);
  const [historyEpoch, setHistoryEpoch] = useState(0);

  const streamingRef = useRef(streaming);
  const pendingMessagesRef = useRef<NonSystemMessage[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    streamingRef.current = streaming;
  }, [streaming]);

  const flushPendingMessages = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }

    if (pendingMessagesRef.current.length === 0) return;

    const pending = pendingMessagesRef.current;
    pendingMessagesRef.current = [];
    setMessages((prev) => [...prev, ...pending]);
  }, []);

  const enqueueMessage = useCallback(
    (message: NonSystemMessage) => {
      pendingMessagesRef.current.push(message);
      if (flushTimerRef.current) return;

      flushTimerRef.current = setTimeout(() => {
        flushPendingMessages();
      }, 50);
    },
    [flushPendingMessages],
  );

  useEffect(() => {
    return () => {
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
      }
    };
  }, []);

  const abort = useCallback(() => {
    if (sessionController) {
      sessionController.abort();
      return;
    }
    agent?.abort();
  }, [agent, sessionController]);

  const tokenUsage = useMemo(() => {
    return calculateTokenUsage(messages);
  }, [messages]);

  const onSubmit = useCallback(
    async (submission: PromptSubmission) => {
      const { text, requestedSkillName } = submission;
      const invocation = resolveBuiltinCommand(text);
      setActivity(null);

      if (invocation?.name === "exit" || invocation?.name === "quit") {
        await sessionController?.dispose();
        process.exit(0);
        return;
      }

      if (sessionController && invocation?.name === "model") {
        flushPendingMessages();
        await handleModelCommand(sessionController, invocation.args, (message) => {
          setMessages((prev) => [...prev, assistantText(message)]);
          setSession(sessionController.snapshot());
        });
        return;
      }

      if (sessionController && invocation?.name === "mode") {
        flushPendingMessages();
        await handleModeCommand(sessionController, invocation.args, (message) => {
          setMessages((prev) => [...prev, assistantText(message)]);
          setSession(sessionController.snapshot());
        });
        return;
      }

      if (streamingRef.current) return;

      if (invocation?.name === "clear") {
        if (sessionController) {
          try {
            await sessionController.clear();
            flushPendingMessages();
            setMessages(sessionController.messages());
            setSession(sessionController.snapshot());
            setHistoryEpoch((epoch) => epoch + 1);
            clearTerminal();
          } catch (error) {
            appendAssistantError(error, setMessages);
          }
          return;
        }
        agent?.clearMessages();
        flushPendingMessages();
        setMessages([]);
        setHistoryEpoch((epoch) => epoch + 1);
        clearTerminal();
        return;
      }

      if (invocation?.name === "help") {
        flushPendingMessages();
        const userMessage: UserMessage = { role: "user", content: [{ type: "text", text }] };
        const helpMessage: AssistantMessage = {
          role: "assistant",
          content: [
            {
              type: "text",
              text: formatHelp(commands, invocation.args || undefined),
            },
          ],
        };
        setMessages((prev) => [...prev, userMessage, helpMessage]);
        return;
      }

      if (sessionController && invocation?.name === "memory") {
        flushPendingMessages();
        await handleMemoryCommand(sessionController, (message) => {
          setMessages((prev) => [...prev, assistantText(message)]);
        });
        return;
      }

      if (sessionController && invocation?.name === "remember" && !invocation.args) {
        flushPendingMessages();
        setMessages((prev) => [
          ...prev,
          assistantText("Run `/remember <text>` to ask the Agent to save something to Memory."),
        ]);
        return;
      }

      if (sessionController && invocation?.name) {
        const handled = await handleSessionCommand(sessionController, invocation.name, invocation.args, {
          setMessages,
          setSession,
          flushPendingMessages,
          resetHistory: () => setHistoryEpoch((epoch) => epoch + 1),
        });
        if (handled) return;
      }

      const isRemember = Boolean(sessionController && invocation?.name === "remember");
      const turnText = isRemember ? `Remember this in Memory: ${invocation?.args ?? ""}` : text;

      setStreaming(true);

      try {
        if (sessionController) {
          const snapshot = sessionController.snapshot();
          if (snapshot.activeExecutionMode === "dry_run") {
            setActivity(`DRY-RUN · ${snapshot.activeAgentId} is running`);
          }
          const result = await sessionController.runTurn(turnText, {
            requestedSkillName,
            requestedMemoryWrite: isRemember || undefined,
            onMessage: (message) => enqueueMessage(message),
            onHandoff: (event) => {
              if (event.status === "requested") {
                setActivity(`${event.agentId} → ${event.targetAgentId} · preparing handoff`);
              } else if (event.status === "committed") {
                setActivity(`${event.record.sourceAgentId} → ${event.targetAgentId} · handoff committed`);
              } else {
                setActivity(`${event.agentId} → ${event.targetAgentId} · handoff rejected`);
              }
              setSession(sessionController.snapshot());
            },
          });
          if (result.status !== "completed" && result.status !== "cancelled") {
            const reason = result.error?.message ?? `Execution ${result.status}.`;
            enqueueMessage(assistantText(`Error: ${reason}\n\nYou can try again.`));
          }
          if (result.dryRunReport) {
            const { previews, blocked } = result.dryRunReport.summary;
            setActivity(`DRY-RUN · ${previews} previewed · ${blocked} blocked · report saved to Session`);
          } else if (result.handoffs.length > 0) {
            setActivity(`Handoff complete · active Agent ${result.finalAgentId}`);
          }
          setSession(sessionController.snapshot());
        } else if (agent) {
          agent.setRequestedSkillName(requestedSkillName);
          const userMessage: UserMessage = { role: "user", content: [{ type: "text", text }] };
          setMessages((prev) => [...prev, userMessage]);

          const stream = agent.stream(userMessage);
          for await (const event of stream) {
            if (event.type === "message") {
              enqueueMessage(event.message);
            }
            // 有意忽略 progress 事件：UI 以 `streaming` 布尔值驱动一个通用的
            // "Thinking..." 微光动画，tool 调用的唯一事实来源是 MessageHistory。
          }
        }
      } catch (error) {
        if (isAbortError(error)) return;
        // 把 API/model 错误显示为 assistant 消息，而不是崩溃
        const errorMessage = error instanceof Error ? error.message : String(error);
        enqueueMessage({
          role: "assistant",
          content: [{ type: "text", text: `Error: ${errorMessage}\n\nYou can try again.` }],
        });
      } finally {
        agent?.setRequestedSkillName(null);
        flushPendingMessages();
        setStreaming(false);
        if (sessionController) setSession(sessionController.snapshot());
      }
    },
    [agent, commands, enqueueMessage, flushPendingMessages, sessionController],
  );

  const value = useMemo(
    () => ({
      agent: agent ?? null,
      session,
      streaming,
      activity,
      messages,
      historyEpoch,
      onSubmit,
      abort,
      tokenUsage,
    }),
    [abort, activity, agent, historyEpoch, messages, onSubmit, session, streaming, tokenUsage],
  );

  return createElement(AgentLoopContext.Provider, { value }, children);
}

function useAgentLoopState(): AgentLoopState {
  const state = useContext(AgentLoopContext);
  if (!state) {
    throw new Error("useAgentLoop() must be used within <AgentLoopProvider agent={...}>");
  }
  return state;
}

export function useAgentLoop() {
  return useAgentLoopState();
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  if (error instanceof Error && error.constructor.name === "APIUserAbortError") return true;
  return false;
}

function clearTerminal() {
  if (!process.stdout.isTTY) return;
  process.stdout.write("\u001B[2J\u001B[3J\u001B[H");
}

function assistantText(text: string): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function appendAssistantError(error: unknown, setMessages: (value: SetStateAction<NonSystemMessage[]>) => void) {
  setMessages((prev) => [...prev, assistantText(`${publicErrorMessage(error)}\n\nYou can try again.`)]);
}

async function handleModelCommand(controller: SessionController, args: string, append: (message: string) => void) {
  if (!args) {
    const current = controller.snapshot();
    const models = controller
      .modelDescriptors()
      .map((model) => `- ${model.name}${model.name === current.activeModelName ? " (active)" : ""}`)
      .join("\n");
    append(`Active model: ${current.activeModelName ?? "(missing)"}\n\nConfigured models:\n${models}`);
    return;
  }
  try {
    const parts = args.trim().split(/\s+/);
    const result = parts.length > 1
      ? await controller.switchModel(parts.slice(1).join(" "), parts[0])
      : await controller.switchModel(args);
    append(
      `Model for ${result.agentId} set to ${result.modelName}.${result.appliesAfterCurrentTurn ? " It will apply after the current turn finishes." : " It will apply to the next turn."}`,
    );
  } catch (error) {
    append(publicErrorMessage(error));
  }
}

async function handleModeCommand(controller: SessionController, args: string, append: (message: string) => void) {
  if (!args) {
    append(`Execution mode: ${formatExecutionMode(controller.snapshot().activeExecutionMode)}`);
    return;
  }
  const mode = parseExecutionMode(args);
  if (!mode) {
    append("Unknown execution mode. Use `/mode execute` or `/mode dry-run`.");
    return;
  }
  const result = await controller.switchExecutionMode(mode);
  append(
    `Execution mode set to ${formatExecutionMode(result.mode)}.${result.appliesAfterCurrentTurn ? " It will apply after the current turn finishes." : " It will apply to the next turn."}`,
  );
}

function parseExecutionMode(value: string) {
  const normalized = value.trim().toLowerCase();
  if (normalized === "execute") return "execute";
  if (normalized === "dry-run" || normalized === "dry_run") return "dry_run";
  return null;
}

function formatExecutionMode(mode: "execute" | "dry_run") {
  return mode === "dry_run" ? "dry-run" : "execute";
}

async function handleMemoryCommand(controller: SessionController, append: (message: string) => void) {
  try {
    const status = await controller.memoryStatus();
    append(formatMemoryStatus(status));
  } catch (error) {
    append(publicErrorMessage(error));
  }
}

function formatMemoryStatus(status: TerminalMemoryStatus): string {
  if (!status.enabled) {
    return "Memory is disabled. Enable it in settings (`memory.enabled`) to persist long-term knowledge.";
  }
  const lines: string[] = [];
  for (const layer of status.layers) {
    lines.push(`${layer.scope === "global" ? "Global" : "Project"} Memory · ${layer.access} · auto-write ${layer.autoWrite ? "on" : "off"}`);
    lines.push(`Scope: ${layer.scopeId}`);
    lines.push(`Path: ${layer.storageRoot}`);
    if (!layer.materialized || layer.documents.length === 0) {
      lines.push("No memory documents yet.");
    } else {
      lines.push(`Documents (${layer.documents.length}):`);
      for (const document of layer.documents) {
        lines.push(`- ${document.reference}  ${document.sizeBytes}B  ${document.digest}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

async function handleSessionCommand(
  controller: SessionController,
  name: string,
  args: string,
  ui: {
    setMessages: (value: SetStateAction<NonSystemMessage[]>) => void;
    setSession: (value: SetStateAction<SessionControllerSnapshot | null>) => void;
    flushPendingMessages: () => void;
    resetHistory: () => void;
  },
): Promise<boolean> {
  const append = (text: string) => ui.setMessages((prev) => [...prev, assistantText(text)]);
  try {
    if (name === "session") {
      const snapshot = controller.snapshot();
      append(
        `Session: ${snapshot.displayName}\nID: ${snapshot.id}\nDirectory: ${snapshot.cwd}\nActive Agent: ${snapshot.activeAgentId}${snapshot.activeAgentMissing ? " (missing)" : ""}\nActive model: ${snapshot.activeModelName ?? "(missing)"}\nExecution mode: ${formatExecutionMode(snapshot.activeExecutionMode)}\nSaved: ${snapshot.materialized ? "yes" : "draft"}`,
      );
      return true;
    }
    if (name === "sessions") {
      const sessions = await controller.listSessions(args === "--all");
      append(
        sessions.length === 0
          ? "No saved sessions."
          : sessions
              .map(
                (session) =>
                  `${session.shortId}  ${session.displayName}  ${session.updatedAt || "(unknown time)"}  ${session.health}`,
              )
              .join("\n"),
      );
      return true;
    }
    if (name === "resume") {
      if (!args)
        throw new SessionError("SESSION_NOT_FOUND", "Run `/resume <session>` with an id, id prefix or exact name.");
      await controller.resume(args);
      ui.flushPendingMessages();
      ui.setMessages(controller.messages());
      ui.setSession(controller.snapshot());
      ui.resetHistory();
      append(`Resumed ${controller.snapshot().displayName}.`);
      return true;
    }
    if (name === "new") {
      await controller.newDraft(args || undefined);
      ui.flushPendingMessages();
      ui.setMessages([]);
      ui.setSession(controller.snapshot());
      ui.resetHistory();
      append(`Started ${controller.snapshot().displayName}.`);
      return true;
    }
    if (name === "rename") {
      if (!args) throw new SessionError("INVALID_SESSION_NAME", "Run `/rename <name>`.");
      await controller.rename(args);
      ui.setSession(controller.snapshot());
      append(`Renamed session to ${controller.snapshot().displayName}.`);
      return true;
    }
    if (name === "delete") {
      if (args !== "confirm") {
        append("Run `/delete confirm` to permanently delete the current session.");
        return true;
      }
      await controller.deleteCurrent();
      ui.flushPendingMessages();
      ui.setMessages([]);
      ui.setSession(controller.snapshot());
      ui.resetHistory();
      append("Deleted the session and started a new draft.");
      return true;
    }
  } catch (error) {
    append(publicErrorMessage(error));
    return true;
  }
  return false;
}
