import { describe, expect, it, vi } from "vitest";
import { searchCards } from "./cards";

describe("Riftcodex search", () => {
  it("uses the documented fuzzy-name query and reads the documented items envelope", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      items: [{ id: "card-1", name: "Test card" }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(searchCards("test card")).resolves.toEqual([{ id: "card-1", name: "Test card" }]);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.riftcodex.com/cards/name?fuzzy=test+card");
    vi.unstubAllGlobals();
  });

  it("surfaces invalid upstream response shapes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
    await expect(searchCards("test")).rejects.toThrow("expected an items array");
    vi.unstubAllGlobals();
  });
});
