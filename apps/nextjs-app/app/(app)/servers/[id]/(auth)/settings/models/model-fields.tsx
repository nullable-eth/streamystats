"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Where a model is reached; the first is the default, "custom" any other address. */
export interface Preset {
  name: string;
  baseUrl: string;
  defaultModel: string;
  requiresApiKey: boolean;
  provider: string;
  local?: boolean;
  /** Embedding models only. */
  defaultDimensions?: number;
}
export type Presets = Record<string, Preset> & { custom: Preset };

/** Chat models: the chat assistant and the knowledge index. */
export const CHAT_PRESETS: Presets = {
  openai: {
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    requiresApiKey: true,
    provider: "openai-compatible",
  },
  anthropic: {
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    defaultModel: "claude-sonnet-5-5",
    requiresApiKey: true,
    provider: "anthropic",
  },
  gemini: {
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini-3.8-flash-high",
    requiresApiKey: true,
    provider: "gemini",
  },
  "together-ai": {
    name: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    requiresApiKey: true,
    provider: "openai-compatible",
  },
  fireworks: {
    name: "Fireworks AI",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    defaultModel: "accounts/fireworks/models/llama-v3p1-70b-instruct",
    requiresApiKey: true,
    provider: "openai-compatible",
  },
  groq: {
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    requiresApiKey: true,
    provider: "openai-compatible",
  },
  openrouter: {
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4o-mini",
    requiresApiKey: true,
    provider: "openai-compatible",
  },
  ollama: {
    name: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "llama3.2",
    requiresApiKey: false,
    provider: "ollama",
    local: true,
  },
  "lm-studio": {
    name: "LM Studio",
    baseUrl: "http://localhost:1234/v1",
    defaultModel: "local-model",
    requiresApiKey: false,
    provider: "openai-compatible",
    local: true,
  },
  custom: {
    name: "Custom",
    baseUrl: "",
    defaultModel: "",
    requiresApiKey: false,
    provider: "openai-compatible",
  },
};

export const EMBEDDING_PRESETS: Presets = {
  openai: {
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "text-embedding-3-small",
    defaultDimensions: 1536,
    requiresApiKey: true,
    provider: "openai-compatible",
  },
  "together-ai": {
    name: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    defaultModel: "togethercomputer/m2-bert-80M-8k-retrieval",
    defaultDimensions: 768,
    requiresApiKey: true,
    provider: "openai-compatible",
  },
  fireworks: {
    name: "Fireworks AI",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    defaultModel: "nomic-ai/nomic-embed-text-v1.5",
    defaultDimensions: 768,
    requiresApiKey: true,
    provider: "openai-compatible",
  },
  voyage: {
    name: "Voyage AI",
    baseUrl: "https://api.voyageai.com/v1",
    defaultModel: "voyage-2",
    defaultDimensions: 1024,
    requiresApiKey: true,
    provider: "voyage",
  },
  openrouter: {
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/text-embedding-3-small",
    defaultDimensions: 1536,
    requiresApiKey: true,
    provider: "openai-compatible",
  },
  ollama: {
    name: "Ollama",
    baseUrl: "http://localhost:11434",
    defaultModel: "nomic-embed-text",
    defaultDimensions: 768,
    requiresApiKey: false,
    provider: "ollama",
    local: true,
  },
  "lm-studio": {
    name: "LM Studio",
    baseUrl: "http://localhost:1234/v1",
    defaultModel: "text-embedding-nomic-embed-text-v1.5",
    defaultDimensions: 768,
    requiresApiKey: false,
    provider: "openai-compatible",
    local: true,
  },
  localai: {
    name: "LocalAI",
    baseUrl: "http://localhost:8080/v1",
    defaultModel: "text-embedding-ada-002",
    defaultDimensions: 1536,
    requiresApiKey: false,
    provider: "openai-compatible",
    local: true,
  },
  gemini: {
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini-embedding-001",
    defaultDimensions: 1536, // Native is 3072, but 1536 is recommended for performance
    requiresApiKey: true,
    provider: "gemini",
  },
  custom: {
    name: "Custom",
    baseUrl: "",
    defaultModel: "",
    defaultDimensions: 1536,
    requiresApiKey: false,
    provider: "openai-compatible",
  },
};

