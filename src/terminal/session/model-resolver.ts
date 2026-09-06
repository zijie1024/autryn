import { Model } from "@/core";
import { AnthropicModelProvider } from "@/providers/anthropic";
import { OpenAIModelProvider } from "@/providers/openai";
import { type EffectiveModelSnapshot, SessionError } from "@/sessions";
import type { AutrynConfig, ModelEntry } from "@/terminal/config";
import { findModelEntry, getDefaultModelEntry } from "@/terminal/config";

export interface ResolvedModel {
  entry: ModelEntry;
  model: Model;
  effective: EffectiveModelSnapshot;
}

export class ModelResolver {
  constructor(private readonly config: AutrynConfig) {}

  configuration(): AutrynConfig {
    return this.config;
  }

  defaultModel(): ResolvedModel {
    const entry = getDefaultModelEntry(this.config);
    if (!entry) throw new SessionError("MODEL_CONFIG_NOT_FOUND", "No default model is configured.");
    return this.resolve(entry.id);
  }

  resolve(configId: string): ResolvedModel {
    const entry = this.config.models.find((model) => model.id === configId);
    if (!entry) {
      throw new SessionError("MODEL_CONFIG_NOT_FOUND", "The session's active model configuration no longer exists.");
    }
    return this.build(entry);
  }

  resolveSelector(selector: string): ResolvedModel {
    const entry = findModelEntry(this.config, selector);
    if (!entry) {
      throw new SessionError("MODEL_CONFIG_NOT_FOUND", `Model "${selector}" is not configured.`);
    }
    return this.build(entry);
  }

  listDescriptors(): Array<Omit<ModelEntry, "APIKey">> {
    return this.config.models.map(({ APIKey: _APIKey, ...entry }) => entry);
  }

  summaryModel(active: ResolvedModel): ResolvedModel {
    const id = this.config.contextCompaction?.summaryModelConfigId;
    const resolved = id ? this.resolve(id) : active;
    return {
      ...resolved,
      model: resolved.model.withOptions({
        max_tokens: Math.min(resolved.entry.maxOutputTokens ?? 16 * 1024, 2048),
      }),
    };
  }

  hasConfig(configId: string): boolean {
    return this.config.models.some((model) => model.id === configId);
  }

  private build(entry: ModelEntry): ResolvedModel {
    const provider =
      entry.provider === "anthropic"
        ? new AnthropicModelProvider({ baseURL: entry.baseURL, apiKey: entry.APIKey })
        : new OpenAIModelProvider({ baseURL: entry.baseURL, apiKey: entry.APIKey });
    return {
      entry,
      model: new Model(
        entry.model,
        provider,
        {
          max_tokens: 16 * 1024,
          thinking: {
            type: "enabled",
          },
        },
        {
          contextWindowTokens: entry.contextWindowTokens,
          maxOutputTokens: entry.maxOutputTokens ?? 16 * 1024,
        },
      ),
      effective: {
        configId: entry.id,
        configName: entry.name,
        provider: entry.provider,
        model: entry.model,
      },
    };
  }
}
