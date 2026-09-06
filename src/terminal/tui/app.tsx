import { Box, Static, Text } from "ink";
import { useMemo } from "react";

import type { SlashCommand } from "./command-registry";
import { ApprovalPrompt } from "./components/approval-prompt";
import { AskUserQuestionPrompt } from "./components/ask-user-question-prompt";
import { Footer } from "./components/footer";
import { Header } from "./components/header";
import { InputBox } from "./components/input-box";
import { MessageHistoryItem } from "./components/message-history";
import { StreamingIndicator } from "./components/streaming-indicator";
import { TodoPanel } from "./components/todo-panel";
import { useAgentLoop } from "./hooks/use-agent-loop";
import { useApprovalManager } from "./hooks/use-approval-manager";
import { useAskUserQuestionManager } from "./hooks/use-ask-user-question-manager";
import { currentTheme } from "./themes";
import { buildTodoViewState, getNextTodo } from "./todo-view";

function allDone(todos?: { status: string }[]) {
  return !!todos?.length && todos.every((t) => t.status === "completed" || t.status === "cancelled");
}

export function App({
  commands,
  supportProjectWideAllow = false,
}: {
  commands: SlashCommand[];
  supportProjectWideAllow?: boolean;
}) {
  const { streaming, activity, messages, historyEpoch, onSubmit, abort } = useAgentLoop();
  const { approvalRequest, respondToApproval } = useApprovalManager();
  const { askUserQuestionRequest, respondWithAnswers } = useAskUserQuestionManager();
  const { latestTodos, todoSnapshots } = useMemo(() => buildTodoViewState(messages), [messages]);
  const nextTodo = getNextTodo(latestTodos)?.content;
  const hideTodos = !streaming && allDone(latestTodos);

  const lastMessage = messages.length > 0 ? messages[messages.length - 1]! : undefined;
  const completedMessages = messages.slice(0, -1);

  return (
    <Box flexDirection="column" width="100%">
      <Static key={historyEpoch} items={completedMessages}>
        {(message, index) => (
          <MessageHistoryItem
            key={`history:${index}:${message.role}`}
            message={message}
            messageIndex={index}
            todoSnapshots={todoSnapshots}
          />
        )}
      </Static>
      {messages.length === 0 && <Header />}
      <Box flexDirection="column" marginTop={messages.length === 0 ? 1 : 0} rowGap={1}>
        {lastMessage && (
          <MessageHistoryItem
            key={`msg:${lastMessage.role}:${messages.length - 1}`}
            message={lastMessage}
            messageIndex={messages.length - 1}
            todoSnapshots={todoSnapshots}
          />
        )}
        {approvalRequest || askUserQuestionRequest ? null : (
          <StreamingIndicator streaming={streaming} nextTodo={nextTodo} />
        )}
        {activity && <Text color={currentTheme.colors.dimText}>{activity}</Text>}
        {!hideTodos && <TodoPanel todos={latestTodos} />}
        {approvalRequest ? (
          <ApprovalPrompt
            toolUse={approvalRequest.toolUse}
            execution={approvalRequest.execution}
            supportProjectWideAllow={supportProjectWideAllow}
            onDecision={respondToApproval}
          />
        ) : askUserQuestionRequest ? (
          <AskUserQuestionPrompt questions={askUserQuestionRequest.params.questions} onSubmit={respondWithAnswers} />
        ) : (
          <InputBox commands={commands} onSubmit={onSubmit} onAbort={abort} />
        )}
      </Box>
      <Footer />
    </Box>
  );
}
