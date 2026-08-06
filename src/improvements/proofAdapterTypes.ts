export type ImprovementProofAdapterId =
  | "private_replay"
  | "release_verify"
  | "release_db_verify"
  | "private_regression_gate"
  | "deployment_canary"
  | "revision_quality"
  | "schedule_health";

export type ImprovementProofTrigger =
  | "post_deploy_private_replay"
  | "release_promotion"
  | "production_observation";

export type ImprovementProofAdapter = {
  id: ImprovementProofAdapterId;
  trigger: ImprovementProofTrigger;
  proofSource: "private_eval" | "release_ci" | "deployment" | "revision_quality" | "schedule_health";
};
