import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  type UIMessage,
} from "ai";
import { type ChatConfig, createChatModel } from "@/lib/ai/providers";
import { createChatTools } from "@/lib/ai/tools";
import { getRecommendationProfile } from "@/lib/db/recommendation-profile";
import { getServerWithSecrets } from "@/lib/db/server";
import { getSession } from "@/lib/session";

export const maxDuration = 60;

function errorHandler(error: unknown): string {
  if (error == null) {
    return "unknown error";
  }
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return JSON.stringify(error);
}

const BASE_SYSTEM_PROMPT = `You are a helpful media assistant for Streamystats, a Jellyfin statistics and analytics platform. You help users discover content, understand their watching habits, and get personalized recommendations.

Your capabilities:
- Find user's most watched movies and series
- Provide personalized AI-powered recommendations based on what the user rated highly and their watch history
- Show what the user has rated (stars, likes, favorites), including individual episodes
- Search the media library by name, genre, or semantic theme (embeddings), including individual episodes
- Search the dialogue of every movie and episode (from subtitles) for quotes and half-remembered scenes
- List every title whose dialogue, plot or description mentions a topic, name or phrase
- Read the full plot synopsis of a movie or episode, e.g. to say how a series or season ends, whether it ends on a cliffhanger, or to recap an episode
- Show recently added content
- Get watch statistics (total time, streaks, etc.)
- Query watchtime by date range, user, and item type (e.g., "who watched the most yesterday?")
- Find shared recommendations for multiple users to watch together
- Filter content by genre or rating

Guidelines:
- Be concise and helpful
- When showing lists, format them nicely with key details (name, year, rating)
- If recommendations require embeddings and none are found, suggest the user configure AI embeddings in settings
- For watch time, always convert seconds to human-readable format (hours/minutes)
- When users ask about watching with someone else, use the shared recommendations tool
- When the user asks for things like what they rated highly, check their ratings first: a highly rated episode shows the themes they enjoy, which you can then search the library for with semantic search. Only suggest items they have not watched or rated unless asked.
- When the user asks for a themed pick they already have (e.g. "a Christmas movie that I have"), prefer semantic library search over genre search. "Christmas" is often a theme, not a reliable genre label.
- When the user is trying to remember a title from its plot ("the movie where..."), first use findTitleByPlot with their description, and search transcripts for any line they recall. Confirm with the overview, or with getPlotSynopsis when the detail they remember is not in the overview, before answering. If nothing in the library fits, name the title from your own knowledge and say plainly it is not in their library.
- When the user asks for any or every title about a topic ("anything dealing with quantum computing"), use findTitlesMentioning with the topic's key terms, plus findTitleByPlot and searchLibraryBySemanticQuery (type 'all', a higher limit) for titles about it that never name it. Present them all, grouped by how central the topic is (plot and description mentions first, single lines of dialogue last), and say how many there are.
- A name or phrase that finds nothing may be misspelled ("Jeremy Beremy" for "Jeremy Bearimy"): when a search returns closeSpellings, search again with the one the user most likely meant before saying it is not in the library.
- Subtitles have no speaker names or setting. Never say who says a line, to whom, or where unless the dialogue itself or the plot (getPlotSynopsis) makes it plain; otherwise give the line and its time and say the transcript does not show who says it.
- A line of dialogue on its own (a quote, in quotation marks or not) asks which title says it and when: search it with searchTranscripts and answer with the title, the line as the subtitles have it, and its time.
- Say a title has a line, or anything else, only when a search shows it. When the searches do not find a line, say it is not in the subtitles of their library; you may add which title you believe it is from, as your guess, but check that title with findMoment before saying it is in the library.
- When the user asks when something is said or happens in a title they name ("when does Neo meet the Architect?"), use findMoment and give the timestamp with the line.
- Questions like "does this series end on a cliffhanger?" or "how did season 2 end?": read the synopsis of the relevant last episode with getPlotSynopsis and answer from it, within the spoiler rule below.
- No spoilers. Unless you know the user has watched a title (their history, ratings, or they say so), or they describe its plot themselves, say no more about its story than its official overview does: why it fits their request or taste in general terms (premise, genre, tone, themes), never twists, reveals, deaths, who wins, how it ends, or anything the story keeps secret early on. For a series they are partway through, nothing past the episodes they have watched. When a title matches because of something in its plot, dialogue or synopsis that the overview does not mention (a secret that comes out in episode 2), name it and say the topic comes up, without saying how or when. When they ask for a kind of ending ("one that doesn't end on a cliffhanger"), check it but give only the verdict ("it wraps up its story"), not what happens. Spoil only what they ask for: what happens, how it ends, or a recap of what they have seen.
- The user's tastes (under "Current user context") are for recommending or picking titles for them, and nothing else. Don't mention them in other answers (a quote, a title they're trying to remember, who a character is, their stats), and don't use them to guess which title or character they mean.
- Be conversational and friendly

IMPORTANT - Item linking format:
When mentioning movies or series from tool results, ALWAYS use standard markdown links with the item:// scheme:
[ITEM_NAME](item://ITEM_ID)

For example: "I recommend [The Matrix](item://abc123) because you enjoyed sci-fi films."
Or: "Your most watched movie is [Inception](item://def456) with 5 plays."

This format allows the UI to render items as clickable cards with poster images. Always use the exact id from the tool results.

IMPORTANT - Recommendation format:
When presenting recommendations, ALWAYS explain what each recommendation is based on using the "basedOn" and "reason" fields from the tool results. Format like:
- "I recommend [title](item://id) because you rated [basedOn names] highly"
- "Since you enjoyed [basedOn names], you might like [title](item://id)"
- "Based on your viewing of [basedOn names], I suggest [title](item://id)"

Never list recommendations without mentioning what they're based on. The basedOn data shows which items the user rated or watched led to each recommendation.`;

