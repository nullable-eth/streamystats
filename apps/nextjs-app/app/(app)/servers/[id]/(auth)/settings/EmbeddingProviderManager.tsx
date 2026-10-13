"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import type { ServerPublic } from "@/lib/types";
import {
  type EmbeddingProgress,
  type EmbeddingProvider,
  getEmbeddingProgressAction,
  saveEmbeddingConfigAction,
} from "./embedding-actions";

// Presets for common embedding providers
const PROVIDER_PRESETS = {
  openai: {
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "text-embedding-3-small",
    defaultDimensions: 1536,
    requiresApiKey: true,
    provider: "openai-compatible" as EmbeddingProvider,
  },
  "together-ai": {
    name: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    defaultModel: "togethercomputer/m2-bert-80M-8k-retrieval",
    defaultDimensions: 768,
    requiresApiKey: true,
    provider: "openai-compatible" as EmbeddingProvider,
  },
  fireworks: {
    name: "Fireworks AI",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    defaultModel: "nomic-ai/nomic-embed-text-v1.5",
    defaultDimensions: 768,
    requiresApiKey: true,
    provider: "openai-compatible" as EmbeddingProvider,
  },
  voyage: {
    name: "Voyage AI",
    baseUrl: "https://api.voyageai.com/v1",
    defaultModel: "voyage-2",
    defaultDimensions: 1024,
    requiresApiKey: true,
    provider: "voyage" as EmbeddingProvider,
  },
  openrouter: {
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/text-embedding-3-small",
    defaultDimensions: 1536,
    requiresApiKey: true,
    provider: "openai-compatible" as EmbeddingProvider,
  },
  ollama: {
    name: "Ollama",
    baseUrl: "http://localhost:11434",
    defaultModel: "nomic-embed-text",
    defaultDimensions: 768,
    requiresApiKey: false,
    provider: "ollama" as EmbeddingProvider,
  },
  "lm-studio": {
    name: "LM Studio",
    baseUrl: "http://localhost:1234/v1",
    defaultModel: "text-embedding-nomic-embed-text-v1.5",
    defaultDimensions: 768,
    requiresApiKey: false,
    provider: "openai-compatible" as EmbeddingProvider,
  },
  localai: {
    name: "LocalAI",
    baseUrl: "http://localhost:8080/v1",
    defaultModel: "text-embedding-ada-002",
    defaultDimensions: 1536,
    requiresApiKey: false,
    provider: "openai-compatible" as EmbeddingProvider,
  },
  gemini: {
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini-embedding-001",
    defaultDimensions: 1536, // Native is 3072, but 1536 is recommended for performance
    requiresApiKey: true,
    provider: "gemini" as EmbeddingProvider,
  },
  custom: {
    name: "Custom",
    baseUrl: "",
    defaultModel: "",
    defaultDimensions: 1536,
    requiresApiKey: false,
    provider: "openai-compatible" as EmbeddingProvider,
  },
} as const;

type PresetKey = keyof typeof PROVIDER_PRESETS;

// Detect preset from server config
function detectPreset(server: ServerPublic): PresetKey {
  // Not openai-compatible providers should be detected first regarless of url
  if (server.embeddingProvider === "ollama") {
    return "ollama";
  }

  const baseUrl = server.embeddingBaseUrl || "";
  for (const [key, preset] of Object.entries(PROVIDER_PRESETS)) {
    if (key !== "custom" && baseUrl === preset.baseUrl) {
      return key as PresetKey;
    }
  }
  return baseUrl ? "custom" : "openai";
}

/**
 * Which embedding model to use. What gets embedded, and when, is set in
 * AI Recommendations.
 */
