"use client";

import { formatDistanceToNow } from "date-fns";
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
import { Switch } from "@/components/ui/switch";
import type {
  KnowledgeIndexStatus,
  KnowledgeTypeStatus,
  KnowledgeWriter,
} from "@/lib/db/knowledge-index";
import {
  setKnowledgeIndexEnabledAction,
  setKnowledgeItemTypesAction,
  setKnowledgeWikipediaAction,
} from "./knowledge-actions";

const TYPE_LABELS: Record<string, string> = {
  Movie: "Movies",
  Episode: "Episodes",
};

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
  const sum = (key: Exclude<keyof KnowledgeTypeStatus, "type" | "enabled">) =>
    selected.reduce((n, t) => n + t[key], 0);
  const total = sum("total");
  const models = `/servers/${serverId}/settings/models`;

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Knowledge Index</CardTitle>
        <CardDescription>
          Makes your movies and episodes searchable by what happens in them, so
          the AI chat can find one from a line you remember or a scene you
          describe, and tell you how a story ends. Streamystats reads each
          one&apos;s subtitles and has an AI model write a synopsis of what
          happens and when. A Wikipedia plot, where there is one, makes the
          synopsis more accurate, but the subtitles are enough.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-8">
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="knowledge-index">
              Read subtitles and write synopses
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
              <Link href={models} className="underline underline-offset-4">
                AI Models
              </Link>{" "}
              first.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            {status.byType.map((t) => (
              <div key={t.type} className="flex items-center gap-2">
                <Switch
                  id={`knowledge-type-${t.type}`}
                  checked={types.includes(t.type)}
                  disabled={pending}
                  onCheckedChange={(on) => toggleType(t.type, on)}
                />
                <Label htmlFor={`knowledge-type-${t.type}`}>
                  {TYPE_LABELS[t.type]} ({t.total.toLocaleString()})
                </Label>
              </div>
            ))}
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="knowledge-wikipedia">Use Wikipedia plots</Label>
              <Switch
                id="knowledge-wikipedia"
                checked={wikipedia}
                disabled={pending}
                onCheckedChange={toggleWikipedia}
              />
            </div>
            <p className="text-sm text-muted-foreground">
              Looks up each one&apos;s plot on English Wikipedia. Not needed:
              without one, the synopsis is written from the subtitles. With one,
              it gets who is who and what happens off screen right more often,
              and the plot is searchable too. Wikipedia text is CC BY-SA.
              Turning this off deletes the plots fetched so far.
            </p>
          </div>
        </div>

        {total > 0 && (
          <section className="space-y-3">
            <h3 className="text-sm font-medium">How well they are covered</h3>
            <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
              {TIERS.map((tier) => (
                <div
                  key={tier.key}
                  className={tier.color}
                  style={{ width: `${(100 * sum(tier.key)) / total}%` }}
                  title={`${tier.label}: ${sum(tier.key).toLocaleString()}`}
                />
              ))}
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="pb-1 text-left font-normal" />
                  {selected.map((t) => (
                    <th
                      key={t.type}
                      className="pb-1 pl-4 text-right font-normal"
                    >
                      {TYPE_LABELS[t.type]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {TIERS.map((tier) => (
                  <tr key={tier.key} className="align-top">
                    <td className="py-1.5">
                      <div className="flex items-start gap-2">
                        <span
                          className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${tier.color}`}
                        />
                        <div>
                          <span className="font-medium">{tier.label}</span>
                          <p className="text-muted-foreground">{tier.about}</p>
                        </div>
                      </div>
                    </td>
                    {selected.map((t) => (
                      <td
                        key={t.type}
                        className="py-1.5 pl-4 text-right tabular-nums"
                      >
                        {t[tier.key].toLocaleString()}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {total > 0 && (
          <section className="space-y-2 text-sm">
            <h3 className="font-medium">Still to do</h3>
            {!enabled && (
              <p className="text-muted-foreground">
                Paused while the knowledge index is off.
              </p>
            )}
            <ul className="space-y-2">
              {sum("dialogue") > 0 && (
                <li>
                  <span className="font-medium">
                    {count(sum("dialogue"), "synopsis", "synopses")} to write.
                  </span>{" "}
                  <Writers writers={status.writers} models={models} />
                  {sum("failed") > 0 &&
                    ` ${count(sum("failed"), "failed", "failed")} in the last day and ${sum("failed") === 1 ? "is" : "are"} tried again a day later.`}
                </li>
              )}
              {sum("rewrites") > 0 && (
                <li>
                  <span className="font-medium">
                    {count(sum("rewrites"), "synopsis", "synopses")} to rewrite
                  </span>{" "}
                  with another model, as asked in{" "}
                  <Link href={models} className="underline underline-offset-4">
                    AI Models
                  </Link>
                  .
                </li>
              )}
              {sum("unread") > 0 && (
                <li>
                  <span className="font-medium">
                    {count(sum("unread"), "new one", "new ones")}
                  </span>{" "}
                  to read the subtitles of.
                </li>
              )}
              {wikipedia && sum("wikipediaPending") > 0 && (
                <li>
                  <span className="font-medium">
                    {sum("wikipediaPending").toLocaleString()}
                  </span>{" "}
                  to look up on Wikipedia.
                </li>
              )}
              {sum("dialogue") + sum("rewrites") + sum("unread") === 0 && (
                <li>
                  Nothing waiting: new movies and episodes are picked up on the
                  next run.
                </li>
              )}
            </ul>
            {status.lastRun && <LastRun run={status.lastRun} />}
          </section>
        )}

        {sum("noSubtitles") > 0 && (
          <section className="space-y-2 text-sm">
            <h3 className="font-medium">
              No readable subtitles: {sum("noSubtitles").toLocaleString()}
            </h3>
            <p className="text-muted-foreground">
              Without subtitles only the title and description are searchable.
              They are checked again daily, so subtitles added later (by a
              subtitle downloader, for example) are picked up. Image-based and
              forced-only subtitles (do not contain full transcript) cannot be
              used.
            </p>
            <MissingList missing={status.missing} />
          </section>
        )}
      </CardContent>
    </Card>
  );
}

/** "1 synopsis", "2,345 synopses". */
const count = (n: number, one: string, many: string) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** Who writes the synopses, and whether they can now. */
function Writers({
  writers,
  models,
}: {
  writers: KnowledgeWriter[];
  models: string;
}) {
  const now = Date.now();
  const resting = (w: KnowledgeWriter) =>
    w.restingUntil !== null && new Date(w.restingUntil).getTime() > now;
  const ready = writers.filter((w) => !resting(w));
  if (writers.length === 0) {
    return (
      <>
        No model is turned on to write them: add or turn one on in{" "}
        <Link href={models} className="underline underline-offset-4">
          AI Models
        </Link>
        .
      </>
    );
  }
  if (ready.length === 0) {
    const first = writers.map((w) => w.restingUntil as string).sort()[0];
    return (
      <span suppressHydrationWarning>
        Waiting: {writers.map((w) => w.name).join(", ")}{" "}
        {writers.length === 1 ? "is" : "are"} resting until{" "}
        {new Date(first).toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        })}
        {writers[0].lastError ? ` (${writers[0].lastError})` : ""}.
      </span>
    );
  }
  return (
    <>
      {ready[0].name} writes them with {ready[0].atOnce}{" "}
      {ready[0].atOnce === 1 ? "thread" : "threads"}
      {ready.length > 1 &&
        `; ${ready
          .slice(1)
          .map((w) => w.name)
          .join(", ")} if it cannot`}
      .
    </>
  );
}

/** What the latest run did, or the one running now has done so far. */
function LastRun({
  run,
}: {
  run: NonNullable<KnowledgeIndexStatus["lastRun"]>;
}) {
  const done = [
    run.synopses > 0 &&
      `${count(run.synopses, "synopsis", "synopses")} written`,
    run.subtitles > 0 &&
      `${count(run.subtitles, "subtitle track", "subtitle tracks")} read`,
    run.plots > 0 &&
      `${count(run.plots, "Wikipedia plot", "Wikipedia plots")} found`,
  ].filter(Boolean);
  const when = formatDistanceToNow(new Date(run.at), { addSuffix: true });
  return (
    <p className="text-muted-foreground" suppressHydrationWarning>
      {run.running ? `Running now (updated ${when})` : `Last run ${when}`}:{" "}
      {done.length > 0 ? done.join(", ") : "nothing new"}
      {run.running ? " so far" : ""}.
      {run.errors > 0 &&
        ` ${count(run.errors, "error", "errors")}${run.lastError ? `, the last: ${run.lastError}` : ""}.`}
    </p>
  );
}

/** Each tier, best first: what search knows of a movie or episode. */
const TIERS = [
  {
    key: "best",
    label: "Best",
    color: "bg-emerald-500",
    about: "A synopsis and the Wikipedia plot: the most complete.",
  },
  {
    key: "good",
    label: "Good",
    color: "bg-sky-500",
    about: "A synopsis written from the subtitles.",
  },
  {
    key: "dialogue",
    label: "Dialogue only",
    color: "bg-amber-400",
    about: "Every line is searchable; the synopsis is still to be written.",
  },
  {
    key: "titleOnly",
    label: "Title only",
    color: "bg-muted-foreground/40",
    about: "No subtitles yet: only the title and description are searchable.",
  },
] as const;

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
        Which ones: {parts.join(" and ")}
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
