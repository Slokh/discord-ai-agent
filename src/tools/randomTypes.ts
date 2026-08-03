export type WagerRule =
  | { kind: "coin_side"; side: "heads" | "tails" }
  | { kind: "sum"; operator: ">=" | ">" | "<=" | "<" | "="; target: number }
  | { kind: "any_match" }
  | { kind: "all_distinct" };

export type DrawRandomInput = {
  kind?: string;
  count?: number;
  min?: number;
  max?: number;
  sides?: number;
  options?: string[];
  deckCount?: number;
  reason?: string;
  until?: {
    values?: Array<number | string>;
    maxDraws?: number;
  };
  wagerAction?: "hit" | "stand";
  wager?: {
    playerUserId?: string;
    stakeUsd?: number;
    maxPayoutUsd?: number;
    game?: string;
    interactionMode?: "automatic" | "player_decisions";
    rule?: WagerRule;
  };
};
