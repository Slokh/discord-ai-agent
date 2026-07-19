export type DrawRandomInput = {
  kind?: string;
  count?: number;
  min?: number;
  max?: number;
  sides?: number;
  options?: string[];
  deckCount?: number;
  reason?: string;
  wager?: {
    playerUserId?: string;
    stakeUsd?: number;
    maxPayoutUsd?: number;
    game?: string;
  };
};
