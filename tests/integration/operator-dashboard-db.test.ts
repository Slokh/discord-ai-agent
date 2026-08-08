import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deriveOperatorActivity } from "../../src/console/activity.js";
import { OperatorDashboardRepository } from "../../src/db/operatorDashboardRepository.js";
import type { DbPool } from "../../src/db/pool.js";
import { ServiceHeartbeatRepository } from "../../src/db/serviceHeartbeatRepository.js";
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from "./testDatabase.js";

const runDbTests = process.env.DISCORD_AI_AGENT_DB_TESTS === "true";

describe.skipIf(!runDbTests)("operator dashboard database projection", () => {
  let database: IsolatedTestDatabase;
  let pool: DbPool;

  beforeAll(async () => {
    database = await createIsolatedTestDatabase("operator_dashboard");
    pool = database.pool;
  });

  afterAll(async () => database.cleanup());

  it("projects liveness, active work, improvements, proof, and release activity", async () => {
    const heartbeat = new ServiceHeartbeatRepository(pool);
    await heartbeat.pulse({
      component: "worker", instanceId: "worker-1", revision: "revision-a",
      startedAt: new Date(Date.now() - 30_000),
    });
    await pool.query(
      `INSERT INTO agent_runtime_sessions(session_id,thread_key,title,request,requested_by,status)
       VALUES ('agent-session-dashboard','dashboard-thread','Answer a member','Private prompt content','discord','running')`,
    );
    await pool.query(
      `INSERT INTO agent_runtime_executions(execution_id,session_id,status,model,started_at)
       VALUES ('agent-execution-dashboard','agent-session-dashboard','running','model-a',now() - interval '5 seconds')`,
    );
    await pool.query(
      `INSERT INTO agent_runtime_sessions(session_id,thread_key,title,request,requested_by,status,metadata,started_at,completed_at,updated_at)
       VALUES
         ('agent-session-canary-active','canary-active-thread','Active post-deploy canary','Synthetic active prompt','canary','running','{"qualityCohort":"synthetic"}',now() - interval '10 seconds',NULL,now()),
         ('agent-session-canary-complete','canary-complete-thread','Completed post-deploy canary','Synthetic completed prompt','canary','succeeded','{"qualityCohort":"synthetic"}',now() - interval '2 minutes',now(),now())`,
    );
    await pool.query(
      `INSERT INTO agent_runtime_executions(execution_id,session_id,status,model,started_at,completed_at,updated_at)
       VALUES
         ('agent-execution-canary-active','agent-session-canary-active','running','model-a',now() - interval '10 seconds',NULL,now()),
         ('agent-execution-canary-complete','agent-session-canary-complete','succeeded','model-a',now() - interval '2 minutes',now(),now())`,
    );
    await pool.query(
      `INSERT INTO agent_runtime_events(session_id,execution_id,sequence,kind,level,event_name,summary)
       VALUES
         ('agent-session-dashboard','agent-execution-dashboard',1,'status','info','agent.execution.started','Executing prompt'),
         ('agent-session-dashboard','agent-execution-dashboard',2,'status','info','agent.execution.context_ready','Context ready')`,
    );
    await pool.query(
      `INSERT INTO agent_runtime_sessions(session_id,thread_key,title,request,requested_by,status,started_at,completed_at,updated_at)
       VALUES ('agent-session-complete','complete-thread','Recovered reply','Private completed prompt','discord','succeeded',now() - interval '2 minutes',now(),now())`,
    );
    await pool.query(
      `INSERT INTO agent_runtime_executions(execution_id,session_id,attempt,status,model,metadata,started_at,completed_at,updated_at)
       VALUES
         ('agent-execution-attempt-1','agent-session-complete',1,'failed','model-a','{"title":"First failed prompt"}',now() - interval '2 minutes',now() - interval '90 seconds',now() - interval '90 seconds'),
         ('agent-execution-attempt-2','agent-session-complete',2,'succeeded','model-a','{"title":"Recovered prompt"}',now() - interval '80 seconds',now(),now())`,
    );
    await pool.query(
      `INSERT INTO agent_runtime_events(session_id,execution_id,sequence,kind,level,event_name)
       VALUES
         ('agent-session-complete','agent-execution-attempt-1',1,'status','info','agent.execution.started'),
         ('agent-session-complete','agent-execution-attempt-1',2,'status','error','agent.model.call.failed'),
         ('agent-session-complete','agent-execution-attempt-2',1,'status','info','agent.nanocodex.complete')`,
    );
    await pool.query(
      `INSERT INTO agent_runtime_events(
         session_id,execution_id,sequence,kind,level,event_name,summary,metadata,duration_ms,span_id,parent_span_id
       ) VALUES (
         'agent-session-complete','agent-execution-attempt-2',2,'model','info','agent.model.call.completed',
         'Generate the final reply',
         '{"model":"model-a","reasoningEffort":"high","usage":{"total_tokens":1234},"estimatedCostUsd":0.0123,"argumentsPreview":"private secret"}',
         3210,'model-call-a','agent.request'
       )`,
    );
    await pool.query(
      `INSERT INTO discord_delivery_obligations(
         execution_id,thread_key,guild_id,channel_id,status_channel_id,status_message_id,source_message_id,state
       ) VALUES
         ('agent-execution-attempt-1','complete-thread','guild-a','channel-a','channel-a','reply-a','source-a','abandoned'),
         ('agent-execution-attempt-2','complete-thread','guild-a','channel-a','channel-a','reply-b','source-b','delivered')`,
    );
    await pool.query(`INSERT INTO guilds(id,name) VALUES ('guild-a','Test guild')`);
    await pool.query(
      `INSERT INTO discord_users(id,username,global_name,is_bot) VALUES
         ('member-a','member-a','Member A',false),
         ('assistant-a','assistant-a','Assistant',true)`,
    );
    await pool.query(
      `INSERT INTO messages(
         id,guild_id,channel_id,author_id,content,normalized_content,created_at,deleted_at,referenced_message_id
       ) VALUES
         ('attachment-only','guild-a','channel-a','member-a','','',now() - interval '5 minutes',NULL,NULL),
         ('deleted-bot','guild-a','channel-a','assistant-a','','',now() - interval '4 minutes',now(),'attachment-only'),
         ('parent-a','guild-a','channel-a','assistant-a','Earlier assistant reply','Earlier assistant reply',now() - interval '3 minutes',NULL,'deleted-bot'),
         ('source-b','guild-a','channel-a','member-a','Current member prompt','Current member prompt',now() - interval '1 minute',NULL,'parent-a')`,
    );
    await pool.query(
      `INSERT INTO attachments(id,message_id,url,filename,content_type,size_bytes)
       VALUES ('attachment-a','attachment-only','https://cdn.example.test/file.png','file.png','image/png',2048)`,
    );
    await pool.query(
      `INSERT INTO agent_runtime_messages(message_id,session_id,client_message_id,role,parts,metadata,created_at) VALUES
         ('runtime-deleted-bot','agent-session-complete','deleted-bot','assistant','[{"type":"text","text":"Retained deleted reply"}]','{"executionId":"older-execution"}',now() - interval '4 minutes'),
         ('runtime-user-b','agent-session-complete','source-b','user','[{"type":"text","text":"Current member prompt"}]','{"executionId":"agent-execution-attempt-2","userDisplayName":"Member A"}',now() - interval '1 minute'),
         ('runtime-assistant-b','agent-session-complete','reply-b','assistant','[{"type":"text","text":"Final assistant reply"}]','{"executionId":"agent-execution-attempt-2","discordUrl":"https://discord.com/channels/guild-a/channel-a/reply-b"}',now())`,
    );
    await pool.query(
      `INSERT INTO agent_tasks(task_id,task_type,title,request,requested_by,status,current_step)
       VALUES
         ('task-dashboard','code_update','Build the dashboard','Implement it','operator','queued','queued'),
         ('task-canary-active','post-deploy-canary','Active sandbox canary','Verify callback','system','running','callback_canary'),
         ('task-canary-complete','post-deploy-canary','Completed sandbox canary','Verify callback','system','completed','completed')`,
    );
    await pool.query(
      `INSERT INTO improvement_cases(case_id,scope,privacy,title,status,classification,severity,automation_state,automation_blocker)
       VALUES ('imp-dashboard','repository','private','Dashboard visibility','actionable','product_gap','high','blocked','waiting_for_proof')`,
    );
    await pool.query(
      `INSERT INTO improvement_case_events(case_id,event_name,actor_kind,summary)
       VALUES
         ('imp-dashboard','case.created','operator','Improvement created'),
         ('imp-dashboard','triage.applied','agent','Improvement triaged')`,
    );
    await pool.query(
      `INSERT INTO improvement_reporter_conversations(
         conversation_id,case_id,guild_id,source_channel_id,source_message_id,
         delivery_kind,delivery_channel_id,delivery_message_id
       ) VALUES ('conversation-dashboard','imp-dashboard','guild-a','channel-a','report-a','thread','thread-a','thread-message-a')`,
    );
    await pool.query(
      `INSERT INTO improvement_work_attempts(
         work_id,case_id,source,source_key,status,repository,pull_request_number,pull_request_url
       ) VALUES ('work-dashboard','imp-dashboard','github_pull_request','github:pr:1','in_progress','owner/repo',1,'https://github.com/owner/repo/pull/1')`,
    );
    await pool.query(
      `INSERT INTO deployment_verifications(revision,deployment_id) VALUES ('revision-a','deployment-a')`,
    );

    const snapshot = await new OperatorDashboardRepository(pool).snapshot({ revision: "revision-a" });

    expect(snapshot.summary).toMatchObject({ serviceTelemetryAvailable: true, activeRuns: 1, activeTasks: 1, openImprovements: 1, needsAttention: 1 });
    expect(snapshot.services.find((service) => service.component === "worker")).toMatchObject({ status: "healthy", instances: 1, revision: "revision-a" });
    expect(snapshot.executions[0]).toMatchObject({ title: "Answer a member", requestPreview: "Private prompt content", latestEvent: "agent.execution.context_ready" });
    expect(snapshot.tasks[0]).toMatchObject({ taskId: "task-dashboard", currentStep: "queued" });
    expect(snapshot.improvements.cases[0]).toMatchObject({ caseId: "imp-dashboard", automationState: "blocked", pullRequestUrl: "https://github.com/owner/repo/pull/1" });
    expect(snapshot.deployments[0]).toMatchObject({ revision: "revision-a", deploymentId: "deployment-a" });
    expect(snapshot.producers).toHaveLength(5);
    expect(snapshot.activity.map((story) => story.kind)).toEqual(expect.arrayContaining(["runtime", "improvement"]));
    expect(snapshot.activity.filter((story) => story.kind === "runtime")).toHaveLength(2);
    expect(JSON.stringify({ executions: snapshot.executions, tasks: snapshot.tasks, activity: snapshot.activity })).not.toContain("canary");
    expect(snapshot.activity.find((story) => story.id === "runtime-agent-execution-attempt-2")).toMatchObject({
      title: "Recovered prompt",
      attempts: 2,
      eventCount: 2,
      deliveryState: "delivered",
      hasParent: true,
      sourceUrl: "https://discord.com/channels/guild-a/channel-a/source-b",
      responseUrl: "https://discord.com/channels/guild-a/channel-a/reply-b",
      responseKind: "reply",
      events: [
        expect.objectContaining({ name: "agent.model.call.completed" }),
      ],
    });
    expect(snapshot.activity.filter((story) => story.kind === "improvement")).toHaveLength(1);
    expect(snapshot.activity.find((story) => story.id === "improvement-imp-dashboard")).toMatchObject({
      eventCount: 2,
      sourceUrl: "https://discord.com/channels/guild-a/channel-a/report-a",
      responseUrl: "https://discord.com/channels/guild-a/thread-a/thread-message-a",
      responseKind: "thread",
      events: [
        expect.objectContaining({ name: "triage.applied" }),
      ],
    });
    expect(JSON.stringify(snapshot.activity)).not.toContain("Executing prompt");
    expect(JSON.stringify(snapshot)).not.toContain('"requestedBy"');

    const conversation = await new OperatorDashboardRepository(pool).activityDetail({
      kind: "conversation",
      id: "runtime-agent-execution-attempt-2",
      revision: "revision-a",
    });
    expect(conversation).toMatchObject({
      executionId: "agent-execution-attempt-2",
      story: {
        id: "runtime-agent-execution-attempt-2",
        kind: "conversation",
        technicalEvents: expect.arrayContaining([expect.objectContaining({ name: "agent.model.call.completed" })]),
      },
      messages: [
        { id: "attachment-only", role: "member", content: "", unavailable: false, attachments: [{ filename: "file.png", contentType: "image/png", sizeBytes: 2048 }] },
        { id: "deleted-bot", role: "assistant", content: "Retained deleted reply", deleted: true, retained: true },
        { id: "parent-a", role: "assistant", content: "Earlier assistant reply", directParent: true, current: false },
        { id: "source-b", role: "member", content: "Current member prompt", current: true },
        { id: "reply-b", role: "assistant", content: "Final assistant reply", reply: true },
      ],
      traceEvents: expect.arrayContaining([
        expect.objectContaining({ id: expect.any(String), type: "event", code: "agent.nanocodex.complete" }),
        expect.objectContaining({
          type: "model", title: "Model call completed", summary: "Generate the final reply",
          durationMs: 3210, spanId: "model-call-a", parentSpanId: "agent.request",
          metadata: expect.objectContaining({ model: "model-a", reasoningEffort: "high", estimatedCostUsd: 0.0123 }),
        }),
      ]),
    });
    expect(JSON.stringify(conversation)).not.toContain("private secret");

    const improvement = await new OperatorDashboardRepository(pool).activityDetail({
      kind: "improvement",
      id: "improvement-imp-dashboard",
      revision: "revision-a",
    });
    expect(improvement).toMatchObject({
      active: false,
      story: {
        id: "improvement-imp-dashboard",
        technicalEvents: [
          expect.objectContaining({ name: "triage.applied" }),
          expect.objectContaining({ name: "case.created" }),
        ],
      },
    });
  });

  it("keeps the production projection available before heartbeat storage is deployed", async () => {
    await pool.query(`DROP TABLE service_runtime_heartbeats`);

    const snapshot = await new OperatorDashboardRepository(pool).snapshot({ revision: "revision-a" });

    expect(snapshot.services).toHaveLength(4);
    expect(snapshot.services.map((service) => service.status)).toEqual([
      "unavailable", "unavailable", "unavailable", "unavailable",
    ]);
    expect(snapshot.summary).toMatchObject({ serviceCount: 4, serviceTelemetryAvailable: false });
  });

  it("projects every eligible source before semantic folding", async () => {
    await pool.query(
      `INSERT INTO agent_runtime_sessions(
         session_id,thread_key,title,request,requested_by,status,started_at,completed_at,updated_at
       )
       SELECT 'bulk-prompt-session-' || item,'bulk-prompt-thread-' || item,'Bulk prompt ' || item,
              'Private prompt','test','succeeded',now() - item * interval '1 minute',now(),now() - item * interval '1 minute'
       FROM generate_series(1,30) item`,
    );
    await pool.query(
      `INSERT INTO agent_runtime_executions(
         execution_id,session_id,status,started_at,completed_at,updated_at
       )
       SELECT 'bulk-prompt-execution-' || item,'bulk-prompt-session-' || item,'succeeded',
              now() - item * interval '1 minute',now(),now() - item * interval '1 minute'
       FROM generate_series(1,30) item`,
    );
    await pool.query(
      `INSERT INTO agent_runtime_sessions(
         session_id,thread_key,title,request,requested_by,status,harness,metadata,started_at,completed_at,updated_at
       )
       SELECT 'bulk-system-session-' || item,'bulk-system-thread-' || item,'Bulk system job',
              'Internal work','system',CASE WHEN item = 14 THEN 'failed' ELSE 'succeeded' END,
              'background_job',jsonb_build_object('kind','background_job','jobKind','bulk_system'),
              now() - item * interval '1 minute',now(),now() - item * interval '1 minute'
       FROM generate_series(1,14) item`,
    );
    await pool.query(
      `INSERT INTO agent_runtime_executions(
         execution_id,session_id,status,metadata,started_at,completed_at,updated_at
       )
       SELECT 'bulk-system-execution-' || item,'bulk-system-session-' || item,
              CASE WHEN item = 14 THEN 'failed' ELSE 'succeeded' END,
              jsonb_build_object('jobKind','bulk_system'),now() - item * interval '1 minute',now(),now() - item * interval '1 minute'
       FROM generate_series(1,14) item`,
    );
    await pool.query(
      `INSERT INTO agent_tasks(task_id,task_type,title,request,requested_by,status,current_step,updated_at)
       SELECT 'bulk-code-task-' || item,'code_update','Bulk code task ' || item,'Implement change','test',
              'completed','completed',now() - item * interval '1 minute'
       FROM generate_series(1,45) item`,
    );
    await pool.query(
      `INSERT INTO improvement_cases(
         case_id,scope,privacy,title,status,classification,severity,automation_state,first_seen_at,last_seen_at
       )
       SELECT 'bulk-case-' || item,'repository','private','Bulk case ' || item,'resolved','product_gap','low','complete',
              now() - item * interval '1 minute',now() - item * interval '1 minute'
       FROM generate_series(1,25) item`,
    );
    await pool.query(
      `INSERT INTO improvement_case_events(case_id,event_name,actor_kind,summary,created_at)
       SELECT 'bulk-case-' || item,'case.created','system','Created',now() - item * interval '1 minute'
       FROM generate_series(1,25) item`,
    );

    const snapshot = await new OperatorDashboardRepository(pool).snapshot({ revision: "revision-a" });
    const activity = deriveOperatorActivity(snapshot);

    expect(snapshot.activity.filter((story) => story.id.startsWith("runtime-bulk-prompt-execution-"))).toHaveLength(30);
    expect(snapshot.activity.filter((story) => story.id.startsWith("task-bulk-code-task-"))).toHaveLength(45);
    expect(snapshot.activity.filter((story) => story.id.startsWith("improvement-bulk-case-"))).toHaveLength(25);
    expect(activity.recent.filter((story) => story.id.startsWith("runtime-bulk-prompt-execution-"))).toHaveLength(30);
    expect(activity.recent.filter((story) => story.id.startsWith("task-bulk-code-task-"))).toHaveLength(45);
    expect(activity.recent.filter((story) => story.id.startsWith("improvement-bulk-case-"))).toHaveLength(25);
    expect(activity.recent).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "runtime-bulk-system-execution-14", tone: "danger" }),
      expect.objectContaining({ id: "system-rollup-bulk_system", runCount: 13 }),
    ]));
  });
});
