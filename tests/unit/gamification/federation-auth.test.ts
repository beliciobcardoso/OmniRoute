import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("Federation Leaderboard Auth", () => {
  it("rejects requests without Authorization header", async () => {
    const { GET } = await import("../../../src/app/api/gamification/federation/leaderboard/route");

    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/gamification/federation/leaderboard");

    const response = await GET(req);
    assert.equal(response.status, 401);
  });

  it("rejects requests with invalid bearer token", async () => {
    const { GET } = await import("../../../src/app/api/gamification/federation/leaderboard/route");
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/gamification/federation/leaderboard", {
      headers: { Authorization: "Bearer invalid-token-12345" },
    });

    const response = await GET(req);
    assert.equal(response.status, 403);
  });
});

describe("Federation Score Auth", () => {
  it("rejects requests without Authorization header", async () => {
    const { POST } = await import("../../../src/app/api/gamification/federation/score/route");
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/gamification/federation/score", {
      method: "POST",
      body: JSON.stringify({ apiKeyId: "x", score: 1 }),
    });

    const response = await POST(req);
    assert.equal(response.status, 401);
  });

  it("rejects requests with invalid bearer token (regression: getConnectedServerByKeyHash must be awaited)", async () => {
    const { POST } = await import("../../../src/app/api/gamification/federation/score/route");
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/gamification/federation/score", {
      method: "POST",
      headers: {
        Authorization: "Bearer invalid-token-12345",
        "content-type": "application/json",
      },
      body: JSON.stringify({ apiKeyId: "x", score: 1 }),
    });

    const response = await POST(req);
    // A Promise is always truthy — if getConnectedServerByKeyHash() is called
    // without await, `if (!server)` never fires and an invalid token is
    // silently accepted instead of rejected with 403.
    assert.equal(response.status, 403);
  });
});
