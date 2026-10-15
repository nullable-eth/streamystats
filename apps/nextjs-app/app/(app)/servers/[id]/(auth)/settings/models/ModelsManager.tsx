"use client";

import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { KnowledgeModelPublic } from "@/lib/db/knowledge-models";
import { clearChatConfigAction } from "../chat/actions";
import {
  moveKnowledgeModelAction,
  removeKnowledgeModelAction,
} from "./knowledge-model-actions";
import { type Editing, ModelDialog, type ModelUse, USES } from "./ModelDialog";
import { detectPreset, type SavedModel } from "./model-fields";

interface Configured extends SavedModel {
  hasApiKey: boolean;
}

const usd = (n: number) =>
  n.toLocaleString(undefined, { style: "currency", currency: "USD" });

/** "Provider · model" as the presets name it. */
function nameOf(use: ModelUse, m: SavedModel) {
  const presets = USES[use].presets;
  const preset = presets[detectPreset(presets, m.provider, m.baseUrl)];
  return `${preset?.name ?? m.provider} · ${m.model}`;
}

function Row({
  title,
  children,
  actions,
}: {
  title: string;
  children?: ReactNode;
  actions: ReactNode;
}) {
  return (
    <li className="rounded-md border p-3 space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium break-all">{title}</span>
        <div className="flex gap-1">{actions}</div>
      </div>
      {children}
    </li>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Button
      size="icon"
      variant="ghost"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function Section({
  title,
  about,
  children,
}: {
  title: string;
  about: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="text-sm text-muted-foreground">{about}</p>
      {children}
    </section>
  );
}

/**
 * Every model Streamystats talks to, by what it is used for: the chat
 * assistant's, the knowledge index's (an ordered list, see knowledge-models)
 * and the embedding model. One dialog adds or changes any of them.
 */
export function ModelsManager({
  serverId,
  chat,
  embedding,
  knowledgeModels,
}: {
  serverId: number;
  chat: Configured | null;
  embedding: (Configured & { dimensions: number | null }) | null;
  knowledgeModels: KnowledgeModelPublic[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [opened, setOpened] = useState(0);
  const [clearingChat, setClearingChat] = useState(false);
  const [pending, startTransition] = useTransition();

  const open = (e: Editing) => {
    setEditing(e);
    setOpened((n) => n + 1);
  };
  const run = (work: () => Promise<unknown>, failure: string) =>
    startTransition(async () => {
      try {
        await work();
        router.refresh();
      } catch {
        toast.error(failure);
      }
    });

  const replaces: ModelUse[] = [
    ...(chat ? (["chat"] as const) : []),
    ...(embedding ? (["embedding"] as const) : []),
  ];

  return (
    <Card className="w-full">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle>Models</CardTitle>
          <CardDescription>
            Every model Streamystats talks to, by what it is used for.
          </CardDescription>
        </div>
        <Button
          type="button"
          onClick={() =>
            open({
              use: "knowledge",
              adding: true,
              saved: null,
              hasSavedKey: false,
            })
          }
        >
          <Plus className="h-4 w-4" /> Add a model
        </Button>
      </CardHeader>
      <CardContent className="space-y-8">
        <Section
          title="Chat assistant"
          about="Answers questions about your library and watch history (Cmd+K)."
        >
          {chat ? (
            <ul>
              <Row
                title={nameOf("chat", chat)}
                actions={
                  <>
                    <IconButton
                      label="Edit"
                      disabled={pending}
                      onClick={() =>
                        open({
                          use: "chat",
                          adding: false,
                          saved: chat,
                          hasSavedKey: chat.hasApiKey,
                        })
                      }
                    >
                      <Pencil className="h-4 w-4" />
                    </IconButton>
                    <IconButton
                      label="Remove"
                      disabled={pending}
                      onClick={() => setClearingChat(true)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </IconButton>
                  </>
                }
              >
                <p className="text-sm text-muted-foreground break-all">
                  {chat.baseUrl}
                </p>
              </Row>
            </ul>
          ) : (
            <p className="text-sm">None: the chat assistant is off.</p>
          )}
        </Section>

        <Section
          title="Knowledge index"
          about="Writes each title's scene notes and synopsis. Tried in order: a title goes to the first model with budget left this month, and to the next if it fails. A model that fails on its own account (no credit, rate limited, down) rests for an hour, and notes written by a model lower in the list are rewritten by a higher one once it has budget."
        >
          {knowledgeModels.length === 0 && (
            <p className="text-sm">None listed: the chat model writes.</p>
          )}
          <ol className="space-y-2">
            {knowledgeModels.map((m, i) => (
              <Row
                key={m.id}
                title={`${i + 1}. ${nameOf("knowledge", m)}`}
                actions={
                  <>
                    <IconButton
                      label="Move up"
                      disabled={pending || i === 0}
                      onClick={() =>
                        run(
                          () => moveKnowledgeModelAction(serverId, m.id, -1),
                          "Failed to reorder",
                        )
                      }
                    >
                      <ArrowUp className="h-4 w-4" />
                    </IconButton>
                    <IconButton
                      label="Move down"
                      disabled={pending || i === knowledgeModels.length - 1}
                      onClick={() =>
                        run(
                          () => moveKnowledgeModelAction(serverId, m.id, 1),
                          "Failed to reorder",
                        )
                      }
                    >
                      <ArrowDown className="h-4 w-4" />
                    </IconButton>
                    <IconButton
                      label="Edit"
                      disabled={pending}
                      onClick={() =>
                        open({
                          use: "knowledge",
                          adding: false,
                          id: m.id,
                          saved: m,
                          hasSavedKey: m.hasApiKey,
                          inputPrice: m.inputPrice,
                          outputPrice: m.outputPrice,
                          monthlyBudget: m.monthlyBudget,
                        })
                      }
                    >
                      <Pencil className="h-4 w-4" />
                    </IconButton>
                    <IconButton
                      label="Remove"
                      disabled={pending}
                      onClick={() =>
                        run(
                          () => removeKnowledgeModelAction(serverId, m.id),
                          "Failed to remove",
                        )
                      }
                    >
                      <Trash2 className="h-4 w-4" />
                    </IconButton>
                  </>
                }
              >
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
                  <p className="text-sm text-amber-600 dark:text-amber-400 break-all">
                    Resting until{" "}
                    {new Date(m.restingUntil).toLocaleTimeString()}
                    {m.lastError ? `: ${m.lastError}` : ""}
                  </p>
                )}
              </Row>
            ))}
          </ol>
          <details className="text-sm text-muted-foreground">
            <summary className="cursor-pointer select-none">
              Which models work
            </summary>
            <p className="mt-2">
              Each title&apos;s whole transcript goes in one request, so a model
              needs a long context window, 64k tokens or more: a feature
              film&apos;s subtitles alone run to some 30k. Large hosted models
              such as Claude are the most accurate; a local model of around 30B
              parameters works, but gets more speakers and timings wrong; small
              models and short context windows do not write usable notes. With
              Ollama, raise the context length (OLLAMA_CONTEXT_LENGTH), whose
              default cuts long transcripts off. Free models, such as
              OpenRouter&apos;s, work at a price of 0: when their daily quota
              runs out they rest, and the next model takes over.
            </p>
          </details>
        </Section>

        <Section
          title="Embeddings"
          about={
            <>
              Turns titles, plots and transcripts into vectors for
              recommendations, the knowledge index and search. What gets
              embedded is set in{" "}
              <Link
                href={`/servers/${serverId}/settings/ai`}
                className="underline underline-offset-4"
              >
                AI Recommendations
              </Link>
              .
            </>
          }
        >
          {embedding ? (
            <ul>
              <Row
                title={nameOf("embedding", embedding)}
                actions={
                  <IconButton
                    label="Edit"
                    disabled={pending}
                    onClick={() =>
                      open({
                        use: "embedding",
                        adding: false,
                        saved: embedding,
                        hasSavedKey: embedding.hasApiKey,
                        dimensions: embedding.dimensions,
                      })
                    }
                  >
                    <Pencil className="h-4 w-4" />
                  </IconButton>
                }
              >
                <p className="text-sm text-muted-foreground break-all">
                  {embedding.dimensions ?? "?"} dimensions · {embedding.baseUrl}
                </p>
              </Row>
            </ul>
          ) : (
            <p className="text-sm">
              None: recommendations, search and the knowledge index need one.
            </p>
          )}
        </Section>
      </CardContent>

      {editing && (
        <ModelDialog
          key={opened}
          serverId={serverId}
          editing={editing}
          replaces={replaces}
          onClose={() => setEditing(null)}
        />
      )}

      <AlertDialog open={clearingChat} onOpenChange={setClearingChat}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the chat model?</AlertDialogTitle>
            <AlertDialogDescription>
              The chat assistant is off until another is added
              {knowledgeModels.length === 0 &&
                ", and with no knowledge index model listed, synopses stop being written"}
              .
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setClearingChat(false);
                run(
                  () => clearChatConfigAction(serverId),
                  "Failed to remove the chat model",
                );
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
