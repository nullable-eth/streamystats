"use server";

import { redirect } from "next/navigation";
import { Container } from "@/components/Container";
import { listKnowledgeModels } from "@/lib/db/knowledge-models";
import { getServer } from "@/lib/db/server";
import { ModelsManager } from "./ModelsManager";

/** Every model Streamystats talks to, in one place. */
export default async function AIModelsSettings(props: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await props.params;
  const server = await getServer({ serverId: id });

  if (!server) {
    redirect("/setup");
  }

  return (
    <Container className="flex flex-col">
      <h1 className="text-3xl font-bold mb-8">AI Models</h1>
      <ModelsManager
        serverId={server.id}
        chat={
          server.chatProvider && server.chatModel
            ? {
                provider: server.chatProvider,
                baseUrl: server.chatBaseUrl,
                model: server.chatModel,
                hasApiKey: server.hasChatApiKey,
              }
            : null
        }
        embedding={
          server.embeddingProvider && server.embeddingModel
            ? {
                provider: server.embeddingProvider,
                baseUrl: server.embeddingBaseUrl,
                model: server.embeddingModel,
                dimensions: server.embeddingDimensions,
                hasApiKey: server.hasEmbeddingApiKey,
              }
            : null
        }
        knowledgeModels={await listKnowledgeModels(server.id)}
      />
    </Container>
  );
}
