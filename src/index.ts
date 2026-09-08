/**
 * LLM Chat Application Template
 *
 * A simple chat application using Cloudflare Workers AI.
 * Streaming responses using Server-Sent Events (SSE).
 *
 * @license MIT
 */

const MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const SYSTEM_PROMPT =
  "You are a helpful, friendly assistant. Provide concise and accurate responses.";

export interface Env {
  AI: Ai;
  ASSETS: Fetcher;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatRequestBody {
  messages?: ChatMessage[];
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
      if (!env.ASSETS) {
        return new Response(
          "ASSETS binding is not configured. Please check wrangler.jsonc.",
          { status: 500 }
        );
      }
      return env.ASSETS.fetch(request);
    }

    if (url.pathname === "/api/chat") {
      if (request.method === "POST") {
        return handleChatRequest(request, env);
      }
      return new Response("Method not allowed", { status: 405 });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function handleChatRequest(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    if (!env.AI) {
      return new Response(
        JSON.stringify({
          error: "AI binding is not configured. Please check wrangler.jsonc.",
        }),
        { status: 500, headers: { "content-type": "application/json" } }
      );
    }

    const body = (await request.json()) as ChatRequestBody;
    const incoming: ChatMessage[] = body.messages ?? [];

    // ⭐ 只取「最後一則 user 訊息」，不帶任何歷史上下文。
    // 對 WAF 而言：每次請求 body 只含當前問句，歷史裡曾出現的禁字不會殘留、
    // 也就不會造成後續正常問題被連坐攔截。
    const lastUser = [...incoming].reverse().find((m) => m.role === "user");

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
    ];
    if (lastUser) {
      messages.push({ role: "user", content: lastUser.content });
    }

    const response = await env.AI.run(
      MODEL_ID,
      {
        messages,
        max_tokens: 1024,
        stream: true,
      },
      {
        returnRawResponse: true,
      }
    );

    return response;
  } catch (error) {
    console.error("Error processing chat request:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to process request",
        detail: error instanceof Error ? error.message : String(error),
      }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }
}
