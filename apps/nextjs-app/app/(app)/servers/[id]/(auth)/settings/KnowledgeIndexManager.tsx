"use client";

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
          (external files such as Bazarr&apos;s, or embedded text tracks) and
          embeds the dialogue, so the AI chat can find titles from a remembered
          line or scene. With a chat model configured, it also writes a plot
          synopsis from each transcript and adds it to the item&apos;s
          embedding, which sharpens plot search and recommendations, and lets
          the chat answer how an episode or series ends. Forced and image-based
          subtitles are skipped.
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
            Configure embeddings above first.
          </p>
        )}
        {status.embeddingsConfigured && !status.chatConfigured && (
          <p className="text-sm text-muted-foreground">
            No chat model is configured, so only transcripts are indexed.
          </p>
        )}

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

        <div className="space-y-1 text-sm">
          <p>
            Checked {sum("checked").toLocaleString()} of{" "}
            {total.toLocaleString()} so far.
            {sum("missing") > 0 &&
              ` ${sum("missing").toLocaleString()} of them ${
                sum("missing") === 1 ? "has" : "have"
              } no full text subtitle yet; they are checked again daily, so a subtitle Bazarr adds later is picked up.`}
          </p>
          {sum("missing") > 0 && (
            <p className="text-muted-foreground">
              {status.missingExamples.join(" · ")}
              {sum("missing") > status.missingExamples.length ? " …" : ""}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
