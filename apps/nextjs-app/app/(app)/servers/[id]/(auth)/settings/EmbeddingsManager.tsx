"use client";

import { useQuery } from "@tanstack/react-query";
import { Loader, Play, Square } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
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
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import type { ServerPublic } from "@/lib/types";
import {
  clearEmbeddingsAction,
  type EmbeddingProgress,
  getEmbeddingProgressAction,
  setEmbeddingItemTypesAction,
  startEmbeddingAction,
  stopEmbeddingAction,
  toggleAutoEmbeddingsAction,
} from "./embedding-actions";

const TYPE_LABELS: Record<string, string> = {
  Movie: "Movies",
  Series: "Series",
  Episode: "Episodes",
};

/**
 * What gets embedded and when. The embedding model itself is set in AI Models.
 */
export function EmbeddingsManager({ server }: { server: ServerPublic }) {
  // The same check the job uses before it starts.
  const configured = Boolean(server.embeddingBaseUrl && server.embeddingModel);

  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [showClearDialog, setShowClearDialog] = useState(false);
  const [autoEmbeddings, setAutoEmbeddings] = useState(
    server.autoGenerateEmbeddings || false,
  );
  const [isUpdatingAutoEmbed, setIsUpdatingAutoEmbed] = useState(false);
  const [isSavingTypes, setIsSavingTypes] = useState(false);

  const {
    data: progress,
    error,
    refetch,
  } = useQuery<EmbeddingProgress>({
    queryKey: ["embedding-progress", server.id],
    queryFn: async () => await getEmbeddingProgressAction(server.id),
    refetchInterval: 2000,
    retry: 3,
    retryDelay: 1000,
  });

  // Existing embeddings must be cleared before switching to a model with a
  // different output size.
  const existingDimension = progress?.existingDimension;
  const hasDimensionMismatch =
    existingDimension !== null &&
    existingDimension !== undefined &&
    !!server.embeddingDimensions &&
    existingDimension !== server.embeddingDimensions;

  const handleStartEmbedding = async () => {
    setIsStarting(true);
    try {
      await startEmbeddingAction(server.id);
      toast.success("Embedding process started");
      refetch();
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : "Failed to start embedding process",
      );
    } finally {
      setIsStarting(false);
    }
  };

  const handleStopEmbedding = async () => {
    setIsStopping(true);
    try {
      await stopEmbeddingAction(server.id);
      toast.success("Embedding process stopped");
      refetch();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to stop embedding process",
      );
    } finally {
      setIsStopping(false);
    }
  };

  const handleClearEmbeddings = async () => {
    setIsClearing(true);
    try {
      // Stop any running embedding jobs first
      try {
        await stopEmbeddingAction(server.id);
      } catch {
        // Ignore errors - job might not be running
      }
      await clearEmbeddingsAction(server.id);
      toast.success("Embeddings and vector index cleared");
      refetch();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to clear embeddings",
      );
    } finally {
      setIsClearing(false);
      setShowClearDialog(false);
    }
  };

  const handleToggleType = async (type: string, on: boolean) => {
    const current = (progress?.byType ?? [])
      .filter((t) => t.enabled)
      .map((t) => t.type);
    const next = on
      ? [...new Set<string>([...current, type])]
      : current.filter((t) => t !== type);
    setIsSavingTypes(true);
    try {
      await setEmbeddingItemTypesAction(server.id, next);
      await refetch();
      toast.success(
        `${TYPE_LABELS[type] ?? type} ${on ? "will be" : "will no longer be"} embedded`,
      );
    } catch {
      toast.error("Failed to update which items are embedded");
    } finally {
      setIsSavingTypes(false);
    }
  };

  const handleToggleAutoEmbeddings = async (checked: boolean) => {
    setIsUpdatingAutoEmbed(true);
    try {
      await toggleAutoEmbeddingsAction(server.id, checked);
      setAutoEmbeddings(checked);
      toast.success(
        `Auto-generate embeddings ${checked ? "enabled" : "disabled"}`,
      );
    } catch (_error) {
      toast.error("Failed to update auto-embedding setting");
      // Reset to previous state
      setAutoEmbeddings(!checked);
    } finally {
      setIsUpdatingAutoEmbed(false);
    }
  };

  // Check if the process is actively running
  const isProcessRunning =
    progress?.status === "processing" || progress?.status === "starting";

  // Helper to get status text
  const getStatusText = (status: string) => {
    switch (status) {
      case "idle":
        return "Idle";
      case "starting":
        return "Starting embedding process...";
      case "processing":
        return "Generating embeddings for movies, series and episodes...";
      case "completed":
        return "All requested items have embeddings";
      case "failed":
        return "Process failed. Please try again.";
      case "stopped":
        return "Process was stopped";
      default:
        return status.charAt(0).toUpperCase() + status.slice(1);
    }
  };

  const modelsLink = (
    <Link
      href={`/servers/${server.id}/settings/models`}
      className="underline underline-offset-4"
    >
      AI Models
    </Link>
  );

  return (
    <>
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Media Embeddings</CardTitle>
          <CardDescription>
            Embeds each title&apos;s plot and details so recommendations and the
            chat can find similar titles. The embedding model is set in{" "}
            {modelsLink}.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {!configured && (
            <p className="text-sm text-muted-foreground">
              Set up an embedding model in {modelsLink} first.
            </p>
          )}
          {hasDimensionMismatch && (
            <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md">
              <p className="text-xs text-destructive font-medium">
                Dimension mismatch: existing embeddings have {existingDimension}{" "}
                dimensions, but the embedding model is set to{" "}
                {server.embeddingDimensions}. Clear existing embeddings below
                before embedding again.
              </p>
            </div>
          )}

          <div className="space-y-4">
            <div className="flex justify-between mb-2">
              <span className="text-sm font-medium">
                Status: {getStatusText(progress?.status ?? "idle")}
              </span>
              <span className="text-sm text-gray-400">
                {(progress?.embedded ?? 0).toLocaleString()} of{" "}
                {(progress?.total ?? 0).toLocaleString()} items embedded
                {(progress?.total ?? 0) > 0
                  ? ` (${(progress?.percentage ?? 0).toFixed(1)}%)`
                  : ""}
              </span>
            </div>

            <Progress value={progress?.percentage ?? 0} className="h-2" />

            <div className="space-y-2">
              {(progress?.byType ?? []).map((t) => (
                <div
                  key={t.type}
                  className="flex items-center justify-between gap-4 text-sm"
                >
                  <div className="flex items-center gap-3">
                    <Switch
                      id={`embed-type-${t.type}`}
                      checked={t.enabled}
                      disabled={isSavingTypes}
                      onCheckedChange={(on) => handleToggleType(t.type, on)}
                    />
                    <Label htmlFor={`embed-type-${t.type}`}>
                      {TYPE_LABELS[t.type]}
                    </Label>
                  </div>
                  <span className="text-gray-400">
                    {t.embedded.toLocaleString()} of {t.total.toLocaleString()}{" "}
                    embedded
                    {t.refreshing > 0
                      ? ` · ${t.refreshing.toLocaleString()} refreshing with new plots`
                      : ""}
                  </span>
                </div>
              ))}
            </div>

            <div className="flex gap-2 mt-4">
              <Button
                type="button"
                onClick={handleStartEmbedding}
                disabled={
                  isStarting ||
                  isProcessRunning ||
                  !configured ||
                  hasDimensionMismatch
                }
                className="flex items-center gap-1"
              >
                {isStarting ? (
                  <>
                    <Loader className="h-4 w-4 animate-spin" /> Starting...
                  </>
                ) : (
                  <>
                    <Play className="h-4 w-4" /> Start Embedding
                  </>
                )}
              </Button>

              <Button
                type="button"
                onClick={handleStopEmbedding}
                disabled={isStopping || !isProcessRunning}
                variant="secondary"
                className="flex items-center gap-1"
              >
                {isStopping ? (
                  <>
                    <Loader className="h-4 w-4 animate-spin" /> Stopping...
                  </>
                ) : (
                  <>
                    <Square className="h-4 w-4" /> Stop Embedding
                  </>
                )}
              </Button>
            </div>

            {error && (
              <div className="text-sm text-red-400 mt-2">
                Error fetching progress. Retrying...
              </div>
            )}
          </div>

          <Separator />

          <div className="space-y-4">
            <h3 className="text-sm font-medium">Auto-Generate Embeddings</h3>
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <p className="text-sm text-gray-400">
                  Automatically generate embeddings for all (and new) items
                </p>
                <p className="text-xs text-gray-400">
                  This requires an embedding model in AI Models
                </p>
              </div>
              <Switch
                checked={autoEmbeddings}
                onCheckedChange={handleToggleAutoEmbeddings}
                disabled={isUpdatingAutoEmbed || !configured}
              />
            </div>
          </div>

          <Separator />

          <div className="space-y-4">
            <h3 className="text-sm font-medium">Clear Embeddings</h3>
            <p className="text-sm text-gray-400">
              Clearing embeddings will remove all existing embeddings, reset the
              vector index, and require re-processing. Use this to fix dimension
              mismatches when changing embedding models.
            </p>
            <Button
              type="button"
              variant="destructive"
              onClick={() => setShowClearDialog(true)}
              disabled={isClearing}
            >
              {isClearing ? "Clearing..." : "Clear All Embeddings"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={showClearDialog} onOpenChange={setShowClearDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This will delete all embeddings and reset the vector index. Use
              this to fix dimension mismatches when switching embedding models.
              You will need to regenerate embeddings for AI recommendations.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleClearEmbeddings();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isClearing ? "Clearing..." : "Clear Embeddings"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
