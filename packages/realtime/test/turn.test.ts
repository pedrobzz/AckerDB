import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { ANONYMOUS_PRINCIPAL } from "@ackerdb/server";
import { createTurnConfiguration } from "../src/turn.ts";

describe("realtime TURN configuration", () => {
  test("issues bounded coturn REST credentials without exposing the secret", async () => {
    const secret = "deployment-only-secret-must-be-32b";
    const configuration = createTurnConfiguration({
      urls: [
        "turn:relay.example.test:3478?transport=udp",
        "turns:relay.example.test:5349?transport=tcp",
      ],
      stunUrls: "stun:relay.example.test:3478",
      secret,
      ttlSeconds: 600,
    }, () => 1_700_000_000_000);

    const value = await configuration(
      ANONYMOUS_PRINCIPAL,
      new AbortController().signal,
      "A".repeat(43),
    );
    const turn = value.iceServers?.[1];
    expect(value).toMatchObject({
      iceServers: [
        { urls: ["stun:relay.example.test:3478"] },
        {
          urls: [
            "turn:relay.example.test:3478?transport=udp",
            "turns:relay.example.test:5349?transport=tcp",
          ],
        },
      ],
      iceTransportPolicy: "all",
    });
    expect(turn?.username).toMatch(/^1700000600:[A-Za-z0-9_-]{43}$/);
    expect(turn?.credential).toBe(
      createHmac("sha1", secret)
        .update(turn?.username ?? "")
        .digest("base64"),
    );
    expect(JSON.stringify(value)).not.toContain(secret);
  });

  test("rejects invalid deployment configuration eagerly", () => {
    expect(() =>
      createTurnConfiguration({
        urls: "https://relay.example.test",
        secret: "secret",
      })
    ).toThrow("TURN URL");
    expect(() =>
      createTurnConfiguration({
        urls: "turn:relay.example.test",
        secret: "",
      })
    ).toThrow("secret cannot be empty");
    expect(() =>
      createTurnConfiguration({
        urls: "turn:relay.example.test",
        secret: "x".repeat(31),
      })
    ).toThrow("at least 32 bytes");
    expect(() =>
      createTurnConfiguration({
        urls: "turn:relay.example.test",
        secret: new Uint8Array(31),
      })
    ).toThrow("at least 32 bytes");
  });
});
