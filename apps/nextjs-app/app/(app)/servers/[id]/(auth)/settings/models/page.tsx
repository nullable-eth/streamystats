"use server";

import { redirect } from "next/navigation";
import { Container } from "@/components/Container";
import { listKnowledgeModels } from "@/lib/db/knowledge-models";
import { getServer } from "@/lib/db/server";
import { ChatAIManager } from "../chat/ChatAIManager";
import { EmbeddingProviderManager } from "../EmbeddingProviderManager";
import { KnowledgeModelsManager } from "./KnowledgeModelsManager";

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

      <div className="space-y-8">
        <EmbeddingProviderManager server={server} />
        <ChatAIManager server={server} />
        <KnowledgeModelsManager
          serverId={server.id}
          models={await listKnowledgeModels(server.id)}
        />
      </div>
    </Container>
  );
}