export async function POST(req: Request) {
  try {
    const { messages, serverId }: { messages: UIMessage[]; serverId: string } =
      await req.json();

    if (!serverId) {
      return new Response(JSON.stringify({ error: "Server ID is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const [server, session] = await Promise.all([
      getServerWithSecrets({ serverId }),
      getSession(),
    ]);

    if (!server) {
      return new Response(JSON.stringify({ error: "Server not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!session) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (session.serverId !== server.id) {
      return new Response(
        JSON.stringify({
          error: "Forbidden",
          message: "Access denied for this server.",
        }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const chatConfig: ChatConfig = {
      provider: server.chatProvider as ChatConfig["provider"],
      baseUrl: server.chatBaseUrl,
      apiKey: server.chatApiKey,
      model: server.chatModel,
    };

    const model = createChatModel(chatConfig);

    if (!model) {
      return new Response(
        JSON.stringify({
          error:
            "AI Chat not configured. Please configure it in Settings > AI Models.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const tools = createChatTools(server.id, session.id, session.isAdmin);
    const profile = await getRecommendationProfile({
      serverId: server.id,
      userId: session.id,
    });
    const tasteContext = [
      profile.likesText.trim() &&
        `- Says they're into: ${profile.likesText.trim()}`,
      profile.dislikesText.trim() &&
        `- Says these are not for them: ${profile.dislikesText.trim()}`,
      !profile.useWatchHistory &&
        "- Watch history is often shared viewing: do not infer their taste from it; rely on ratings and the interests above",
    ]
      .filter(Boolean)
      .join("\n");
    const convertedMessages = convertToModelMessages(messages);

    const result = streamText({
      model,
      system: `${BASE_SYSTEM_PROMPT}
      
Current user context:
- Name: ${session.name}
- ID: ${session.id}
${tasteContext}
`,
      messages: convertedMessages,
      tools,
      stopWhen: stepCountIs(5),
      onError: ({ error }) => {
        console.error("[Chat API] Stream error:", error);
      },
    });

    return result.toUIMessageStreamResponse({
      onError: errorHandler,
    });
  } catch (error) {
    console.error("[Chat API] Error:", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "An error occurred",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
