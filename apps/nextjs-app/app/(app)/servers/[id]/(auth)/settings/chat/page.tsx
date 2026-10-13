import { redirect } from "next/navigation";

/** The chat model now lives in AI Models with the other model settings. */
export default async function ChatAISettings(props: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await props.params;
  redirect(`/servers/${id}/settings/models`);
}
