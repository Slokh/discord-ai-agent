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
      `INSERT INTO channels(id,guild_id,name,type,is_thread,is_excluded)
       VALUES ('channel-a','guild-a','general',0,false,false)`,
    );
    await pool.query(
      `INSERT INTO discord_users(id,username,global_name,is_bot) VALUES
         ('member-a','member-a','Member A',false),
         ('assistant-a','assistant-a','Assistant',true),
         ('123','ai','AI',true)`,
    );
    await pool.query(
      `INSERT INTO messages(
         id,guild_id,channel_id,author_id,content,normalized_content,created_at,deleted_at,referenced_message_id
       ) VALUES
         ('attachment-only','guild-a','channel-a','member-a','','',now() - interval '5 minutes',NULL,NULL),
         ('deleted-bot','guild-a','channel-a','assistant-a','','',now() - interval '4 minutes',now(),'attachment-only'),
         ('parent-a','guild-a','channel-a','assistant-a','**Earlier assistant reply** -# 5.9s','Earlier assistant reply',now() - interval '3 minutes',NULL,'deleted-bot'),
         ('source-b','guild-a','channel-a','member-a','<@&456> Current member prompt','Current member prompt',now() - interval '1 minute',NULL,'parent-a'),
         ('mention-source','guild-a','channel-a','member-a','<@123> <@&456> balances','balances',now(),NULL,NULL)`,
    );
    await pool.query(
      `UPDATE messages
       SET raw = '{"mentions":{"roles":[{"id":"456","name":"AI role"}]}}'::jsonb
       WHERE id IN ('source-b','mention-source')`,
    );
    await pool.query(
      `INSERT INTO attachments(id,message_id,url,filename,content_type,size_bytes)
       VALUES ('attachment-a','attachment-only','https://cdn.example.test/file.png','file.png','image/png',2048)`,
    );
    await pool.query(
      `INSERT INTO message_embeddings(message_id,embedding,model,dimensions,input_version,input_text,embedded_at)
       VALUES
         ('source-b',array_fill(0::real,ARRAY[1536])::vector,'text-embedding-3-small',1536,2,'Current member prompt',now()),
         ('mention-source',array_fill(0::real,ARRAY[1536])::vector,'text-embedding-3-small',1536,2,'balances',now())`,
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
      `INSERT INTO agent_tasks(
         task_id,task_type,title,request,requested_by,status,error,created_at,started_at,completed_at,updated_at
       ) VALUES
         (
           'task-legacy-orphan','code_update','Legacy orphaned failure','Old private request','operator','failed','old failure',
           (SELECT applied_at - interval '2 minutes' FROM schema_migrations WHERE version = '039_improvement_cases'),
           (SELECT applied_at - interval '90 seconds' FROM schema_migrations WHERE version = '039_improvement_cases'),
           (SELECT applied_at - interval '1 minute' FROM schema_migrations WHERE version = '039_improvement_cases'),
           now()
         ),
         (
           'task-current-orphan','code_update','Current standalone failure','Current private request','operator','failed','current failure',
           now(),now(),now(),now()
         )`,
    );
    await pool.query(
      `INSERT INTO agent_tasks(
         task_id,task_type,title,request,requested_by,status,retried_from_task_id,created_at,started_at,completed_at,updated_at
       ) VALUES
         ('task-retry-root','code_update','Retried change','private request','operator','failed',NULL,now(),now() - interval '3 minutes',now() - interval '2 minutes',now() - interval '2 minutes'),
         ('task-retry-middle','code_update','Retried change','private request','operator','failed','task-retry-root',now(),now() - interval '2 minutes',now() - interval '1 minute',now() - interval '1 minute'),
         ('task-retry-leaf','code_update','Retried change','private request','operator','succeeded','task-retry-middle',now(),now() - interval '1 minute',now(),now())`,
    );
    await pool.query(
      `INSERT INTO agent_runtime_sessions(session_id,thread_key,title,request,requested_by,status,started_at,completed_at,updated_at)
       VALUES ('task-current-session','task-current','Current standalone failure','private task request','operator','failed',now(),now(),now())`,
    );
    await pool.query(
      `INSERT INTO agent_runtime_executions(execution_id,session_id,task_id,status,started_at,completed_at,updated_at)
       VALUES ('task-current-execution','task-current-session','task-current-orphan','failed',now(),now(),now())`,
    );
    await pool.query(
      `INSERT INTO agent_runtime_events(session_id,execution_id,sequence,kind,level,event_name,summary,metadata,duration_ms)
       VALUES (
         'task-current-session','task-current-execution',1,'command','error','agent.task.command',
         'Repository verification failed','{"status":"failed","argumentsPreview":"private task secret"}',900
       )`,
    );
    await pool.query(
      `INSERT INTO improvement_cases(case_id,scope,privacy,title,status,classification,severity,automation_state,automation_blocker)
       VALUES ('imp-dashboard','repository','private','Dashboard visibility','actionable','product_gap','high','blocked','waiting_for_proof')`,
    );
    await pool.query(
      `INSERT INTO improvement_signals(
         signal_id,case_id,source,source_key,reporter_kind,reporter_id,app_revision,summary,
         severity_hint,classification_hint,owning_domain_hint,metadata
       ) VALUES (
         'signal-dashboard','imp-dashboard','developer_report','developer:dashboard','developer','developer-a',
         'revision-previous','Dashboard visibility needs improvement','high','product_gap','console',
         '{"detectionCode":"dashboard-context"}'
       )`,
    );
    await pool.query(
      `INSERT INTO improvement_signals(
         signal_id,case_id,source,source_key,reporter_kind,reporter_id,guild_id,channel_id,message_id,
         execution_id,app_revision,summary,severity_hint,classification_hint,owning_domain_hint
       ) VALUES (
         'signal-dashboard-member','imp-dashboard','member_report','discord-reaction:guild-a:parent-a:member-a:bug',
         'member','member-a','guild-a','channel-a','parent-a',NULL,'revision-a',
         'A member reported a Discord assistant interaction','high','product_gap','agent-replies'
       )`,
    );
    await pool.query(
      `INSERT INTO improvement_evidence(
         evidence_id,case_id,signal_id,kind,disposition,summary,privacy
       ) VALUES (
         'evidence-dashboard','imp-dashboard','signal-dashboard','runtime_trace','supports',
         'The detail view begins with repair attempts and omits the originating context.','private'
       )`,
    );
    await pool.query(
      `INSERT INTO improvement_contracts(
         contract_id,case_id,version,expected_behavior,checks,executable,source_revision,created_by
       ) VALUES (
         'contract-dashboard','imp-dashboard',1,
         'Improvement detail presents the trigger, evidence, expectation, repair, and proof in one trace.',
         '[{"kind":"test","reference":"release-verify"}]',true,'revision-previous','developer-a'
       )`,
    );
    await pool.query(
      `INSERT INTO agent_tasks(
         task_id,task_type,title,request,requested_by,status,current_step,error,improvement_case_id,
         created_at,started_at,completed_at,updated_at
       ) VALUES (
         'task-improvement-repair','code_update','Repair dashboard visibility','private repair request','automation',
         'failed','failed','Job has reached specified backoff limit: private secret output','imp-dashboard',
         now() - interval '30 minutes',now() - interval '29 minutes',now() - interval '20 minutes',now() - interval '20 minutes'
       )`,
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
       ) VALUES ('conversation-dashboard','imp-dashboard','guild-a','channel-a','report-a','channel','channel-a','reply-message-a')`,
    );
    await pool.query(
      `INSERT INTO improvement_work_attempts(
         work_id,case_id,source,source_key,status,repository,pull_request_number,pull_request_url
       ) VALUES ('work-dashboard','imp-dashboard','github_pull_request','github:pr:1','in_progress','owner/repo',1,'https://github.com/owner/repo/pull/1')`,
    );
    await pool.query(
      `INSERT INTO improvement_work_attempts(
         work_id,case_id,source,source_key,status,task_id,started_at,completed_at,created_at,updated_at
       ) VALUES (
         'work-improvement-repair','imp-dashboard','agent_task','agent_task:task-improvement-repair','failed','task-improvement-repair',
         now() - interval '29 minutes',now() - interval '20 minutes',now() - interval '30 minutes',now() - interval '20 minutes'
       )`,
    );
    await pool.query(
      `INSERT INTO deployment_verifications(revision,deployment_id,verified_at) VALUES
         ('revision-previous','deployment-previous',now() - interval '1 day'),
         ('revision-a','deployment-a',now())`,
    );
    await pool.query(
      `INSERT INTO improvement_verification_receipts(
         receipt_id,case_id,contract_id,contract_version,revision,deployment_id,status,checks,
         application_key,applied,actor_id
       ) VALUES (
         'receipt-dashboard','imp-dashboard','contract-dashboard',1,'revision-a','deployment-a','passed',
         '[{"index":0,"status":"passed","summary":"The deployed Console passed its focused verification.","check":{"kind":"test","reference":"release-verify"}}]',
         'dashboard-receipt-application',true,'release-verifier'
       )`,
    );
    await pool.query(
      `INSERT INTO deployment_announcements(
         guild_id,revision,previous_revision,repository,channel_id,status,attempts,comparison_url,posted_at
       ) VALUES (
         'guild-a','revision-a','revision-previous','owner/repo','channel-a','posted',1,
         'https://github.com/owner/repo/compare/revision-previous...revision-a',now()
       )`,
    );
    await pool.query(
      `INSERT INTO improvement_proof_producer_runs(
         run_id,trigger,run_key,status,revision,deployment_id,started_at,completed_at
       ) VALUES (
         'release-run-a','release_promotion','release-a','succeeded','revision-a','deployment-a',
         now() - interval '4 seconds',now()
       )`,
    );
    await pool.query(
      `INSERT INTO agent_runtime_sessions(
         session_id,thread_key,trace_id,title,request,requested_by,status,harness,metadata,started_at,completed_at,updated_at
       ) VALUES
         ('embedding-session-a','embedding:a',NULL,'Embedding batch (3 messages)','Embed messages','system','succeeded','background_job','{"kind":"background_job","jobKind":"embedding"}',now() - interval '10 minutes',now() - interval '9 minutes',now() - interval '9 minutes'),
         ('embedding-session-b','embedding:b','mention-source','Embedding batch (5 messages)','Embed messages','system','succeeded','background_job','{"kind":"background_job","jobKind":"embedding"}',now() - interval '5 minutes',now() - interval '4 minutes',now() - interval '4 minutes'),
         ('improvement-repair-session','repair:dashboard',NULL,'Repair dashboard visibility','private repair request','automation','failed','sandbox','{}',now() - interval '29 minutes',now() - interval '20 minutes',now() - interval '20 minutes')`,
    );
    await pool.query(
      `INSERT INTO agent_runtime_executions(
         execution_id,session_id,status,metadata,started_at,completed_at,updated_at
       ) VALUES
         ('embedding-a','embedding-session-a','succeeded','{"jobKind":"embedding","messageCount":3,"jobCount":3}',now() - interval '10 minutes',now() - interval '9 minutes',now() - interval '9 minutes'),
         ('embedding-b','embedding-session-b','succeeded','{"jobKind":"embedding","messageCount":5,"jobCount":5}',now() - interval '5 minutes',now() - interval '4 minutes',now() - interval '4 minutes'),
         ('improvement-repair-execution','improvement-repair-session','failed','{}',now() - interval '29 minutes',now() - interval '20 minutes',now() - interval '20 minutes')`,
    );
    await pool.query(
      `UPDATE agent_runtime_executions SET task_id = 'task-improvement-repair'
       WHERE execution_id = 'improvement-repair-execution'`,
    );
    await pool.query(
      `INSERT INTO agent_runtime_events(session_id,execution_id,sequence,kind,level,event_name,summary,duration_ms) VALUES
         ('embedding-session-a','embedding-a',1,'status','info','background.job.completed','Embedded batch',60000),
         ('embedding-session-b','embedding-b',1,'status','info','background.job.completed','Embedded batch',60000),
         ('improvement-repair-session','improvement-repair-execution',1,'status','info','agent.task.started','private branch path',NULL),
         ('improvement-repair-session','improvement-repair-execution',2,'command','info','agent.task.command','private command',1200),
         ('improvement-repair-session','improvement-repair-execution',3,'command','error','agent.task.command','private failing command',800),
         ('improvement-repair-session','improvement-repair-execution',4,'status','error','agent.task.completed','private secret output',NULL)`,
    );
    await pool.query(
      `INSERT INTO agent_runtime_artifacts(
         artifact_id,session_id,execution_id,kind,name,size_bytes,preview,redacted
       ) VALUES (
         'improvement-repair-artifact','improvement-repair-session','improvement-repair-execution',
         'command_output','private-command.log',2048,'private secret output',true
       )`,
    );

    const repository = new OperatorDashboardRepository(pool);
    const snapshot = await repository.snapshot({ revision: "revision-a" });

    expect(snapshot.summary).toMatchObject({ serviceTelemetryAvailable: true, activeRuns: 1, activeTasks: 1, openImprovements: 1, needsAttention: 1 });
    expect(snapshot.services.find((service) => service.component === "worker")).toMatchObject({ status: "healthy", instances: 1, revision: "revision-a" });
    expect(snapshot.executions[0]).toMatchObject({ title: "Answer a member", requestPreview: "Private prompt content", latestEvent: "agent.execution.context_ready" });
    expect(snapshot.tasks[0]).toMatchObject({ taskId: "task-dashboard", currentStep: "queued" });
    expect(snapshot.improvements.cases[0]).toMatchObject({ caseId: "imp-dashboard", automationState: "blocked", pullRequestUrl: "https://github.com/owner/repo/pull/1" });
    expect(snapshot.improvements.cases[0]).toMatchObject({ title: "Reported reply: Earlier assistant reply" });
    expect(snapshot.deployments[0]).toMatchObject({ revision: "revision-a", deploymentId: "deployment-a" });
    expect(snapshot.producers).toHaveLength(6);
    expect(snapshot.messages).not.toContainEqual(expect.objectContaining({ id: "source-b" }));
    expect(snapshot.messages).toContainEqual(expect.objectContaining({
      id: "mention-source", preview: "@AI @AI role balances", authorLabel: "Member A", embedded: true,
    }));
    expect(snapshot.activity.map((story) => story.kind)).toEqual(expect.arrayContaining(["runtime", "improvement"]));
    expect(snapshot.activity.filter((story) => story.kind === "runtime")).toHaveLength(2);
    expect(snapshot.activity).toContainEqual(expect.objectContaining({
      id: "task-task-current-orphan", kind: "code_change", status: "failed",
    }));
    expect(snapshot.activity).toContainEqual(expect.objectContaining({
      id: "task-task-retry-leaf", kind: "code_change", status: "succeeded", attempts: 3,
    }));
    expect(snapshot.activity).not.toContainEqual(expect.objectContaining({ id: "task-task-retry-root" }));
    expect(snapshot.activity).not.toContainEqual(expect.objectContaining({ id: "task-task-retry-middle" }));
    expect(snapshot.activity).not.toContainEqual(expect.objectContaining({ id: "task-task-legacy-orphan" }));
    expect(JSON.stringify({ executions: snapshot.executions, tasks: snapshot.tasks, activity: snapshot.activity })).not.toContain("canary");
    expect(snapshot.activity.find((story) => story.id === "runtime-agent-execution-attempt-2")).toMatchObject({
      title: "@AI role Current member prompt",
      authorLabel: "Member A",
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
      title: "Reported reply: Earlier assistant reply",
      eventCount: 2,
      sourceUrl: "https://discord.com/channels/guild-a/channel-a/report-a",
      responseUrl: "https://discord.com/channels/guild-a/channel-a/reply-message-a",
      responseKind: "channel",
      events: [
        expect.objectContaining({ name: "triage.applied" }),
      ],
    });
    expect(JSON.stringify(snapshot.activity)).not.toContain("Executing prompt");
    expect(JSON.stringify(snapshot)).not.toContain('"requestedBy"');

    await expect(repository.overview({ revision: "revision-a" })).resolves.toMatchObject({
      revision: "revision-a",
      summary: { serviceTelemetryAvailable: true, activeRuns: 1, activeTasks: 1 },
      services: expect.arrayContaining([expect.objectContaining({ component: "worker", status: "healthy" })]),
    });
    const issuePage = await repository.activityPage({
      revision: "revision-a",
      filter: "issues",
      types: ["conversation", "improvement", "code_change"],
      limit: 1,
    });
    expect(issuePage).toMatchObject({
      total: expect.any(Number),
      counts: expect.objectContaining({ all: expect.any(Number), issues: expect.any(Number) }),
      recent: expect.any(Array),
    });
    expect(issuePage.recent).toHaveLength(1);
    expect(issuePage.recent[0]).toMatchObject({ tone: expect.stringMatching(/danger|warning/) });

    const conversation = await repository.activityDetail({
      kind: "conversation",
      id: "runtime-agent-execution-attempt-2",
      revision: "revision-a",
    });
    expect(conversation).toMatchObject({
      executionId: "agent-execution-attempt-2",
      messages: [
        { id: "attachment-only", role: "member", content: "", unavailable: false, attachments: [{ filename: "file.png", contentType: "image/png", sizeBytes: 2048 }] },
        { id: "deleted-bot", role: "assistant", content: "Retained deleted reply", deleted: true, retained: true },
        { id: "parent-a", role: "assistant", content: "**Earlier assistant reply** -# 5.9s", directParent: true, current: false },
        { id: "source-b", role: "member", content: "<@&456> Current member prompt", current: true, roles: { "456": "AI role" } },
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

    const codeChange = await new OperatorDashboardRepository(pool).activityDetail({
      kind: "code_change", id: "task-task-current-orphan", revision: "revision-a",
    });
    expect(codeChange).toMatchObject({
      traceEvents: [expect.objectContaining({
        type: "task", code: "agent.task.command",
        summary: "Sandbox command recorded; command and output remain private.",
        durationMs: 900, metadata: { status: "failed", attempt: 1 },
      })],
    });
    expect(JSON.stringify(codeChange)).not.toContain("private task secret");

    const release = await new OperatorDashboardRepository(pool).activityDetail({
      kind: "release", id: "release-deployment-a", revision: "revision-a",
    });
    expect(release).toMatchObject({
      release: {
        revision: "revision-a", deploymentId: "deployment-a",
        previous: { revision: "revision-previous", deploymentId: "deployment-previous" },
        comparisonUrl: "https://github.com/owner/repo/compare/revision-previous...revision-a",
        announcements: { total: 1, posted: 1, failed: 0, attempts: 1 },
        checks: [expect.objectContaining({ name: "release_promotion", status: "succeeded", durationMs: 4000 })],
        verifications: [expect.objectContaining({
          id: "receipt-dashboard", status: "passed",
          summary: "The deployed Console passed its focused verification.",
        })],
      },
    });

    const mentionedMessage = await new OperatorDashboardRepository(pool).activityDetail({
      kind: "message", id: "message-mention-source", revision: "revision-a",
    });
    expect(mentionedMessage).toMatchObject({
      message: {
        content: "<@123> <@&456> balances",
        mentions: { "123": "AI" },
        roles: { "456": "AI role" },
      },
    });
    const projectedActivity = deriveOperatorActivity(snapshot);
    expect(projectedActivity.recent).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "runtime-agent-execution-attempt-2", authorLabel: "Member A" }),
      expect.objectContaining({ id: "message-mention-source", authorLabel: "Member A" }),
    ]));
    expect(projectedActivity.recent).not.toContainEqual(expect.objectContaining({ id: "message-source-b" }));
    expect(projectedActivity.active.concat(projectedActivity.recent)).not.toContainEqual(
      expect.objectContaining({ rollupKey: "embedding" }),
    );

    const improvement = await new OperatorDashboardRepository(pool).activityDetail({
      kind: "improvement",
      id: "improvement-imp-dashboard",
      revision: "revision-a",
    });
    expect(improvement).toMatchObject({
      traceEvents: expect.arrayContaining([
        expect.objectContaining({ title: "Triage completed", code: "triage.applied" }),
        expect.objectContaining({ title: "Repair attempt 1 started", type: "task" }),
        expect.objectContaining({
          title: "Sandbox command", type: "command", code: "attempt.1.agent.task.command", recordCount: 2,
          summary: "2 records in repair attempt 1; at least one command failed.",
        }),
        expect.objectContaining({ title: "1 retained evidence item", type: "artifact" }),
        expect.objectContaining({
          title: "Repair attempt 1 failed",
          summary: "The repair retries reached their limit.",
          durationMs: 540000,
        }),
      ]),
      improvement: {
        case: expect.objectContaining({ classification: "product_gap", severity: "high", owningDomain: null }),
        signals: expect.arrayContaining([expect.objectContaining({
          source: "developer_report", detectionCode: "dashboard-context", appRevision: "revision-previous",
        })]),
        evidence: [expect.objectContaining({
          kind: "runtime_trace", disposition: "supports",
          summary: "The detail view begins with repair attempts and omits the originating context.",
        })],
        contract: expect.objectContaining({
          expectedBehavior: "Improvement detail presents the trigger, evidence, expectation, repair, and proof in one trace.",
          checks: [{ kind: "test", reference: "release-verify" }],
        }),
        work: expect.objectContaining({ pullRequestNumber: 1, pullRequestUrl: "https://github.com/owner/repo/pull/1" }),
        verification: expect.objectContaining({
          status: "passed", revision: "revision-a", deploymentId: "deployment-a",
          checks: [expect.objectContaining({ status: "passed", kind: "test" })],
        }),
      },
    });
    expect(JSON.stringify(improvement)).not.toContain("private secret");
    expect(JSON.stringify(improvement)).not.toContain("private command");
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
              'completed','completed',now()
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
