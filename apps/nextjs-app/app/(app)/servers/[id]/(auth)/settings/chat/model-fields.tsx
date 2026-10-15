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
import type { ChatProvider } from "./actions";

/** Where a chat-style model is reached: shared by the chat model and the knowledge index models. */
export const PROVIDER_PRESETS = {
  openai: {
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    requiresApiKey: true,
    provider: "openai-compatible" as ChatProvider,
  },
  anthropic: {
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    defaultModel: "claude-sonnet-5-5",
    requiresApiKey: true,
    provider: "anthropic" as ChatProvider,
  },
  gemini: {
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini-3.8-flash-high",
    requiresApiKey: true,
    provider: "gemini" as ChatProvider,
  },
  "together-ai": {
    name: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    requiresApiKey: true,
    provider: "openai-compatible" as ChatProvider,
  },
  fireworks: {
    name: "Fireworks AI",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    defaultModel: "accounts/fireworks/models/llama-v3p1-70b-instruct",
    requiresApiKey: true,
    provider: "openai-compatible" as ChatProvider,
  },
  groq: {
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    requiresApiKey: true,
    provider: "openai-compatible" as ChatProvider,
  },
  openrouter: {
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4o-mini",
    requiresApiKey: true,
    provider: "openai-compatible" as ChatProvider,
  },
  ollama: {
    name: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "llama3.2",
    requiresApiKey: false,
    provider: "ollama" as ChatProvider,
  },
  "lm-studio": {
    name: "LM Studio",
    baseUrl: "http://localhost:1234/v1",
    defaultModel: "local-model",
    requiresApiKey: false,
    provider: "openai-compatible" as ChatProvider,
  },
  custom: {
    name: "Custom",
    baseUrl: "",
    defaultModel: "",
    requiresApiKey: false,
    provider: "openai-compatible" as ChatProvider,
  },
} as const;

export type PresetKey = keyof typeof PROVIDER_PRESETS;

export function detectPreset(
  provider: string | null,
  baseUrl: string | null,
): PresetKey {
  // Not openai-compatible providers should be detected first regarless of url
  if (provider === "anthropic") {
    return "anthropic";
  }
  if (provider === "ollama") {
    return "ollama";
  }
  if (provider === "gemini") {
    return "gemini";
  }

  for (const [key, preset] of Object.entries(PROVIDER_PRESETS)) {
    if (key !== "custom" && (baseUrl || "") === preset.baseUrl) {
      return key as PresetKey;
    }
  }
  return baseUrl ? "custom" : "openai";
}

export interface ModelSettings {
  preset: PresetKey;
  provider: ChatProvider;
  baseUrl: string;
  /** Entered here; empty keeps a saved key. */
  apiKey: string;
  model: string;
}

/** The form's starting values: a saved model's, or OpenAI's defaults. */
export function initialSettings(saved?: {
  provider: string | null;
  baseUrl: string | null;
  model: string | null;
}): ModelSettings {
  return {
    preset: detectPreset(saved?.provider ?? null, saved?.baseUrl ?? null),
    provider: (saved?.provider as ChatProvider) || "openai-compatible",
    baseUrl: saved?.baseUrl || PROVIDER_PRESETS.openai.baseUrl,
    apiKey: "",
    model: saved?.model || PROVIDER_PRESETS.openai.defaultModel,
  };
}

/** Whether the settings can be tested: an address, a model, and a key where one is needed. */
export function isComplete(settings: ModelSettings, hasSavedKey: boolean) {
  if (
    PROVIDER_PRESETS[settings.preset].requiresApiKey &&
    !hasSavedKey &&
    !settings.apiKey
  ) {
    return false;
  }
  return Boolean(settings.baseUrl && settings.model);
}

export function ModelFields({
  id,
  value,
  onChange,
  hasSavedKey,
}: {
  /** Prefix for the fields' ids, unique on the page. */
  id: string;
  value: ModelSettings;
  onChange: (value: ModelSettings) => void;
  hasSavedKey: boolean;
}) {
  const preset = PROVIDER_PRESETS[value.preset];
  const set = (change: Partial<ModelSettings>) =>
    onChange({ ...value, ...change });
  const choosePreset = (key: PresetKey) => {
    const chosen = PROVIDER_PRESETS[key];
    set(
      key === "custom"
        ? { preset: key, provider: "openai-compatible" }
        : {
            preset: key,
            provider: chosen.provider,
            baseUrl: chosen.baseUrl,
            model: chosen.defaultModel,
          },
    );
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor={`${id}-preset`}>Provider</Label>
        <Select
          value={value.preset}
          onValueChange={(key: PresetKey) => choosePreset(key)}
        >
          <SelectTrigger id={`${id}-preset`}>
            <SelectValue placeholder="Select provider" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="openai">OpenAI</SelectItem>
            <SelectItem value="anthropic">Anthropic (Claude)</SelectItem>
            <SelectItem value="gemini">Google Gemini</SelectItem>
            <SelectItem value="together-ai">Together AI</SelectItem>
            <SelectItem value="fireworks">Fireworks AI</SelectItem>
            <SelectItem value="groq">Groq</SelectItem>
            <SelectItem value="openrouter">OpenRouter</SelectItem>
            <SelectItem value="ollama">Ollama (Local)</SelectItem>
            <SelectItem value="lm-studio">LM Studio (Local)</SelectItem>
            <SelectItem value="custom">Custom</SelectItem>
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
          placeholder="gpt-4o-mini"
          value={value.model}
          onChange={(e) => set({ model: e.target.value })}
        />
        <p className="text-xs text-muted-foreground">
          Enter the chat model name supported by your provider
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
