"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { SynopsisQueue as Queue } from "@/lib/db/knowledge-index";
import { writeSynopsesNextAction } from "./synopsis-actions";

const count = (n: number, one: string, many: string) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

/**
 * Where the synopsis stands (a series': its episodes'), with a button to put
 * those still to be written at the front of the queue. Admins only.
 */
export function SynopsisQueue({
  serverId,
  itemId,
  series,
  queue,
}: {
  serverId: number;
  itemId: string;
  series: boolean;
  queue: Queue;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const { written, next, waiting, declined, noSubtitles } = queue;

  const writeNext = () =>
    startTransition(async () => {
      try {
        const asked = await writeSynopsesNextAction(serverId, itemId);
        toast.success(
          `${count(asked, "synopsis", "synopses")} will be written next`,
        );
        router.refresh();
      } catch {
        toast.error("Failed to move it up the queue");
      }
    });

  const status = series
    ? [
        `${written.toLocaleString()} of ${(written + next + waiting + declined + noSubtitles).toLocaleString()} episodes have a synopsis`,
        next > 0 && `${next.toLocaleString()} next in the queue`,
        waiting > 0 && `${waiting.toLocaleString()} waiting`,
        declined > 0 && `${declined.toLocaleString()} declined by the models`,
        noSubtitles > 0 &&
          `${noSubtitles.toLocaleString()} without readable subtitles`,
      ]
        .filter(Boolean)
        .join(" · ")
    : written > 0
      ? "Synopsis written"
      : next > 0
        ? "Synopsis next in the queue"
        : waiting > 0
          ? "Synopsis waiting in the queue"
          : declined > 0
            ? "No synopsis: every model that writes them declined it (its content filter refused); the dialogue is searchable"
            : "No synopsis: no readable subtitles";

  return (
    <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
      <span>
        {status}
        {!queue.enabled && " (the knowledge index is off)"}
      </span>
      {waiting > 0 && (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={writeNext}
          title="Put it at the front of the synopsis queue, to be written on the knowledge index's next pass"
        >
          {series ? "Write these next" : "Write next"}
        </Button>
      )}
    </div>
  );
}
