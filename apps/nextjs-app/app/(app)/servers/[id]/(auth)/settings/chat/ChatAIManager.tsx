"use client";

import { Loader, Zap } from "lucide-react";
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
import { Separator } from "@/components/ui/separator";
import type { ServerPublic } from "@/lib/types";
import {
  clearChatConfigAction,
  saveChatConfigAction,
  testChatConnectionAction,
} from "./actions";
import {
  initialSettings,
  isComplete,
  ModelFields,
  type ModelSettings,
} from "./model-fields";

export function ChatAIManager({ server }: { server: ServerPublic }) {
  const [settings, setSettings] = useState<ModelSettings>(
    initialSettings({
      provider: server.chatProvider,
      baseUrl: server.chatBaseUrl,
      model: server.chatModel,
    }),
  );
  // Don't pre-fill API key for security - just track if one exists
  const hasExistingApiKey = server.hasChatApiKey;
  const [isConfigured, setIsConfigured] = useState(
    Boolean(server.chatProvider),
  );

  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [showClearDialog, setShowClearDialog] = useState(false);

  const config = () => ({
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey || undefined,
    model: settings.model,
  });

  const handleSaveConfig = async () => {
    setIsSaving(true);
    try {
      await saveChatConfigAction(server.id, config());
      setIsConfigured(true);
      toast.success("AI Chat configuration saved");
    } catch (_error) {
      toast.error("Failed to save AI Chat configuration");
    } finally {
      setIsSaving(false);
    }
  };

  const handleTestConnection = async () => {
    setIsTesting(true);
    try {
      const result = await testChatConnectionAction(server.id, config());
      if (result.success) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    } catch (_error) {
      toast.error("Failed to test connection");
    } finally {
      setIsTesting(false);
    }
  };

  const handleClearConfig = async () => {
    setIsClearing(true);
    try {
      await clearChatConfigAction(server.id);
      setIsConfigured(false);
      toast.success("AI Chat configuration cleared");
      setSettings(initialSettings());
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to clear configuration",
      );
    } finally {
      setIsClearing(false);
      setShowClearDialog(false);
    }
  };

  return (
    <>
      <Card className="w-full mb-6">
        <CardHeader>
          <CardTitle>Chat Model</CardTitle>
          <CardDescription>
            Configure an AI provider to enable the chat assistant. Use Cmd+K to
            ask questions about your watch history and get recommendations.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <ModelFields
            id="chat"
            value={settings}
            onChange={setSettings}
            hasSavedKey={hasExistingApiKey}
          />

          <div className="flex gap-2">
            <Button
              type="button"
              onClick={handleSaveConfig}
              disabled={isSaving || !settings.baseUrl || !settings.model}
              className="flex-1"
            >
              {isSaving ? "Saving..." : "Save Configuration"}
            </Button>
            <Button
              type="button"
              onClick={handleTestConnection}
              disabled={isTesting || !isComplete(settings, hasExistingApiKey)}
              variant="outline"
              className="flex items-center gap-1"
            >
              {isTesting ? (
                <>
                  <Loader className="h-4 w-4 animate-spin" /> Testing...
                </>
              ) : (
                <>
                  <Zap className="h-4 w-4" /> Test
                </>
              )}
            </Button>
          </div>

          <Separator />

          <div className="space-y-4">
            <h3 className="text-sm font-medium">Clear Configuration</h3>
            <p className="text-sm text-gray-400">
              Remove the AI Chat configuration from this server.
            </p>
            <Button
              type="button"
              variant="destructive"
              onClick={() => setShowClearDialog(true)}
              disabled={isClearing || !isConfigured}
            >
              {isClearing ? "Clearing..." : "Clear Configuration"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={showClearDialog} onOpenChange={setShowClearDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear AI Chat Configuration?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the AI Chat configuration. The chat feature will
              be disabled until you configure a new provider.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleClearConfig();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isClearing ? "Clearing..." : "Clear Configuration"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
