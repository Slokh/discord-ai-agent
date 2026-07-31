import { describe, expect, it } from "vitest";
import { mentionedUserIdentitiesFromMessage } from "../../src/discord/mentionedUsers.js";

describe("Discord mentioned-user identities", () => {
  it("uses the live guild display name and username for explicit mentions", () => {
    const identities = mentionedUserIdentitiesFromMessage(
      {
        mentions: {
          members: new Map([["friend-id", {
            displayName: "Friend",
            user: { username: "friend_user", globalName: "Global Friend" },
          }]]),
          users: new Map([["friend-id", {
            username: "friend_user",
            globalName: "Global Friend",
          }]]),
        },
      } as never,
      ["friend-id"],
    );

    expect(identities).toEqual([{
      userId: "friend-id",
      mention: "<@friend-id>",
      username: "friend_user",
      displayName: "Friend",
    }]);
  });

  it("preserves the mention token when Discord has no cached identity", () => {
    expect(mentionedUserIdentitiesFromMessage(
      { mentions: { members: new Map(), users: new Map() } } as never,
      ["uncached-id"],
    )).toEqual([{
      userId: "uncached-id",
      mention: "<@uncached-id>",
      username: null,
      displayName: null,
    }]);
  });
});
