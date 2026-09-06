import { Box, render, Text, useInput } from "ink";
import { useState } from "react";

import type { AutrynConfig } from "@/terminal/config";

import { currentTheme } from "../tui/themes";

import { runModelWizard } from "./model-wizard";

type ExecutionMode = AutrynConfig["defaultExecutionMode"];

const EXECUTION_MODE_OPTIONS: ReadonlyArray<{
  value: ExecutionMode;
  label: string;
  description: string;
}> = [
  {
    value: "execute",
    label: "Execute",
    description: "Run Tools normally, subject to Tool Approval and Runtime policy.",
  },
  {
    value: "dry_run",
    label: "Dry-run",
    description: "Read normally and preview persistent mutations without applying them.",
  },
];

function WelcomeScreen({ onContinue, onAbort }: { onContinue: () => void; onAbort: () => void }) {
  useInput((_input, key) => {
    if (key.return) {
      onContinue();
    }
    if (key.escape) {
      onAbort();
    }
  });

  console.info(` ___  _  _ ___ ___  _  _ ___
|__| |  |  |  |_/   \\/  |\\ |
|  | |__|  |  | \\_   |  | \\| \n\n`);

  return (
    <Box flexDirection="column" rowGap={1}>
      <Text bold color="cyan">
        Welcome to Autryn
      </Text>
      <Text>First run setup: configure a model and choose the default execution mode.</Text>
      <Text color={currentTheme.colors.dimText}>Press Enter to continue, or Esc to quit.</Text>
    </Box>
  );
}

function showWelcomeScreen(): Promise<void> {
  return new Promise((resolve) => {
    const instance = render(
      <WelcomeScreen
        onContinue={() => {
          instance.unmount();
          resolve();
        }}
        onAbort={() => {
          instance.unmount();
          process.exit(1);
        }}
      />,
    );
  });
}

export function ExecutionModeScreen({
  onComplete,
  onAbort,
}: {
  onComplete: (mode: ExecutionMode) => void;
  onAbort: () => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((_input, key) => {
    if (key.upArrow) {
      setSelectedIndex((current) => (current - 1 + EXECUTION_MODE_OPTIONS.length) % EXECUTION_MODE_OPTIONS.length);
    } else if (key.downArrow) {
      setSelectedIndex((current) => (current + 1) % EXECUTION_MODE_OPTIONS.length);
    } else if (key.return) {
      onComplete(EXECUTION_MODE_OPTIONS[selectedIndex]!.value);
    } else if (key.escape) {
      onAbort();
    }
  });

  return (
    <Box flexDirection="column" rowGap={1}>
      <Text bold>Select the default execution mode (↑/↓ to move, Enter to confirm)</Text>
      {EXECUTION_MODE_OPTIONS.map((option, index) => (
        <Box key={option.value} flexDirection="column">
          <Text color={index === selectedIndex ? currentTheme.colors.primary : undefined}>
            {index === selectedIndex ? "❯" : " "} {option.label}
          </Text>
          <Text color={currentTheme.colors.dimText}> {option.description}</Text>
        </Box>
      ))}
      <Text color={currentTheme.colors.dimText}>You can change the active Session later with `/mode`.</Text>
    </Box>
  );
}

function selectExecutionMode(): Promise<ExecutionMode> {
  return new Promise((resolve) => {
    const instance = render(
      <ExecutionModeScreen
        onComplete={(mode) => {
          instance.unmount();
          resolve(mode);
        }}
        onAbort={() => {
          instance.unmount();
          process.exit(1);
        }}
      />,
    );
  });
}

export async function runFirstRunWizard(): Promise<AutrynConfig> {
  await showWelcomeScreen();
  const entry = await runModelWizard();
  const defaultExecutionMode = await selectExecutionMode();
  return {
    models: [entry],
    agentGroups: [
      {
        id: "default-coding",
        name: "Default Coding",
        entryAgentId: "code",
        defaults: { modelConfigId: entry.id },
        agents: [
          {
            id: "code",
            name: "Code",
            description: "Handles the current coding task.",
            delegates: [],
            handoffs: [],
          },
        ],
      },
    ],
    defaultAgentGroupId: "default-coding",
    defaultExecutionMode,
  };
}
