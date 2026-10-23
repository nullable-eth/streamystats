"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { KnowledgeModelPublic } from "@/lib/db/knowledge-models";
import { rewriteLoops, writerLabel } from "@/lib/knowledge-writers";

const titles = (n: number) =>
  `${n.toLocaleString()} ${n === 1 ? "synopsis" : "synopses"}`;

/**
 * Ask a knowledge index model to rewrite another model's synopses, showing
 * how many that is before anything is asked.
 */
export function RewriteDialog({
  model,
  name,
  models,
  writers,
  writerName,
  onConfirm,
  onClose,
}: {
  model: KnowledgeModelPublic;
  /** How the list shows it. */
  name: string;
  models: KnowledgeModelPublic[];
  writers: { label: string; titles: number }[];
  writerName: (label: string) => string;
  onConfirm: (from: string) => void;
  onClose: () => void;
}) {
  const [from, setFrom] = useState<string>();
  // Not its own, not one it already replaces, and none that would come back round to it.
  const choices = writers.filter(
    (w) =>
      !model.rewriteFrom.includes(w.label) &&
      !rewriteLoops(models, w.label, writerLabel(model)),
  );
  const chosen = choices.find((w) => w.label === from);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Rewrite another model&apos;s synopses</DialogTitle>
          <DialogDescription>
            {name} rewrites the synopses the model you pick wrote, one request
            each, as the knowledge index gets to them, and any that model writes
            later, until you stop it. Each keeps its synopsis until the new one
            is written.
          </DialogDescription>
        </DialogHeader>

        {choices.length === 0 ? (
          <p className="text-sm">No other model&apos;s synopses to rewrite.</p>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="rewrite-from">Synopses written by</Label>
            <Select value={from} onValueChange={setFrom}>
              <SelectTrigger id="rewrite-from">
                <SelectValue placeholder="Pick a model" />
              </SelectTrigger>
              <SelectContent>
                {choices.map((w) => (
                  <SelectItem key={w.label} value={w.label}>
                    {writerName(w.label)} · {titles(w.titles)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {chosen && (
              <p className="text-sm">
                Rewrite {titles(chosen.titles)} with {name}?
                {!model.enabled && " It is off: it starts once turned on."}
              </p>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!chosen}
            onClick={() => chosen && onConfirm(chosen.label)}
          >
            {chosen ? `Rewrite ${titles(chosen.titles)}` : "Rewrite"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
