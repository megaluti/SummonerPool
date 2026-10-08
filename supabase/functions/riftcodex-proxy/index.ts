const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "GET") return respond({ error: "Only GET is supported." }, 405);

  const url = new URL(request.url);
  const query = url.searchParams.get("fuzzy")?.trim();
  if (!query || query.length > 100) return respond({ error: "Provide a fuzzy query of 1–100 characters." }, 400);

  let upstream: Response;
  try {
    upstream = await fetch(`https://api.riftcodex.com/cards/name?${new URLSearchParams({ fuzzy: query })}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    return respond({ error: "Riftcodex is currently unreachable." }, 502);
  }
  if (!upstream.ok) return respond({ error: `Riftcodex returned HTTP ${upstream.status}.` }, 502);
  const body: unknown = await upstream.json();
  if (!body || typeof body !== "object" || !Array.isArray((body as { items?: unknown }).items)) {
    return respond({ error: "Riftcodex returned an unexpected response." }, 502);
  }
  return respond(body, 200);
});

function respond(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
  });
}
