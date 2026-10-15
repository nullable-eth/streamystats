"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import type { KnowledgeIndexStatus } from "@/lib/db/knowledge-index";
import {
  setKnowledgeIndexEnabledAction,
  setKnowledgeItemTypesAction,
  setKnowledgeWikipediaAction,
} from "./knowledge-actions";

const TYPE_LABELS: Record<string, string> = {
  Movie: "Movies",
  Episode: "Episodes",
};

function percent(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

export function KnowledgeIndexManager({
  serverId,
  status,
}: {
  serverId: number;
  status: KnowledgeIndexStatus;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(status.enabled);
  const [wikipedia, setWikipedia] = useState(status.wikipedia);
  const [types, setTypes] = useState<string[]>(
    status.byType.filter((t) => t.enabled).map((t) => t.type),
  );
  const [pending, startTransition] = useTransition();

  const toggle = (value: boolean) => {
    setEnabled(value);
    startTransition(async () => {
      try {
        await setKnowledgeIndexEnabledAction(serverId, value);
        toast.success(
          value ? "Knowledge index enabled" : "Knowledge index disabled",
        );
      } catch {
        setEnabled(!value);
        toast.error("Failed to update the knowledge index setting");
      }
    });
  };

  const toggleWikipedia = (value: boolean) => {
    setWikipedia(value);
    startTransition(async () => {
      try {
        await setKnowledgeWikipediaAction(serverId, value);
        router.refresh();
      } catch {
        setWikipedia(!value);
        toast.error("Failed to update the Wikipedia setting");
      }
    });
  };

  const toggleType = (type: string, on: boolean) => {
    const previous = types;
    const next = on
      ? [...new Set([...types, type])]
      : types.filter((t) => t !== type);
    setTypes(next);
    startTransition(async () => {
      try {
        await setKnowledgeItemTypesAction(serverId, next);
        router.refresh();
      } catch {
        setTypes(previous);
        toast.error("Failed to update which items are indexed");
      }
    });
  };

  const selected = status.byType.filter((t) => types.includes(t.type));
  const sum = (
    key: "total" | "checked" | "transcripts" | "synopses" | "missing",
  ) => selected.reduce((n, t) => n + t[key], 0);
  const total = sum("total");

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Knowledge Index</CardTitle>
        <CardDescription>
          Reads the full subtitle track of every selected movie and episode
          (external subtitle files, such as those from your subtitle downloader,
          or embedded text tracks) and embeds the dialogue, so the AI chat can
          find titles from a remembered line or scene. With knowledge index
          models listed in AI Models (or, without any, the chat model), it also
          writes the plot from each transcript, scene by scene with times, and a
          synopsis that is added to the item&apos;s embedding, which sharpens
          plot search and recommendations, lets the chat answer how an episode
          or series ends, and finds when something happens. Forced and
          image-based subtitles are skipped.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="knowledge-index">
            Index transcripts and synopses
          </Label>
          <Switch
            id="knowledge-index"
            checked={enabled}
            disabled={pending || !status.embeddingsConfigured}
            onCheckedChange={toggle}
          />
        </div>
        {!status.embeddingsConfigured && (
          <p className="text-sm text-muted-foreground">
            Set up an embedding model in{" "}
            <Link
              href={`/servers/${serverId}/settings/models`}
              className="underline underline-offset-4"
            >
              AI Models
            </Link>{" "}
            first.
          </p>
        )}
        {status.embeddingsConfigured && !status.chatConfigured && (
          <p className="text-sm text-muted-foreground">
            No knowledge index models (or chat model) are set up in AI Models,
            so only transcripts are indexed.
          </p>
        )}

        <div className="space-y-1">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="knowledge-wikipedia">Plots from Wikipedia</Label>
            <Switch
              id="knowledge-wikipedia"
              checked={wikipedia}
              disabled={pending}
              onCheckedChange={toggleWikipedia}
            />
          </div>
          <p className="text-sm text-muted-foreground">
            Fetches each title&apos;s plot from its English Wikipedia article
            (found by its IMDb id through Wikidata). The plot is written by
            people who watched it, so the synopsis is written with it: it says
            who people are and what happens where the dialogue does not. It is
            also searched on its own, so a plot point the synopsis left out
            still finds the title. Calls Wikimedia&apos;s servers; Wikipedia
            text is CC BY-SA. Turning this off removes the plots fetched so far,
            and synopses written with them are rewritten without.
          </p>
        </div>

        <div className="space-y-2">
          {status.byType.map((t) => (
            <div
              key={t.type}
              className="flex items-center justify-between gap-4 text-sm"
            >
              <div className="flex items-center gap-3">
                <Switch
                  id={`knowledge-type-${t.type}`}
                  checked={types.includes(t.type)}
                  disabled={pending}
                  onCheckedChange={(on) => toggleType(t.type, on)}
                />
                <Label htmlFor={`knowledge-type-${t.type}`}>
                  {TYPE_LABELS[t.type]}
                </Label>
              </div>
              <span className="text-muted-foreground">
                {t.transcripts.toLocaleString()} transcripts ·{" "}
                {t.synopses.toLocaleString()} synopses ·{" "}
                {wikipedia &&
                  `${t.references.toLocaleString()} Wikipedia plots · `}
                {t.checked.toLocaleString()} of {t.total.toLocaleString()}{" "}
                checked
              </span>
            </div>
          ))}
        </div>

        <div className="space-y-4">
          {[
            { label: "Transcripts", value: sum("transcripts") },
            { label: "Synopses", value: sum("synopses") },
          ].map(({ label, value }) => (
            <div key={label} className="space-y-1">
              <div className="flex justify-between text-sm">
                <span>{label}</span>
                <span className="text-muted-foreground">
                  {value.toLocaleString()} of {total.toLocaleString()}
                </span>
              </div>
              <Progress value={percent(value, total)} />
            </div>
          ))}
        </div>

        <div className="space-y-2 text-sm">
          <p>
            Checked {sum("checked").toLocaleString()} of{" "}
            {total.toLocaleString()} so far.
            {sum("missing") > 0 &&
              ` ${sum("missing").toLocaleString()} of them ${
                sum("missing") === 1 ? "has" : "have"
              } no full text subtitle yet. They are checked again daily, so subtitles your subtitle downloader adds later are picked up.`}
          </p>
          {sum("missing") > 0 && <MissingList missing={status.missing} />}
        </div>
      </CardContent>
    </Card>
  );
}

function MissingList({
  missing,
}: {
  missing: KnowledgeIndexStatus["missing"];
}) {
  const { series, movies } = missing;
  const episodes = series.reduce((n, s) => n + s.count, 0);
  const parts = [
    series.length > 0 &&
      `${episodes.toLocaleString()} episode${episodes === 1 ? "" : "s"} in ${series.length.toLocaleString()} series`,
    movies.length > 0 &&
      `${movies.length.toLocaleString()} movie${movies.length === 1 ? "" : "s"}`,
  ].filter(Boolean);
  return (
    <details className="rounded-md border">
      <summary className="cursor-pointer select-none px-3 py-2 text-muted-foreground">
        Without a full text subtitle: {parts.join(" and ")}
      </summary>
      <div className="max-h-96 space-y-4 overflow-y-auto border-t px-3 py-3">
        {series.length > 0 && (
          <ul className="space-y-1.5">
            {series.map((s) => (
              <li key={s.name}>
                <span className="font-medium">{s.name}</span>{" "}
                <span className="text-muted-foreground">
                  ({s.count.toLocaleString()}) {s.episodes}
                </span>
              </li>
            ))}
          </ul>
        )}
        {movies.length > 0 && (
          <div className="space-y-1.5">
            <p className="font-medium">Movies</p>
            <ul className="space-y-1 text-muted-foreground">
              {movies.map((m) => (
                <li key={`${m.name}-${m.year ?? ""}`}>
                  {m.name}
                  {m.year ? ` (${m.year})` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </details>
  );
}
