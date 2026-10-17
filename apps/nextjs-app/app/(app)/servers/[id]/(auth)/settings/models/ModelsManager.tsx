"use client";

import {
  ArrowDown,
  ArrowUp,
  Pencil,
  Plus,
  Replace,
  Trash2,
  X,
} from "lucide-react";
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
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import type { KnowledgeModelPublic } from "@/lib/db/knowledge-models";
import { defaultParallel, writerLabel } from "@/lib/knowledge-writers";
import { clearChatConfigAction } from "../chat/actions";
import {
  moveKnowledgeModelAction,
  removeKnowledgeModelAction,
  setKnowledgeModelEnabledAction,
  setKnowledgeModelRewriteAction,
} from "./knowledge-model-actions";
import { type Editing, ModelDialog, type ModelUse, USES } from "./ModelDialog";
import { detectPreset, type SavedModel } from "./model-fields";
import { RewriteDialog } from "./RewriteDialog";

interface Configured extends SavedModel {
  hasApiKey: boolean;
  name: string | null;
}

/** "1 thread", "4 threads". */
const threads = (n: number) => `${n} ${n === 1 ? "thread" : "threads"}`;

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
  off,
}: {
  title: string;
  children?: ReactNode;
  actions: ReactNode;
  /** Turned off: shown faded. */
  off?: boolean;
}) {
  return (
    <li
      className={`rounded-md border p-3 space-y-1 ${off ? "opacity-60" : ""}`}
    >
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
      <div className="space-y-2 border-l-2 pl-4">{children}</div>
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
  writers,
}: {
  serverId: number;
  chat: Configured | null;
  embedding: (Configured & { dimensions: number | null }) | null;
  knowledgeModels: KnowledgeModelPublic[];
  /** Who wrote the current synopses, and how many each. */
  writers: { label: string; titles: number }[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [rewriting, setRewriting] = useState<KnowledgeModelPublic | null>(null);
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

  const listedName = (m: KnowledgeModelPublic) =>
    m.name || nameOf("knowledge", m);
  /** A writer as the list shows it, or as its synopses record it when not listed. */
  const writerName = (label: string) => {
    const listed = knowledgeModels.find((m) => writerLabel(m) === label);
    return listed ? listedName(listed) : label;
  };
  const left = new Map(writers.map((w) => [w.label, w.titles]));

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
                title={chat.name || nameOf("chat", chat)}
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
                          name: chat.name,
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
                  {chat.name && `${nameOf("chat", chat)} · `}
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
          about="Writes the synopsis of each movie and episode. One without a synopsis goes to the first model in the list that is not resting, and to the next if that fails. A rate-limited model rests until its provider says the limit resets; one without credit, with a rejected key, or down rests a while. A synopsis once written is kept, whatever the order or any new subtitles, until you ask another model to rewrite that model's synopses."
        >
          {knowledgeModels.length === 0 && (
            <p className="text-sm">None listed: the chat model writes.</p>
          )}
          <ol className="space-y-2">
            {knowledgeModels.map((m, i) => (
              <Row
                key={m.id}
                off={!m.enabled}
                title={`${i + 1}. ${listedName(m)}${m.enabled ? "" : " (off)"}`}
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
                          name: m.name,
                          parallelRequests: m.parallelRequests,
                        })
                      }
                    >
                      <Pencil className="h-4 w-4" />
                    </IconButton>
                    <IconButton
                      label="Rewrite another model's synopses"
                      disabled={pending}
                      onClick={() => setRewriting(m)}
                    >
                      <Replace className="h-4 w-4" />
                    </IconButton>
                    <Switch
                      className="mx-1 self-center"
                      aria-label={m.enabled ? "Turn off" : "Turn on"}
                      title={m.enabled ? "On: turn off" : "Off: turn on"}
                      checked={m.enabled}
                      disabled={pending}
                      onCheckedChange={(on) =>
                        run(
                          () =>
                            setKnowledgeModelEnabledAction(serverId, m.id, on),
                          "Failed to turn the model on or off",
                        )
                      }
                    />
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
                  {m.name && `${nameOf("knowledge", m)} · `}
                  {m.titles.toLocaleString()}{" "}
                  {m.titles === 1 ? "synopsis" : "synopses"} written ·{" "}
                  {threads(m.parallelRequests ?? defaultParallel(m.provider))}
                </p>
                {m.rewriteFrom.map((from) => (
                  <p key={from} className="flex items-center gap-1 text-sm">
                    <span className="break-all">
                      Rewriting {writerName(from)}&apos;s synopses:{" "}
                      {(left.get(from) ?? 0).toLocaleString()} left
                    </span>
                    <IconButton
                      label="Stop replacing them"
                      disabled={pending}
                      onClick={() =>
                        run(
                          () =>
                            setKnowledgeModelRewriteAction(
                              serverId,
                              m.id,
                              from,
                              false,
                            ),
                          "Failed to stop",
                        )
                      }
                    >
                      <X className="h-4 w-4" />
                    </IconButton>
                  </p>
                ))}
                {m.restingUntil && (
                  <p className="text-sm text-amber-600 dark:text-amber-400 break-all">
                    Resting until {new Date(m.restingUntil).toLocaleString()}
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
              A movie&apos;s or episode&apos;s whole subtitles go in one
              request, so a model needs a long context window, 64k tokens or
              more: a feature film&apos;s subtitles alone run to some 30k. Large
              hosted models such as Claude are the most accurate; a local model
              of around 30B parameters works, but gets more of who says what
              wrong; small models and short context windows do not write usable
              synopses. With Ollama, raise the context length
              (OLLAMA_CONTEXT_LENGTH), whose default cuts long subtitles off.
              Free models, such as OpenRouter&apos;s, work too: when their quota
              runs out they rest until it resets, and the next model takes over.
            </p>
          </details>
        </Section>

        <Section
          title="Embeddings"
          about={
            <>
              Turns titles, synopses and subtitles into vectors for
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
                title={embedding.name || nameOf("embedding", embedding)}
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
                        name: embedding.name,
                      })
                    }
                  >
                    <Pencil className="h-4 w-4" />
                  </IconButton>
                }
              >
                <p className="text-sm text-muted-foreground break-all">
                  {embedding.name && `${nameOf("embedding", embedding)} · `}
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

      {rewriting && (
        <RewriteDialog
          model={rewriting}
          name={listedName(rewriting)}
          models={knowledgeModels}
          writers={writers}
          writerName={writerName}
          onClose={() => setRewriting(null)}
          onConfirm={(from) => {
            setRewriting(null);
            run(
              () =>
                setKnowledgeModelRewriteAction(
                  serverId,
                  rewriting.id,
                  from,
                  true,
                ),
              "Failed to ask for the rewrite",
            );
          }}
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
