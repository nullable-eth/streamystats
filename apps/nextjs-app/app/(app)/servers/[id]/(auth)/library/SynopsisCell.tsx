"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { SynopsisState } from "@/lib/db/knowledge-index";
import { writeSynopsesNextAction } from "./[itemId]/synopsis-actions";

/** As the Knowledge Index card names and colours them. */
const STAGES = {
  best: ["Best", "bg-emerald-500", "A synopsis and the Wikipedia plot"],
  good: ["Good", "bg-sky-500", "A synopsis written from the subtitles"],
  next: ["Next", "bg-amber-400", "Next in the synopsis queue"],
  waiting: [
    "Waiting",
    "bg-amber-400",
    "Subtitles read; the synopsis is waiting in the queue",
  ],
  declined: [
    "Declined",
    "bg-orange-500",
    "Every model that writes synopses declined it (its content filter refused); its dialogue is searchable",
  ],
  none: [
    "No subtitles",
    "bg-muted-foreground/40",
    "No readable subtitles, so no synopsis can be written",
  ],
} as const;

/**
 * A library row's synopsis: a movie's or episode's stage, a series' episodes
 * written of all, and "Write next" for those still waiting.
 */
export function SynopsisCell({
  serverId,
  itemId,
  series,
  state,
}: {
  serverId: number;
  itemId: string;
  series: boolean;
  state: SynopsisState | undefined;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  if (!state) return <div className="text-left">-</div>;

  const stage =
    state.best > 0
      ? STAGES.best
      : state.written > 0
        ? STAGES.good
        : state.next > 0
          ? STAGES.next
          : state.waiting > 0
            ? STAGES.waiting
            : state.declined > 0
              ? STAGES.declined
              : STAGES.none;
  const writeNext = () =>
    startTransition(async () => {
      try {
        await writeSynopsesNextAction(serverId, itemId);
        router.refresh();
      } catch {
        toast.error("Failed to move it up the queue");
      }
    });

  return (
    <div className="flex flex-col items-start gap-1 text-left">
      {series ? (
        <span title="Episodes with a synopsis, of all">
          {state.written.toLocaleString()}/{state.total.toLocaleString()}
          {state.next > 0 && ` · ${state.next.toLocaleString()} next`}
        </span>
      ) : (
        <span className="flex items-center gap-2" title={stage[2]}>
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${stage[1]}`} />
          {stage[0]}
        </span>
      )}
      {state.waiting > 0 && (
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-xs"
          disabled={pending}
          onClick={writeNext}
          title={`Put ${series ? `its ${state.waiting.toLocaleString()} waiting episodes` : "it"} at the front of the synopsis queue`}
        >
          Write next
        </Button>
      )}
    </div>
  );
}
