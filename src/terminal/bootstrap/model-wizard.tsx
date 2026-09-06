import { Box, render, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useState } from "react";

import type { ModelEntry } from "@/terminal/config";

import { buildEntryFromProviderOption, maskSecret, PROVIDER_OPTIONS, type ProviderOption } from "../provider-options";
import { currentTheme } from "../tui/themes";

type Step = "provider" | "apiKey" | "modelName" | "contextWindow" | "baseURL" | "confirm";

type ModelWizardProps = {
  onComplete: (entry: ModelEntry) => void;
  onAbort: () => void;
};

export function ModelWizard({ onComplete, onAbort }: ModelWizardProps) {
  const [step, setStep] = useState<Step>("provider");
  const [providerIndex, setProviderIndex] = useState(0);
  const [apiKey, setApiKey] = useState("");
  const [modelName, setModelName] = useState("");
  const [contextWindowTokens, setContextWindowTokens] = useState("");
  const [customBaseURL, setCustomBaseURL] = useState("");
  const [pendingEntry, setPendingEntry] = useState<ModelEntry | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);

  const resetWizard = () => {
    setStep("provider");
    setProviderIndex(0);
    setApiKey("");
    setModelName("");
    setContextWindowTokens("");
    setCustomBaseURL("");
    setPendingEntry(null);
    setStepError(null);
  };

  const textSteps = step === "apiKey" || step === "modelName" || step === "contextWindow" || step === "baseURL";

  useInput(
    (_input, key) => {
      if (key.escape && textSteps) {
        onAbort();
      }
    },
    { isActive: textSteps },
  );

  useInput(
    (_input, key) => {
      if (step === "provider") {
        if (key.upArrow) {
          setProviderIndex((i) => (i > 0 ? i - 1 : PROVIDER_OPTIONS.length - 1));
        }
        if (key.downArrow) {
          setProviderIndex((i) => (i < PROVIDER_OPTIONS.length - 1 ? i + 1 : 0));
        }
        if (key.return) {
          setStepError(null);
          setStep("apiKey");
        }
        if (key.escape) {
          onAbort();
        }
      }
    },
    { isActive: step === "provider" },
  );

  const selectedProvider = PROVIDER_OPTIONS[providerIndex]!;

  const buildPendingEntry = (input: {
    modelName: string;
    apiKey: string;
    contextWindowTokens: string;
    customBaseURL?: string;
  }) => {
    const result = buildEntryFromProviderOption(selectedProvider, input);
    if (!result.ok) {
      setStepError(result.issues.map((issue) => issue.error).join("\n"));
      return;
    }
    setStepError(null);
    setPendingEntry(result.entry);
    setStep("confirm");
  };

  const submitApiKey = () => {
    if (apiKey.trim().length === 0) {
      setStepError("API key must not be empty. Enter the API key for this provider.");
      return;
    }
    setStepError(null);
    setStep("modelName");
  };

  const submitModelName = () => {
    if (modelName.trim().length === 0) {
      setStepError("Model name must not be empty. Enter a name, e.g. `gpt-4o`.");
      return;
    }
    setStepError(null);
    setStep("contextWindow");
  };

  const submitContextWindow = () => {
    setStepError(null);
    if (selectedProvider.requiresCustomBaseURL) {
      setStep("baseURL");
      return;
    }
    buildPendingEntry({ modelName, apiKey, contextWindowTokens });
  };

  const submitBaseURL = () => {
    buildPendingEntry({ modelName, apiKey, contextWindowTokens, customBaseURL });
  };

  useInput(
    (input, key) => {
      if (step !== "confirm") {
        return;
      }
      if (key.return) {
        if (pendingEntry) {
          onComplete(pendingEntry);
        }
        return;
      }
      if (key.escape || input === "n" || input === "N") {
        resetWizard();
      }
    },
    { isActive: step === "confirm" },
  );

  if (step === "provider") {
    return (
      <Box flexDirection="column">
        <Text bold>Select a model provider (↑/↓ to move, Enter to confirm)</Text>
        <Text color={currentTheme.colors.dimText}>
          Official entries use the provider&apos;s own endpoint. Custom entries work with any compatible endpoint you
          specify.
        </Text>
        {PROVIDER_OPTIONS.map((option, i) => (
          <Text key={option.id} color={i === providerIndex ? "cyan" : undefined}>
            {i === providerIndex ? "❯ " : "  "}
            {option.label}
          </Text>
        ))}
      </Box>
    );
  }

  if (step === "apiKey") {
    return (
      <Box flexDirection="column" rowGap={1}>
        <Text>
          Provider: {selectedProvider.label}
          {selectedProvider.requiresCustomBaseURL ? "" : ` (${selectedProvider.officialBaseURL})`}
        </Text>
        <Text bold>Enter your API key</Text>
        <Box>
          <Text>API Key: </Text>
          <TextInput mask="*" value={apiKey} onChange={setApiKey} onSubmit={submitApiKey} />
        </Box>
        {stepError ? <Text color="red">{stepError}</Text> : null}
        <Text color={currentTheme.colors.dimText}>Press Enter to continue (Esc to cancel)</Text>
      </Box>
    );
  }

  if (step === "modelName") {
    return (
      <Box flexDirection="column" rowGap={1}>
        <Text bold>Enter a model name</Text>
        <Box>
          <Text>Model: </Text>
          <TextInput
            value={modelName}
            placeholder="e.g. gpt-4o or claude-sonnet-4-5"
            onChange={setModelName}
            onSubmit={submitModelName}
          />
        </Box>
        {stepError ? <Text color="red">{stepError}</Text> : null}
        <Text color={currentTheme.colors.dimText}>Press Enter to continue (Esc to cancel)</Text>
      </Box>
    );
  }

  if (step === "confirm") {
    const entry = pendingEntry;
    if (!entry) {
      return (
        <Box flexDirection="column">
          <Text color="red">No pending config. Restarting…</Text>
        </Box>
      );
    }

    return (
      <Box flexDirection="column" rowGap={1}>
        <Text bold color="cyan">
          Last confirmation
        </Text>
        <Text>Provider: {selectedProvider.label}</Text>
        <Text>Model: {entry.name}</Text>
        <Text>Context Window: {entry.contextWindowTokens} tokens</Text>
        <Text>baseURL: {entry.baseURL}</Text>
        <Text>API Key: {maskSecret(entry.APIKey)}</Text>
        <Text color={currentTheme.colors.dimText}>Enter to confirm (n or Esc to restart)</Text>
      </Box>
    );
  }

  if (step === "contextWindow") {
    return (
      <Box flexDirection="column" rowGap={1}>
        <Text bold>Enter the model context window</Text>
        <Box>
          <Text>Context Window Tokens: </Text>
          <TextInput
            value={contextWindowTokens}
            placeholder="e.g. 128000"
            onChange={setContextWindowTokens}
            onSubmit={submitContextWindow}
          />
        </Box>
        {stepError ? <Text color="red">{stepError}</Text> : null}
        <Text color={currentTheme.colors.dimText}>Press Enter to continue (Esc to cancel)</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" rowGap={1}>
      <Text bold>Enter the base URL for this {providerKindPhrase(selectedProvider)} endpoint</Text>
      <Box>
        <Text>baseURL: </Text>
        <TextInput value={customBaseURL} onChange={setCustomBaseURL} onSubmit={submitBaseURL} />
      </Box>
      {stepError ? <Text color="red">{stepError}</Text> : null}
      <Text color={currentTheme.colors.dimText}>
        Use an absolute http(s) URL, e.g. http://localhost:8080/v1 (Esc to cancel)
      </Text>
    </Box>
  );
}

function providerKindPhrase(option: ProviderOption): string {
  return option.providerType === "anthropic" ? "Anthropic-compatible" : "OpenAI-compatible";
}

export function runModelWizard(): Promise<ModelEntry> {
  return new Promise((resolve) => {
    const instance = render(
      <ModelWizard
        onComplete={(entry) => {
          instance.unmount();
          resolve(entry);
        }}
        onAbort={() => {
          instance.unmount();
          process.exit(1);
        }}
      />,
    );
  });
}
