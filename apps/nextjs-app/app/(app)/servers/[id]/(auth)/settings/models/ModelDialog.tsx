"use client";

import { useQuery } from "@tanstack/react-query";
import { Loader, Zap } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  type ChatProvider,
  saveChatConfigAction,
  testChatConnectionAction,
} from "../chat/actions";
import {
  type EmbeddingProvider,
  getEmbeddingProgressAction,
  saveEmbeddingConfigAction,
} from "../embedding-actions";
import {
  saveKnowledgeModelAction,
  testKnowledgeModelAction,
} from "./knowledge-model-actions";
import {
  CHAT_PRESETS,
  EMBEDDING_PRESETS,
  initialSettings,
  isComplete,
  ModelFields,
  type ModelSettings,
  type Presets,
  type SavedModel,
} from "./model-fields";

export type ModelUse = "chat" | "knowledge" | "embedding";

export const USES: Record<
  ModelUse,
  { label: string; presets: Presets; about: string }
> = {
  chat: {
    label: "Chat assistant",
    presets: CHAT_PRESETS,
    about: "The model the chat assistant (Cmd+K) answers with. One at a time.",
  },
  knowledge: {
    label: "Knowledge index",
    presets: CHAT_PRESETS,
    about:
      "Writes each title's scene notes and synopsis. Listed models are tried in order; one that is rate limited or out of credit rests until it can be used again.",
  },
  embedding: {
    label: "Embeddings",
    presets: EMBEDDING_PRESETS,
    about:
      "Turns titles, plots and transcripts into vectors for search and recommendations. One at a time.",
  },
};

/** The model being added or changed. */
export interface Editing {
  use: ModelUse;
  /** Adding: the use can still be chosen. */
  adding: boolean;
  /** A knowledge index model's id. */
  id?: number;
  saved: SavedModel | null;
  hasSavedKey: boolean;
  dimensions?: number | null;
  name?: string | null;
}

export function ModelDialog({
  serverId,
  editing,
  replaces,
  onClose,
}: {
  serverId: number;
  editing: Editing;
  /** Uses that hold one model and have one already: adding replaces it. */
  replaces: ModelUse[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [use, setUse] = useState<ModelUse>(editing.use);
  const presets = USES[use].presets;
  const [settings, setSettings] = useState<ModelSettings>(
    initialSettings(presets, editing.saved),
  );
  const [dimensions, setDimensions] = useState(
    editing.dimensions ??
      EMBEDDING_PRESETS[settings.preset]?.defaultDimensions ??
      1536,
  );
  const [name, setName] = useState(editing.name ?? "");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  // The dimension of the embeddings that already exist, which a new model must match.
  const { data: progress } = useQuery({
    queryKey: ["embedding-progress", serverId],
    queryFn: async () => await getEmbeddingProgressAction(serverId),
    enabled: use === "embedding",
  });
  const existingDimension = progress?.existingDimension ?? null;

  const chooseUse = (next: ModelUse) => {
    setUse(next);
    setSettings(initialSettings(USES[next].presets));
    setDimensions(EMBEDDING_PRESETS.openai.defaultDimensions ?? 1536);
  };

  const config = () => ({
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey || undefined,
    model: settings.model,
    name: name.trim() || null,
  });

  const save = async () => {
    setSaving(true);
    try {
      if (use === "chat") {
        await saveChatConfigAction(serverId, {
          ...config(),
          provider: settings.provider as ChatProvider,
        });
      } else if (use === "embedding") {
        await saveEmbeddingConfigAction(serverId, {
          ...config(),
          provider: settings.provider as EmbeddingProvider,
          dimensions,
        });
      } else {
        await saveKnowledgeModelAction(serverId, {
          ...config(),
          provider: settings.provider as ChatProvider,
          id: editing.id,
        });
      }
      toast.success(`${USES[use].label} model saved`);
      router.refresh();
      onClose();
    } catch {
      toast.error(`Failed to save the ${USES[use].label.toLowerCase()} model`);
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      const chat = { ...config(), provider: settings.provider as ChatProvider };
      const result =
        use === "knowledge"
          ? await testKnowledgeModelAction(serverId, chat, editing.id)
          : await testChatConnectionAction(serverId, chat);
      (result.success ? toast.success : toast.error)(result.message);
    } catch {
      toast.error("Failed to test connection");
    } finally {
      setTesting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {editing.adding ? "Add a model" : "Edit model"}
          </DialogTitle>
          <DialogDescription>{USES[use].about}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {editing.adding && (
            <div className="space-y-2">
              <Label htmlFor="model-use">Use for</Label>
              <Select
                value={use}
                onValueChange={(value) => chooseUse(value as ModelUse)}
              >
                <SelectTrigger id="model-use">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(USES).map(([key, u]) => (
                    <SelectItem key={key} value={key}>
                      {u.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {replaces.includes(use) && (
                <p className="text-xs text-muted-foreground">
                  Replaces the current {USES[use].label.toLowerCase()} model.
                </p>
              )}
            </div>
          )}

          <ModelFields
            id={`model-${use}`}
            presets={presets}
            value={settings}
            onChange={(value, preset) => {
              setSettings(value);
              if (preset?.defaultDimensions && use === "embedding") {
                setDimensions(preset.defaultDimensions);
              }
            }}
            hasSavedKey={editing.hasSavedKey}
          />

          {use === "embedding" && (
            <div className="space-y-2">
              <Label htmlFor="model-dimensions">Dimensions</Label>
              <Input
                id="model-dimensions"
                type="number"
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
                <p className="text-xs text-yellow-600 dark:text-yellow-400">
                  Dimensions over 2000 skip the HNSW index (pgvector limit).
                  Queries will work but may be slower for large libraries.
                </p>
              )}
              {existingDimension !== null &&
                existingDimension !== dimensions && (
                  <p className="text-xs text-destructive">
                    Dimension mismatch: existing embeddings have{" "}
                    {existingDimension} dimensions, but configured is{" "}
                    {dimensions}. Clear existing embeddings in AI
                    Recommendations before changing dimensions.
                  </p>
                )}
            </div>
          )}

          <Separator />
          <div className="space-y-2">
            <Label htmlFor="model-name">Name (optional)</Label>
            <Input
              id="model-name"
              placeholder="How the list shows it, e.g. Claude (API) or Qwen (local)"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter className="gap-2">
          {use !== "embedding" && (
            <Button
              type="button"
              variant="outline"
              className="flex items-center gap-1"
              disabled={
                testing || !isComplete(presets, settings, editing.hasSavedKey)
              }
              onClick={test}
            >
              {testing ? (
                <Loader className="h-4 w-4 animate-spin" />
              ) : (
                <Zap className="h-4 w-4" />
              )}
              Test
            </Button>
          )}
          <Button
            type="button"
            disabled={saving || !settings.baseUrl || !settings.model}
            onClick={save}
          >
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
