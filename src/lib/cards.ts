export interface RiftCard {
  id: string;
  name: string;
  riftbound_id?: string;
  collector_number?: number | null;
  attributes?: { energy?: number | null; might?: number | null; power?: number | null };
  classification?: { type?: string; supertype?: string; rarity?: string; domain?: string[] };
  text?: { plain?: string; flavour?: string | null };
  set?: { set_id?: string; label?: string };
  media?: { image_url?: string; artist?: string; accessibility_text?: string };
  tags?: string[];
}

const proxyUrl = import.meta.env.VITE_RIFTCODEX_PROXY_URL as string | undefined;
const apiRoot = "https://api.riftcodex.com";

export async function searchCards(query: string, signal?: AbortSignal): Promise<RiftCard[]> {
  const params = new URLSearchParams({ fuzzy: query });
  const url = proxyUrl
    ? `${proxyUrl.replace(/\/$/, "")}?${params}`
    : `${apiRoot}/cards/name?${params}`;

  let response: Response;
  try {
    response = await fetch(url, { signal, headers: { Accept: "application/json" } });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error(
      proxyUrl
        ? "Card search proxy could not be reached. Check its deployment and URL."
        : "Riftcodex could not be reached from this browser. Its docs do not confirm CORS; deploy the included external proxy and set VITE_RIFTCODEX_PROXY_URL.",
    );
  }
  if (!response.ok) throw new Error(`Riftcodex search failed (${response.status}).`);
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { items?: unknown }).items)) {
    throw new Error("Riftcodex returned an unexpected response; expected an items array.");
  }
  return (payload as { items: RiftCard[] }).items;
}

export function toCardSnapshot(card: RiftCard) {
  return {
    card_id: card.id,
    name: card.name,
    set_id: card.set?.set_id ?? "",
    image_url: card.media?.image_url ?? "",
    collector_number: card.collector_number ?? null,
    rarity: card.classification?.rarity ?? "",
  };
}
