"use server";

import { redirect } from "next/navigation";
import { Container } from "@/components/Container";
import { getServer } from "@/lib/db/server";
import { ChatAIManager } from "../chat/ChatAIManager";
import { EmbeddingProviderManager } from "../EmbeddingProviderManager";

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
        <ChatAIManager server={server} purpose="synopsis" />
      </div>
    </Container>
  );
}
