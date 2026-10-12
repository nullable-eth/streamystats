"use client";

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
import { setKnowledgeIndexEnabledAction } from "./knowledge-actions";

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
  const [enabled, setEnabled] = useState(status.enabled);
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

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Knowledge Index</CardTitle>
        <CardDescription>
          Reads the full subtitle track of every movie and episode (external
          files such as Bazarr&apos;s, or embedded text tracks) and embeds the
          dialogue, so the AI chat can find titles from a remembered line or
          scene. With a chat model configured, it also writes a plot synopsis
          from each transcript and adds it to the item&apos;s embedding, which
          sharpens plot search and recommendations. Forced and image-based
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

        <div className="space-y-4">
          {[
            { label: "Transcripts", value: status.transcripts },
            { label: "Synopses", value: status.synopses },
          ].map(({ label, value }) => (
            <div key={label} className="space-y-1">
              <div className="flex justify-between text-sm">
                <span>{label}</span>
                <span className="text-muted-foreground">
                  {value.toLocaleString()} of {status.total.toLocaleString()}
                </span>
              </div>
              <Progress value={percent(value, status.total)} />
            </div>
          ))}
        </div>

        {status.missing > 0 && (
          <div className="space-y-1 text-sm">
            <p>
              {status.missing.toLocaleString()} items have no full text
              subtitle. Add one with Bazarr and they are picked up within a day.
            </p>
            <p className="text-muted-foreground">
              {status.missingExamples.join(" · ")}
              {status.missing > status.missingExamples.length ? " …" : ""}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
