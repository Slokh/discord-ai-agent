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

  it("projects liveness, active work, messages, and release activity", async () => {
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
         ('agent-session-canary-complete','canary-complete-thread','Completed post-deploy canary','Synthetic completed prompt','canary','succeeded','{"qualityCohort":"synthetic"}',now() - interval '2 minutes',now(),now()),
         ('agent-session-legacy-cli-active','legacy-cli-active-thread','Legacy active CLI probe','Private CLI prompt','operator','running','{"source":"cli.prompt"}',now() - interval '10 seconds',NULL,now()),
         ('agent-session-legacy-cli-complete','legacy-cli-complete-thread','Legacy completed CLI probe','Private CLI prompt','operator','failed','{"source":"cli.prompt"}',now() - interval '2 minutes',now(),now())`,
    );
    await pool.query(
      `INSERT INTO agent_runtime_executions(execution_id,session_id,status,model,started_at,completed_at,updated_at)
       VALUES
         ('agent-execution-canary-active','agent-session-canary-active','running','model-a',now() - interval '10 seconds',NULL,now()),
         ('agent-execution-canary-complete','agent-session-canary-complete','succeeded','model-a',now() - interval '2 minutes',now(),now()),
         ('agent-execution-legacy-cli-active','agent-session-legacy-cli-active','running','model-a',now() - interval '10 seconds',NULL,now()),
         ('agent-execution-legacy-cli-complete','agent-session-legacy-cli-complete','failed','model-a',now() - interval '2 minutes',now(),now())`,
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
      `INSERT INTO agent_runtime_events(
         session_id,execution_id,sequence,kind,level,event_name,summary,metadata,duration_ms
       ) VALUES
         ('agent-session-complete','agent-execution-attempt-2',3,'status','info','agent.tool.started',
          'readData','{"toolName":"readData","callId":"call-dashboard","argumentsPreview":"{\\"query\\":\\"latest\\"}"}',NULL),
         ('agent-session-complete','agent-execution-attempt-2',4,'status','info','agent.tool.complete',
          'readData: 80 chars','{"toolName":"readData","callId":"call-dashboard","status":"ok","outputChars":80,"fileCount":1}',700)`,
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
         ('runtime-assistant-b','agent-session-complete','reply-b','assistant','[{"type":"text","text":"Final assistant reply"}]','{"executionId":"agent-execution-attempt-2","discordUrl":"https://discord.com/channels/guild-a/channel-a/reply-b"}',now()),
         ('runtime-tool-b','agent-session-complete','tool-call-dashboard','tool',
          '[{"type":"tool_result","toolCallId":"call-dashboard","toolName":"readData","content":"{\\"rows\\":[{\\"id\\":1}],\\"apiKey\\":\\"secret-value\\",\\"url\\":\\"https://example.test/data?signature=secret-signature\\"}","files":[{"name":"data.json","contentType":"application/json","bytes":80}],"tables":[{"name":"Rows","rows":1,"columns":["id"]}]}]',
          '{"executionId":"agent-execution-attempt-2","toolCallId":"call-dashboard","toolName":"readData","responseRedacted":false}',now())`,
    );
    await pool.query(
      `INSERT INTO deployment_verifications(revision,deployment_id,verified_at) VALUES
         ('revision-previous','deployment-previous',now() - interval '1 day'),
         ('revision-a','deployment-a',now())`,
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
      `INSERT INTO agent_runtime_sessions(
         session_id,thread_key,trace_id,title,request,requested_by,status,harness,metadata,started_at,completed_at,updated_at
       ) VALUES
         ('embedding-session-a','embedding:a',NULL,'Embedding batch (3 messages)','Embed messages','system','succeeded','background_job','{"kind":"background_job","jobKind":"embedding"}',now() - interval '10 minutes',now() - interval '9 minutes',now() - interval '9 minutes'),
         ('embedding-session-b','embedding:b','mention-source','Embedding batch (5 messages)','Embed messages','system','succeeded','background_job','{"kind":"background_job","jobKind":"embedding"}',now() - interval '5 minutes',now() - interval '4 minutes',now() - interval '4 minutes')`,
    );
    await pool.query(
      `INSERT INTO agent_runtime_executions(
         execution_id,session_id,status,metadata,started_at,completed_at,updated_at
       ) VALUES
         ('embedding-a','embedding-session-a','succeeded','{"jobKind":"embedding","messageCount":3,"jobCount":3}',now() - interval '10 minutes',now() - interval '9 minutes',now() - interval '9 minutes'),
         ('embedding-b','embedding-session-b','succeeded','{"jobKind":"embedding","messageCount":5,"jobCount":5}',now() - interval '5 minutes',now() - interval '4 minutes',now() - interval '4 minutes')`,
    );
    await pool.query(
      `INSERT INTO agent_runtime_events(session_id,execution_id,sequence,kind,level,event_name,summary,duration_ms) VALUES
         ('embedding-session-a','embedding-a',1,'status','info','background.job.completed','Embedded batch',60000),
         ('embedding-session-b','embedding-b',1,'status','info','background.job.completed','Embedded batch',60000)`,
    );

    const repository = new OperatorDashboardRepository(pool);
    const snapshot = await repository.snapshot({ revision: "revision-a" });

    expect(snapshot.summary).toMatchObject({ serviceTelemetryAvailable: true, activeRuns: 1 });
    expect(snapshot.summary).not.toHaveProperty("activeTasks");
    expect(snapshot.summary).not.toHaveProperty("openImprovements");
    expect(snapshot.services.map((service) => service.component)).toEqual(["bot", "worker", "console"]);
    expect(snapshot.services.find((service) => service.component === "worker")).toMatchObject({ status: "healthy", instances: 1, revision: "revision-a" });
    expect(snapshot.executions[0]).toMatchObject({ title: "Answer a member", requestPreview: "Private prompt content", latestEvent: "agent.execution.context_ready" });
    expect(snapshot.deployments[0]).toMatchObject({ revision: "revision-a", deploymentId: "deployment-a" });
    expect(snapshot).not.toHaveProperty("producers");
    expect(snapshot).not.toHaveProperty("tasks");
    expect(snapshot).not.toHaveProperty("improvements");
    expect(snapshot.messages).not.toContainEqual(expect.objectContaining({ id: "source-b" }));
    expect(snapshot.messages).toContainEqual(expect.objectContaining({
      id: "mention-source", preview: "@AI @AI role balances", authorLabel: "Member A", embedded: true,
    }));
    expect([...new Set(snapshot.activity.map((story) => story.kind))].sort()).toEqual(["runtime", "system"]);
    expect(snapshot.activity.filter((story) => story.kind === "runtime")).toHaveLength(2);
    expect(JSON.stringify({ executions: snapshot.executions, activity: snapshot.activity })).not.toContain("canary");
    expect(JSON.stringify({ executions: snapshot.executions, activity: snapshot.activity })).not.toContain("legacy-cli");
    expect(snapshot.activity.find((story) => story.id === "runtime-agent-execution-attempt-2")).toMatchObject({
      title: "@AI role Current member prompt",
      authorLabel: "Member A",
      attempts: 2,
      eventCount: 4,
      deliveryState: "delivered",
      hasParent: true,
      sourceUrl: "https://discord.com/channels/guild-a/channel-a/source-b",
      responseUrl: "https://discord.com/channels/guild-a/channel-a/reply-b",
      responseKind: "reply",
      events: [
        expect.objectContaining({ name: "agent.tool.complete" }),
      ],
    });
    expect(JSON.stringify(snapshot.activity)).not.toContain("Executing prompt");
    expect(JSON.stringify(snapshot)).not.toContain('"requestedBy"');

    await expect(repository.overview({ revision: "revision-a" })).resolves.toMatchObject({
      revision: "revision-a",
      summary: { serviceTelemetryAvailable: true, activeRuns: 1 },
      services: expect.arrayContaining([expect.objectContaining({ component: "worker", status: "healthy" })]),
    });
    const issuePage = await repository.activityPage({
      revision: "revision-a",
      filter: "issues",
      types: ["conversation"],
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
      conversationTrace: expect.objectContaining({
        model: "model-a",
        totalTokens: 1234,
        estimatedCostUsd: 0.0123,
        contextCount: 3,
        phases: expect.arrayContaining([
          expect.objectContaining({ id: "context", summary: "**Earlier assistant reply** -# 5.9s" }),
          expect.objectContaining({ id: "prompt", summary: "<@&456> Current member prompt" }),
          expect.objectContaining({
            id: "agent",
            metadata: expect.objectContaining({ model: "model-a", totalTokens: 1234 }),
            tools: [expect.objectContaining({
              callId: "call-dashboard",
              title: "readData",
              arguments: { query: "latest" },
              resultAvailable: true,
              outputChars: 80,
              fileCount: 1,
            })],
          }),
          expect.objectContaining({ id: "response", summary: "Final assistant reply" }),
        ]),
      }),
    });
    expect(JSON.stringify(conversation)).not.toContain("private secret");
    expect(JSON.stringify(conversation)).not.toContain("secret-value");

    const toolResult = await repository.activityToolResult({
      kind: "conversation",
      id: "runtime-agent-execution-attempt-2",
      callId: "call-dashboard",
      revision: "revision-a",
    });
    expect(toolResult).toMatchObject({
      callId: "call-dashboard",
      toolName: "readData",
      format: "json",
      content: {
        rows: [{ id: 1 }],
        apiKey: "[REDACTED]",
        url: "https://example.test/data?signature=[REDACTED]",
      },
      truncated: false,
      responseRedacted: false,
      files: [{ name: "data.json", contentType: "application/json", bytes: 80 }],
      tables: [{ name: "Rows", rows: 1, columns: ["id"] }],
    });
    await expect(repository.activityToolResult({
      kind: "conversation", id: "runtime-agent-execution-attempt-2", callId: "missing", revision: "revision-a",
    })).resolves.toBeNull();

    const release = await new OperatorDashboardRepository(pool).activityDetail({
      kind: "release", id: "release-deployment-a", revision: "revision-a",
    });
    expect(release).toMatchObject({
      release: {
        revision: "revision-a", deploymentId: "deployment-a",
        previous: { revision: "revision-previous", deploymentId: "deployment-previous" },
        comparisonUrl: "https://github.com/owner/repo/compare/revision-previous...revision-a",
        announcements: { total: 1, posted: 1, failed: 0, attempts: 1 },
      },
    });
    expect(release).not.toHaveProperty("release.checks");
    expect(release).not.toHaveProperty("release.verifications");

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
  });

  it("keeps the production projection available before heartbeat storage is deployed", async () => {
    await pool.query(`DROP TABLE service_runtime_heartbeats`);

    const snapshot = await new OperatorDashboardRepository(pool).snapshot({ revision: "revision-a" });

    expect(snapshot.services).toHaveLength(3);
    expect(snapshot.services.map((service) => service.status)).toEqual([
      "unavailable", "unavailable", "unavailable",
    ]);
    expect(snapshot.summary).toMatchObject({ serviceCount: 3, serviceTelemetryAvailable: false });
  });

  it("projects every eligible source before system rollups", async () => {
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

    const snapshot = await new OperatorDashboardRepository(pool).snapshot({ revision: "revision-a" });
    const activity = deriveOperatorActivity(snapshot);

    expect(snapshot.activity.filter((story) => story.id.startsWith("runtime-bulk-prompt-execution-"))).toHaveLength(30);
    expect(snapshot.activity.filter((story) => story.id.startsWith("runtime-bulk-system-execution-"))).toHaveLength(14);
    expect(activity.recent.filter((story) => story.id.startsWith("runtime-bulk-prompt-execution-"))).toHaveLength(30);
    expect(activity.recent).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "runtime-bulk-system-execution-14", tone: "danger" }),
      expect.objectContaining({ id: "system-rollup-bulk_system", runCount: 13 }),
    ]));
  });
});
