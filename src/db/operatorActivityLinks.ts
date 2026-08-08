export const RELATED_CASES_FOR_IMPROVEMENT_SQL = `
  LEFT JOIN LATERAL (
    SELECT array_agg(link.case_id ORDER BY link.case_id) AS related_case_ids
    FROM (
      SELECT case_row.case_id
      UNION
      SELECT related_signal.case_id
      FROM improvement_signals source_signal
      JOIN improvement_signals related_signal
        ON related_signal.execution_id = source_signal.execution_id
       AND related_signal.execution_id IS NOT NULL
      JOIN improvement_cases related_case ON related_case.case_id = related_signal.case_id
      WHERE source_signal.case_id = case_row.case_id
        AND related_case.merged_into_case_id IS NULL
    ) link
  ) related ON true`;

export const RELATED_CASES_FOR_EXECUTION_SQL = `
  LEFT JOIN LATERAL (
    SELECT array_agg(DISTINCT signal.case_id ORDER BY signal.case_id) AS related_case_ids
    FROM improvement_signals signal
    JOIN improvement_cases case_row USING (case_id)
    WHERE signal.execution_id = recent.execution_id
      AND case_row.merged_into_case_id IS NULL
  ) linked ON true`;

export type OperatorActivitySource = {
  id: string;
  kind: "runtime" | "code_change" | "improvement" | "system";
  title: string;
  status: string | null;
  detail: string | null;
  occurredAt: Date;
  startedAt: Date;
  durationMs: number | null;
  attempts: number | null;
  eventCount: number;
  rollupKey: string | null;
  responseStatus: string | null;
  deliveryState: string | null;
  sourceUrl: string | null;
  responseUrl: string | null;
  responseKind: string | null;
  hasParent: boolean;
  pullRequestUrl: string | null;
  branchName: string | null;
  improvementCaseId: string | null;
  relatedImprovementCaseIds: string[];
  failureReason: string | null;
  events: Array<{ id: string; name: string; level: string; createdAt: Date }>;
};