/** The preset a saved model matches: by provider where it has its own API, else by address. */
export function detectPreset(
  presets: Presets,
  provider: string | null,
  baseUrl: string | null,
): string {
  if (provider && provider !== "openai-compatible") {
    const own = Object.entries(presets).find(
      ([key, p]) => key !== "custom" && p.provider === provider,
    );
    if (own) return own[0];
  }
  for (const [key, preset] of Object.entries(presets)) {
    if (key !== "custom" && (baseUrl || "") === preset.baseUrl) return key;
  }
  return baseUrl ? "custom" : Object.keys(presets)[0];
}

export interface ModelSettings {
  preset: string;
  provider: string;
  baseUrl: string;
  /** Entered here; empty keeps a saved key. */
  apiKey: string;
  model: string;
}

export interface SavedModel {
  provider: string | null;
  baseUrl: string | null;
  model: string | null;
}

/** The form's starting values: a saved model's, or the first preset's. */
export function initialSettings(
  presets: Presets,
  saved?: SavedModel | null,
): ModelSettings {
  const first = Object.values(presets)[0];
  return {
    preset: detectPreset(
      presets,
      saved?.provider ?? null,
      saved?.baseUrl ?? null,
    ),
    provider: saved?.provider || first.provider,
    baseUrl: saved?.baseUrl || first.baseUrl,
    apiKey: "",
    model: saved?.model || first.defaultModel,
  };
}

/** Whether the settings can be tested: an address, a model, and a key where one is needed. */
export function isComplete(
  presets: Presets,
  settings: ModelSettings,
  hasSavedKey: boolean,
) {
  if (
    presets[settings.preset]?.requiresApiKey &&
    !hasSavedKey &&
    !settings.apiKey
  ) {
    return false;
  }
  return Boolean(settings.baseUrl && settings.model);
}

export function ModelFields({
  id,
  presets,
  value,
  onChange,
  hasSavedKey,
}: {
  /** Prefix for the fields' ids, unique on the page. */
  id: string;
  presets: Presets;
  value: ModelSettings;
  /** Gets the new settings, and the chosen preset when that changed. */
  onChange: (value: ModelSettings, preset?: Preset) => void;
  hasSavedKey: boolean;
}) {
  const preset = presets[value.preset] ?? presets.custom;
  const set = (change: Partial<ModelSettings>) =>
    onChange({ ...value, ...change });
  const choosePreset = (key: string) => {
    const chosen = presets[key];
    onChange(
      key === "custom"
        ? { ...value, preset: key, provider: chosen.provider }
        : {
            ...value,
            preset: key,
            provider: chosen.provider,
            baseUrl: chosen.baseUrl,
            model: chosen.defaultModel,
          },
      chosen,
    );
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor={`${id}-preset`}>Provider</Label>
        <Select value={value.preset} onValueChange={choosePreset}>
          <SelectTrigger id={`${id}-preset`}>
            <SelectValue placeholder="Select provider" />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(presets).map(([key, p]) => (
              <SelectItem key={key} value={key}>
                {p.name}
                {p.local ? " (Local)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Select a provider or choose Custom for any OpenAI-compatible API
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${id}-base-url`}>Base URL</Label>
        <Input
          id={`${id}-base-url`}
          placeholder="https://api.openai.com/v1"
          value={value.baseUrl}
          onChange={(e) => set({ baseUrl: e.target.value })}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${id}-api-key`}>
          API Key {!preset.requiresApiKey && "(Optional)"}
        </Label>
        <Input
          id={`${id}-api-key`}
          type="password"
          placeholder={
            hasSavedKey
              ? "API key saved (enter new key to replace)"
              : preset.requiresApiKey
                ? "Required"
                : "Optional"
          }
          value={value.apiKey}
          onChange={(e) => set({ apiKey: e.target.value })}
        />
        {hasSavedKey && !value.apiKey && (
          <p className="text-xs text-green-600 dark:text-green-400">
            An API key is already saved. Leave empty to keep it.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${id}-model`}>Model</Label>
        <Input
          id={`${id}-model`}
          placeholder={preset.defaultModel || "model name"}
          value={value.model}
          onChange={(e) => set({ model: e.target.value })}
        />
        <p className="text-xs text-muted-foreground">
          Enter the model name supported by your provider
        </p>
      </div>

      {value.preset === "ollama" && (
        <div className="text-xs text-muted-foreground space-y-1 p-3 bg-muted rounded-md">
          <p>Make sure the model is available in your Ollama instance:</p>
          <code className="bg-background px-2 py-1 rounded text-xs block">
            ollama pull {value.model}
          </code>
        </div>
      )}
    </div>
  );
}