export function EmbeddingProviderManager({ server }: { server: ServerPublic }) {
  const [selectedPreset, setSelectedPreset] = useState<PresetKey>(
    detectPreset(server),
  );
  const [baseUrl, setBaseUrl] = useState(
    server.embeddingBaseUrl || PROVIDER_PRESETS.openai.baseUrl,
  );
  // Don't pre-fill API key for security - just track if one exists
  const [apiKey, setApiKey] = useState("");
  const hasExistingApiKey = server.hasEmbeddingApiKey;
  const [model, setModel] = useState(
    server.embeddingModel || PROVIDER_PRESETS.openai.defaultModel,
  );
  const [dimensions, setDimensions] = useState(
    server.embeddingDimensions || 1536,
  );
  const [provider, setProvider] = useState<EmbeddingProvider>(
    (server.embeddingProvider as EmbeddingProvider) || "openai-compatible",
  );
  const [isSaving, setIsSaving] = useState(false);

  // Read once, for the dimension of the embeddings that already exist.
  const { data: progress } = useQuery<EmbeddingProgress>({
    queryKey: ["embedding-progress", server.id],
    queryFn: async () => await getEmbeddingProgressAction(server.id),
  });
  const existingDimension = progress?.existingDimension;
  const hasDimensionMismatch =
    existingDimension !== null &&
    existingDimension !== undefined &&
    existingDimension !== dimensions;

  const handlePresetChange = (preset: PresetKey) => {
    setSelectedPreset(preset);
    const presetConfig = PROVIDER_PRESETS[preset];
    if (preset === "custom") {
      // Custom defaults to openai-compatible (user can still enter any URL)
      setProvider("openai-compatible");
    } else {
      setBaseUrl(presetConfig.baseUrl);
      setModel(presetConfig.defaultModel);
      setDimensions(presetConfig.defaultDimensions);
      setProvider(presetConfig.provider);
    }
  };

  const handleSaveConfig = async () => {
    setIsSaving(true);
    try {
      await saveEmbeddingConfigAction(server.id, {
        provider,
        baseUrl,
        apiKey: apiKey || undefined,
        model,
        dimensions,
      });
      toast.success("Embedding configuration saved");
    } catch (_error) {
      toast.error("Failed to save embedding configuration");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Embedding Model</CardTitle>
        <CardDescription>
          Turns titles, plots and transcripts into vectors for recommendations,
          the knowledge index and chat search. Supports any OpenAI-compatible
          API. What gets embedded is set in{" "}
          <Link
            href={`/servers/${server.id}/settings/ai`}
            className="underline underline-offset-4"
          >
            AI Recommendations
          </Link>
          .
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="embedding-preset">Provider Preset</Label>
          <Select
            value={selectedPreset}
            onValueChange={(value: PresetKey) => handlePresetChange(value)}
          >
            <SelectTrigger id="embedding-preset">
              <SelectValue placeholder="Select provider" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="openai">OpenAI</SelectItem>
              <SelectItem value="together-ai">Together AI</SelectItem>
              <SelectItem value="fireworks">Fireworks AI</SelectItem>
              <SelectItem value="voyage">Voyage AI</SelectItem>
              <SelectItem value="openrouter">OpenRouter</SelectItem>
              <SelectItem value="ollama">Ollama (Local)</SelectItem>
              <SelectItem value="lm-studio">LM Studio (Local)</SelectItem>
              <SelectItem value="localai">LocalAI (Local)</SelectItem>
              <SelectItem value="gemini">Google Gemini</SelectItem>
              <SelectItem value="custom">Custom</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Select a preset or choose Custom for any OpenAI-compatible API
          </p>
        </div>

        <Separator />

        <div className="space-y-4">
          <h3 className="text-sm font-medium">
            {PROVIDER_PRESETS[selectedPreset].name} Configuration
          </h3>

          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="embedding-base-url">Base URL</Label>
              <Input
                id="embedding-base-url"
                placeholder="https://api.openai.com/v1"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="embedding-api-key">
                API Key{" "}
                {!PROVIDER_PRESETS[selectedPreset].requiresApiKey &&
                  "(Optional)"}
              </Label>
              <Input
                id="embedding-api-key"
                type="password"
                placeholder={
                  hasExistingApiKey
                    ? "API key saved (enter new key to replace)"
                    : PROVIDER_PRESETS[selectedPreset].requiresApiKey
                      ? "Required"
                      : "Optional"
                }
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              {hasExistingApiKey && !apiKey && (
                <p className="text-xs text-green-600 dark:text-green-400">
                  An API key is already saved. Leave empty to keep it.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="embedding-model">Model</Label>
              <Input
                id="embedding-model"
                placeholder="text-embedding-3-small"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Enter the embedding model name supported by your provider
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="embedding-dimensions">Dimensions</Label>
              <Input
                id="embedding-dimensions"
                type="number"
                placeholder="1536"
                value={dimensions}
                onChange={(e) =>
                  setDimensions(Number.parseInt(e.target.value, 10) || 1536)
                }
              />
              <p className="text-xs text-muted-foreground">
                Must match your embedding model output. OpenAI models support
                dimension reduction via the dimensions parameter.
                {existingDimension && (
                  <span className="block mt-1">
                    Current embeddings: {existingDimension} dimensions
                  </span>
                )}
              </p>
              {dimensions > 2000 && (
                <div className="mt-2 p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-md">
                  <p className="text-xs text-yellow-600 dark:text-yellow-400 font-medium">
                    Dimensions over 2000 skip the HNSW index (pgvector limit).
                    Queries will work but may be slower for large libraries.
                  </p>
                </div>
              )}
              {hasDimensionMismatch && (
                <div className="mt-2 p-3 bg-destructive/10 border border-destructive/20 rounded-md">
                  <p className="text-xs text-destructive font-medium">
                    Dimension mismatch: existing embeddings have{" "}
                    {existingDimension} dimensions, but configured is{" "}
                    {dimensions}. Clear existing embeddings in AI
                    Recommendations before changing dimensions.
                  </p>
                </div>
              )}
            </div>

            {selectedPreset === "ollama" && (
              <div className="text-xs text-muted-foreground space-y-1 p-3 bg-muted rounded-md">
                <p>Make sure the model is available in your Ollama instance:</p>
                <code className="bg-background px-2 py-1 rounded text-xs block">
                  ollama pull {model}
                </code>
              </div>
            )}

            <Button
              type="button"
              onClick={handleSaveConfig}
              disabled={isSaving || !baseUrl || !model}
              className="w-full"
            >
              {isSaving ? "Saving..." : "Save Configuration"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
