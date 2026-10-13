"use server";

import { redirect } from "next/navigation";
import { Container } from "@/components/Container";
import { getKnowledgeIndexStatus } from "@/lib/db/knowledge-index";
import { getServer } from "@/lib/db/server";
import { EmbeddingsManager } from "../EmbeddingsManager";
import { KnowledgeIndexManager } from "../KnowledgeIndexManager";

export default async function AISettings(props: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await props.params;
  const server = await getServer({ serverId: id });

  if (!server) {
    redirect("/setup");
  }

  const knowledge = await getKnowledgeIndexStatus(server.id);

  return (
    <Container className="flex flex-col">
      <h1 className="text-3xl font-bold mb-8">AI Recommendations</h1>

      <div className="space-y-8">
        <EmbeddingsManager server={server} />
        <KnowledgeIndexManager serverId={server.id} status={knowledge} />
      </div>
    </Container>
  );
}
