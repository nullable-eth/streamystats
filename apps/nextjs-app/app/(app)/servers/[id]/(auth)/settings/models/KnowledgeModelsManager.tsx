"use client";

import {
  ArrowDown,
  ArrowUp,
  Loader,
  Pencil,
  Plus,
  Trash2,
  Zap,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
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
import type { KnowledgeModelPublic } from "@/lib/db/knowledge-models";
import {
  initialSettings,
  isComplete,
  ModelFields,
  type ModelSettings,
  PROVIDER_PRESETS,
} from "../chat/model-fields";
import {
  moveKnowledgeModelAction,
  removeKnowledgeModelAction,
  saveKnowledgeModelAction,
  testKnowledgeModelAction,
} from "./knowledge-model-actions";

const usd = (n: number) =>
  n.toLocaleString(undefined, { style: "currency", currency: "USD" });

/** What a model is entered as; prices and budget as typed, blank budget for none. */
interface Draft {
  id?: number;
  settings: ModelSettings;
  hasSavedKey: boolean;
  inputPrice: string;
  outputPrice: string;
  monthlyBudget: string;
}

const draftOf = (m?: KnowledgeModelPublic): Draft => ({
  id: m?.id,
  settings: initialSettings(m),
  hasSavedKey: m?.hasApiKey ?? false,
  inputPrice: String(m?.inputPrice ?? 0),
  outputPrice: String(m?.outputPrice ?? 0),
  monthlyBudget: m?.monthlyBudget === null || !m ? "" : String(m.monthlyBudget),
});

export function KnowledgeModelsManager({
  serverId,
  models,
}: {
  serverId: number;
  models: KnowledgeModelPublic[];
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, startTransition] = useTransition();
  const [testing, setTesting] = useState(false);

  const run = (work: () => Promise<void>, failure: string) =>
    startTransition(async () => {
      try {
        await work();
        router.refresh();
      } catch {
        toast.error(failure);
      }
    });

  const config = (d: Draft) => ({
    provider: d.settings.provider,
    baseUrl: d.settings.baseUrl,
    apiKey: d.settings.apiKey || undefined,
    model: d.settings.model,
  });

  const save = (d: Draft) =>
    run(async () => {
      await saveKnowledgeModelAction(serverId, {
        ...config(d),
        id: d.id,
        inputPrice: Number(d.inputPrice) || 0,
        outputPrice: Number(d.outputPrice) || 0,
        monthlyBudget:
          d.monthlyBudget.trim() === "" ? null : Number(d.monthlyBudget),
      });
      setDraft(null);
      toast.success("Knowledge index model saved");
    }, "Failed to save the knowledge index model");

  const test = async (d: Draft) => {
    setTesting(true);
    try {
      const result = await testKnowledgeModelAction(serverId, config(d), d.id);
      (result.success ? toast.success : toast.error)(result.message);
    } catch {
      toast.error("Failed to test connection");
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card className="w-full mb-6">
      <CardHeader>
        <CardTitle>Knowledge Index Models</CardTitle>
        <CardDescription className="space-y-2">
          <span className="block">
            The models the knowledge index writes scene notes and synopses with,
            tried in order: a title goes to the first model with budget left
            this month, and to the next if it fails. A model that fails on its
            own account (no credit, rate limited, down) rests for an hour. Notes
            written by a model lower in the list are rewritten by a higher one
            once it has budget again. With none listed, the chat model writes,
            without a budget.
          </span>
          <span className="block">
            Each title&apos;s whole transcript goes in one request, so a model
            needs a long context window, 64k tokens or more: a feature
            film&apos;s subtitles alone run to some 30k. Large hosted models
            such as Claude are the most accurate; a local model of around 30B
            parameters works, but gets more speakers and timings wrong; small
            models and short context windows do not write usable notes. With
            Ollama, raise the context length (OLLAMA_CONTEXT_LENGTH), whose
            default cuts long transcripts off. Free models, such as
            OpenRouter&apos;s, work at a price of 0: when their daily quota runs
            out they rest, and the next model takes over.
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {models.length === 0 && (
          <p className="text-sm text-muted-foreground">
            None listed: the chat model writes the plot.
          </p>
        )}
        <ol className="space-y-3">
          {models.map((m, i) => (
            <li key={m.id} className="rounded-md border p-3 space-y-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">
                  {i + 1}. {PROVIDER_PRESETS[initialSettings(m).preset].name} ·{" "}
                  {m.model}
                </span>
                <div className="flex gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Move up"
                    disabled={pending || i === 0}
                    onClick={() =>
                      run(
                        () => moveKnowledgeModelAction(serverId, m.id, -1),
                        "Failed to reorder",
                      )
                    }
                  >
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Move down"
                    disabled={pending || i === models.length - 1}
                    onClick={() =>
                      run(
                        () => moveKnowledgeModelAction(serverId, m.id, 1),
                        "Failed to reorder",
                      )
                    }
                  >
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Edit"
                    disabled={pending}
                    onClick={() => setDraft(draftOf(m))}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Remove"
                    disabled={pending}
                    onClick={() =>
                      run(
                        () => removeKnowledgeModelAction(serverId, m.id),
                        "Failed to remove",
                      )
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <p className="text-sm text-muted-foreground">
                {m.inputPrice || m.outputPrice
                  ? `${usd(m.inputPrice)} in, ${usd(m.outputPrice)} out per million tokens`
                  : "Free"}{" "}
                ·{" "}
                {m.monthlyBudget === null
                  ? "no budget limit"
                  : `budget ${usd(m.monthlyBudget)} a month`}{" "}
                · this month {usd(m.spentThisMonth)},{" "}
                {m.titlesThisMonth.toLocaleString()} titles
              </p>
              {m.monthlyBudget !== null &&
                m.spentThisMonth >= m.monthlyBudget && (
                  <Badge variant="secondary">
                    Budget spent until next month
                  </Badge>
                )}
              {m.restingUntil && (
                <p className="text-sm text-amber-600 dark:text-amber-400">
                  Resting until {new Date(m.restingUntil).toLocaleTimeString()}
                  {m.lastError ? `: ${m.lastError}` : ""}
                </p>
              )}
            </li>
          ))}
        </ol>

        {draft ? (
          <div className="rounded-md border p-4 space-y-4">
            <h3 className="text-sm font-medium">
              {draft.id === undefined ? "Add a model" : "Edit model"}
            </h3>
            <ModelFields
              id="knowledge-model"
              value={draft.settings}
              onChange={(settings) => setDraft({ ...draft, settings })}
              hasSavedKey={draft.hasSavedKey}
            />
            <div className="grid gap-3 sm:grid-cols-3">
              {(
                [
                  ["inputPrice", "Input price (USD per million tokens)"],
                  ["outputPrice", "Output price (USD per million tokens)"],
                  ["monthlyBudget", "Monthly budget (USD, blank for none)"],
                ] as const
              ).map(([key, label]) => (
                <div key={key} className="space-y-2">
                  <Label htmlFor={`knowledge-model-${key}`}>{label}</Label>
                  <Input
                    id={`knowledge-model-${key}`}
                    type="number"
                    min={0}
                    step="0.01"
                    value={draft[key]}
                    onChange={(e) =>
                      setDraft({ ...draft, [key]: e.target.value })
                    }
                  />
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                className="flex-1"
                disabled={
                  pending || !draft.settings.baseUrl || !draft.settings.model
                }
                onClick={() => save(draft)}
              >
                {pending ? "Saving..." : "Save"}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="flex items-center gap-1"
                disabled={
                  testing || !isComplete(draft.settings, draft.hasSavedKey)
                }
                onClick={() => test(draft)}
              >
                {testing ? (
                  <Loader className="h-4 w-4 animate-spin" />
                ) : (
                  <Zap className="h-4 w-4" />
                )}
                Test
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setDraft(null)}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            onClick={() => setDraft(draftOf())}
          >
            <Plus className="h-4 w-4" /> Add a model
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
