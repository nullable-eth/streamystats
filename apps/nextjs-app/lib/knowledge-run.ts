/**
 * Ask the job server to start a knowledge index run now, so a model turned on
 * or titles asked for next are worked on right away rather than at the next
 * scheduled run. Best effort: the schedule still runs it if this fails.
 */
export async function startKnowledgeRun(serverId: number): Promise<void> {
  const jobServerUrl =
    process.env.JOB_SERVER_URL && process.env.JOB_SERVER_URL !== "undefined"
      ? process.env.JOB_SERVER_URL
      : "http://localhost:3005";
  try {
    const response = await fetch(
      `${jobServerUrl}/api/jobs/scheduler/trigger-knowledge-sync`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId }),
      },
    );
    if (!response.ok) {
      console.warn(
        `[knowledge] could not start a run now: HTTP ${response.status}`,
      );
    }
  } catch (error) {
    console.warn("[knowledge] could not start a run now:", error);
  }
}
