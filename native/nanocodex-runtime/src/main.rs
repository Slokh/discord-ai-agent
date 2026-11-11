//! Long-lived nanocode host for the Discord agent.
//!
//! One process serves every agent session. The Node worker starts it once,
//! sends the stable tool catalog (`configure`), then streams turns. Sessions
//! are durable in Postgres (`DATABASE_URL`, schema `nanocode`): a turn's
//! request ID is the Discord message ID, so a retried job recovers the turn or
//! returns its recorded result instead of running it twice.

mod bridge;
mod protocol;
mod store;

use std::{
    collections::HashMap,
    sync::{Arc, Mutex as StdMutex},
    time::{Duration, Instant},
};

use nanocode::{
    Agent, AgentEvents, Codex, Model, Nanocode, OpenAi, PromptRequest, Thinking, Tools,
    TurnControl,
    agent::input::{Prompt, UserInput},
    codex::{auth::OpenAiAuth, transport::ResponsesGateway},
    durability::{MemoryStore, SessionStore, SqlStore},
    oai::transport::ResponsesTransport,
};
use serde_json::Value;
use thiserror::Error;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{Mutex, mpsc},
};

use crate::{
    bridge::{Bridge, ProtocolTool},
    protocol::{
        CancelRequest, Configure, Inbound, Outbound, PROTOCOL_VERSION, PromptPayload, SteerRequest,
        ToolResultMessage, TurnRequest, encode,
    },
    store::PostgresHost,
};

/// Live sessions idle longer than this are closed; their state stays in the
/// store and the next turn reopens them.
const IDLE_SESSION: Duration = Duration::from_secs(15 * 60);
const STORE_CONNECTIONS: usize = 4;

#[derive(Debug, Error)]
enum HostError {
    #[error("invalid model: {0}")]
    Model(String),
    #[error("invalid thinking level: {0}")]
    Thinking(String),
    #[error("OPENROUTER_API_KEY is required")]
    MissingApiKey,
    #[error("the host is not configured yet")]
    NotConfigured,
    #[error("the host is already configured")]
    AlreadyConfigured,
    #[error("nanocode: {0}")]
    Nanocode(String),
    #[error("store: {0}")]
    Store(String),
    #[error("protocol JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

fn nanocode_error(error: impl std::fmt::Display) -> HostError {
    HostError::Nanocode(error.to_string())
}

struct LiveSession {
    agent: Agent,
    events: AgentEvents,
}

#[derive(Default)]
struct SessionSlot {
    live: Mutex<Option<LiveSession>>,
    last_used: StdMutex<Option<Instant>>,
}

struct Host {
    runtime: Nanocode,
    store: Option<SessionStore>,
    bridge: Arc<Bridge>,
    outbound: mpsc::UnboundedSender<Value>,
    sessions: StdMutex<HashMap<String, Arc<SessionSlot>>>,
    turns: StdMutex<HashMap<String, TurnControl>>,
}

#[tokio::main]
async fn main() {
    let (outbound, receiver) = mpsc::unbounded_channel();
    let writer = tokio::spawn(write_outbound(receiver));
    let result = serve(outbound.clone()).await;
    if let Err(error) = &result {
        let _ = outbound.send(
            encode(&Outbound::Failed {
                protocol_version: PROTOCOL_VERSION,
                request_id: None,
                error: &error.to_string(),
            })
            .unwrap_or(Value::Null),
        );
    }
    drop(outbound);
    let _ = writer.await;
    if result.is_err() {
        std::process::exit(1);
    }
}

async fn serve(outbound: mpsc::UnboundedSender<Value>) -> Result<(), HostError> {
    send(
        &outbound,
        &Outbound::Ready {
            protocol_version: PROTOCOL_VERSION,
        },
    )?;
    let bridge = Arc::new(Bridge::default());
    let mut host: Option<Arc<Host>> = None;
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let message = match serde_json::from_str::<Inbound>(&line) {
            Ok(message) => message,
            Err(error) => {
                eprintln!("nanocode host: invalid inbound message: {error}");
                // A tool result the host cannot read must still end its call;
                // otherwise the turn waits until Code Mode gives up on it.
                if let Some(result) = unreadable_tool_result(&line, &error) {
                    bridge.resolve(result);
                }
                send(
                    &outbound,
                    &Outbound::Failed {
                        protocol_version: PROTOCOL_VERSION,
                        request_id: None,
                        error: &format!("invalid inbound message: {error}"),
                    },
                )?;
                continue;
            }
        };
        match message {
            Inbound::Configure(configure) => {
                if host.is_some() {
                    return Err(HostError::AlreadyConfigured);
                }
                let built = Arc::new(configure_host(*configure, &bridge, &outbound).await?);
                send(
                    &outbound,
                    &Outbound::Configured {
                        protocol_version: PROTOCOL_VERSION,
                        durable: built.store.is_some(),
                    },
                )?;
                tokio::spawn(sweep_idle_sessions(Arc::downgrade(&built)));
                host = Some(built);
            }
            Inbound::ToolResult(result) => {
                bridge.resolve(*result);
            }
            Inbound::Turn(turn) => match &host {
                Some(host) => {
                    let host = Arc::clone(host);
                    tokio::spawn(async move { host.run_turn(*turn).await });
                }
                None => fail_request(&outbound, &turn.request_id, &HostError::NotConfigured)?,
            },
            Inbound::Steer(steer) => match &host {
                Some(host) => {
                    let host = Arc::clone(host);
                    tokio::spawn(async move { host.steer(steer).await });
                }
                None => fail_request(&outbound, &steer.request_id, &HostError::NotConfigured)?,
            },
            Inbound::Cancel(CancelRequest { request_id }) => {
                if let Some(host) = &host {
                    let control = host
                        .turns
                        .lock()
                        .expect("turns lock")
                        .get(&request_id)
                        .cloned();
                    if let Some(control) = control {
                        let _ = control.cancel().await;
                    }
                }
            }
        }
    }
    // The worker closed stdin: finish cleanly.
    if let Some(host) = host {
        host.shutdown().await;
    }
    Ok(())
}

async fn configure_host(
    configure: Configure,
    bridge: &Arc<Bridge>,
    outbound: &mpsc::UnboundedSender<Value>,
) -> Result<Host, HostError> {
    let api_key = std::env::var("OPENROUTER_API_KEY")
        .ok()
        .filter(|key| !key.trim().is_empty())
        .ok_or(HostError::MissingApiKey)?;
    let mut gateway = ResponsesGateway::openrouter();
    if let Some(title) = configure.app_title {
        gateway = gateway.app_title(title);
    }
    if let Some(url) = configure.app_url {
        gateway = gateway.app_url(url);
    }
    if let Some(base) = configure.api_base_url {
        gateway = gateway.base_url(base);
    }
    let openai = OpenAi::builder(OpenAiAuth::api_key(api_key))
        .responses_gateway(gateway)
        .transport(ResponsesTransport::Https)
        .model(Model::Luna)
        .build()
        .map_err(nanocode_error)?;

    // Application tools are the only tools. Every one crosses the bridge, so
    // the worker keeps authority, auditing and delivery.
    let mut tools = Tools::builder()
        .without_defaults()
        .web_search(false)
        .workspace(false);
    for definition in configure.tools {
        tools = tools.tool(ProtocolTool {
            definition,
            bridge: Arc::clone(bridge),
            outbound: outbound.clone(),
        });
    }
    let tools = tools.build().map_err(nanocode_error)?;

    // Chat keeps working if Postgres is unreachable at startup, but without
    // durable sessions; `configured.durable` tells the worker which it got.
    let store = match durable_store().await {
        Ok(store) => store,
        Err(error) => {
            eprintln!("nanocode host: durable store unavailable, sessions stay in memory: {error}");
            None
        }
    };
    let builder = Nanocode::builder()
        .openai(openai)
        .tools(tools)
        .without_subagents()
        .without_cua()
        .runner_management(false);
    let runtime = match &store {
        Some(store) => builder.durability(store.clone()),
        None => builder.durability(MemoryStore::new().map_err(nanocode_error)?),
    }
    .build_async()
    .await
    .map_err(nanocode_error)?;
    Ok(Host {
        runtime,
        store,
        bridge: Arc::clone(bridge),
        outbound: outbound.clone(),
        sessions: StdMutex::new(HashMap::new()),
        turns: StdMutex::new(HashMap::new()),
    })
}

/// Postgres when `DATABASE_URL` is set; `NANOCODE_STORE=memory` keeps sessions
/// in this process only (tests and local experiments).
async fn durable_store() -> Result<Option<SessionStore>, HostError> {
    if std::env::var("NANOCODE_STORE").is_ok_and(|mode| mode == "memory") {
        return Ok(None);
    }
    let Some(url) = std::env::var("DATABASE_URL")
        .ok()
        .filter(|url| !url.is_empty())
    else {
        return Ok(None);
    };
    let host = PostgresHost::connect(&url, STORE_CONNECTIONS)
        .await
        .map_err(|error| HostError::Store(error.to_string()))?;
    // Creates or upgrades nanocode's tables before the first session opens.
    let mut store = SqlStore::new(host);
    store
        .migrate()
        .await
        .map_err(|error| HostError::Store(error.to_string()))?;
    nanocode::session_store(store)
        .map(Some)
        .map_err(|error| HostError::Store(error.to_string()))
}

impl Host {
    async fn run_turn(self: Arc<Self>, request: TurnRequest) {
        let request_id = request.request_id.clone();
        let session_id = request.session_id.clone();
        let outcome = self.drive_turn(request).await;
        self.bridge.end(&session_id);
        self.turns.lock().expect("turns lock").remove(&request_id);
        match outcome {
            Ok((final_message, usage, resumed)) => {
                let _ = send(
                    &self.outbound,
                    &Outbound::Completed {
                        protocol_version: PROTOCOL_VERSION,
                        request_id: &request_id,
                        session_id: &session_id,
                        final_message: &final_message,
                        usage,
                        resumed,
                    },
                );
            }
            Err(error) => {
                // A failed turn may leave the live agent in an unknown state;
                // the next turn reopens it from the store.
                self.forget(&session_id).await;
                let _ = fail_request(&self.outbound, &request_id, &error);
            }
        }
    }

    async fn drive_turn(&self, request: TurnRequest) -> Result<(String, Value, bool), HostError> {
        let model = request
            .model
            .trim()
            .trim_start_matches("openai/")
            .parse::<Model>()
            .map_err(|error| HostError::Model(error.to_string()))?;
        let thinking = request
            .thinking
            .parse::<Thinking>()
            .map_err(|error| HostError::Thinking(error.to_string()))?;
        let slot = self.slot(&request.session_id);
        let mut live = slot.live.lock().await;
        let resumed = match live.as_ref() {
            Some(_) => true,
            None => {
                let (session, existed) = self
                    .open_or_create(&request.session_id, model, thinking, &request.instructions)
                    .await?;
                *live = Some(session);
                existed
            }
        };
        let mut payload = request.prompt;
        if !resumed
            && let Some(bootstrap) = request.bootstrap.filter(|text| !text.trim().is_empty())
        {
            payload.text = format!("{bootstrap}\n\n{}", payload.text);
        }
        let LiveSession { agent, events } = live.as_mut().expect("session is live");
        while events.try_recv().is_some() {}
        agent.set_thinking(thinking).await.map_err(nanocode_error)?;

        self.bridge.begin(&request.session_id, &request.request_id);
        let turn = agent
            .prompt(PromptRequest::new(prompt(payload)).request_id(&request.request_id))
            .await
            .map_err(nanocode_error)?;
        self.turns
            .lock()
            .expect("turns lock")
            .insert(request.request_id.clone(), turn.control());
        let mut result = std::pin::pin!(turn.result());
        let result = loop {
            tokio::select! {
                biased;
                Some(event) = events.recv() => self.forward(&request.request_id, &event),
                result = &mut result => break result,
            }
        };
        while let Some(event) = events.try_recv() {
            self.forward(&request.request_id, &event);
        }
        let result = result.map_err(nanocode_error)?;
        *slot.last_used.lock().expect("slot lock") = Some(Instant::now());
        let usage = match result.usage() {
            Some(usage) => serde_json::to_value(usage)?,
            None => Value::Object(serde_json::Map::new()),
        };
        Ok((result.final_message().to_owned(), usage, resumed))
    }

    async fn open_or_create(
        &self,
        session_id: &str,
        model: Model,
        thinking: Thinking,
        instructions: &str,
    ) -> Result<(LiveSession, bool), HostError> {
        if let Some(store) = &self.store {
            match store.load(session_id).await {
                Ok(_) => {
                    let (agent, events) = self
                        .runtime
                        .open_session(session_id)
                        .await
                        .map_err(nanocode_error)?;
                    return Ok((LiveSession { agent, events }, true));
                }
                Err(nanocode::durability::Error::SessionNotFound { .. }) => {}
                Err(error) => return Err(HostError::Store(error.to_string())),
            }
        }
        let (agent, events) = self
            .runtime
            .spawn()
            .backend::<Codex>()
            .model(model)
            .thinking(thinking)
            .session_id(session_id)
            .instructions(instructions.to_owned())
            .build()
            .await
            .map_err(nanocode_error)?;
        Ok((LiveSession { agent, events }, false))
    }

    async fn steer(&self, request: SteerRequest) {
        let control = self
            .turns
            .lock()
            .expect("turns lock")
            .get(&request.request_id)
            .cloned();
        let outcome = match control {
            Some(control) => control
                .steer_with_id(request.steer_id.clone(), prompt(request.prompt))
                .await
                .map_err(|error| error.to_string()),
            None => Err("the turn is no longer running".to_owned()),
        };
        let _ = send(
            &self.outbound,
            &Outbound::Steered {
                protocol_version: PROTOCOL_VERSION,
                request_id: &request.request_id,
                steer_id: &request.steer_id,
                accepted: outcome.is_ok(),
                error: outcome.as_ref().err().map(String::as_str),
            },
        );
    }

    fn forward(&self, request_id: &str, event: &nanocode::agent::events::AgentEvent) {
        let Ok(event) = serde_json::to_value(event) else {
            return;
        };
        // Token deltas are only useful to a live UI; the ledger records whole
        // messages and lifecycle events.
        if matches!(
            event.get("type").and_then(Value::as_str),
            Some("assistant.delta" | "reasoning.summary.delta" | "api.event")
        ) {
            return;
        }
        let _ = send(
            &self.outbound,
            &Outbound::Event {
                protocol_version: PROTOCOL_VERSION,
                request_id,
                event,
            },
        );
    }

    fn slot(&self, session_id: &str) -> Arc<SessionSlot> {
        Arc::clone(
            self.sessions
                .lock()
                .expect("sessions lock")
                .entry(session_id.to_owned())
                .or_default(),
        )
    }

    async fn forget(&self, session_id: &str) {
        let slot = self
            .sessions
            .lock()
            .expect("sessions lock")
            .remove(session_id);
        if let Some(slot) = slot
            && let Some(session) = slot.live.lock().await.take()
        {
            let _ = session.agent.shutdown().await;
        }
    }

    async fn shutdown(&self) {
        let slots: Vec<_> = self
            .sessions
            .lock()
            .expect("sessions lock")
            .drain()
            .collect();
        for (_, slot) in slots {
            if let Some(session) = slot.live.lock().await.take() {
                let _ = session.agent.flush().await;
                let _ = session.agent.shutdown().await;
            }
        }
        let _ = self.runtime.shutdown().await;
    }
}

/// Closes live sessions that have been idle for a while. Only durable
/// sessions are evicted; in-memory sessions would lose their history.
async fn sweep_idle_sessions(host: std::sync::Weak<Host>) {
    let mut ticks = tokio::time::interval(Duration::from_secs(60));
    loop {
        ticks.tick().await;
        let Some(host) = host.upgrade() else { return };
        if host.store.is_none() {
            continue;
        }
        let idle: Vec<(String, Arc<SessionSlot>)> = host
            .sessions
            .lock()
            .expect("sessions lock")
            .iter()
            .filter(|(_, slot)| {
                slot.last_used
                    .lock()
                    .expect("slot lock")
                    .is_some_and(|used| used.elapsed() > IDLE_SESSION)
            })
            .map(|(id, slot)| (id.clone(), Arc::clone(slot)))
            .collect();
        for (session_id, slot) in idle {
            // A session with a running turn holds its lock; skip it.
            let Ok(mut live) = slot.live.try_lock() else {
                continue;
            };
            if let Some(session) = live.take() {
                let _ = session.agent.flush().await;
                let _ = session.agent.shutdown().await;
            }
            drop(live);
            host.sessions
                .lock()
                .expect("sessions lock")
                .remove(&session_id);
        }
    }
}

/// Turns a tool result that failed to parse into a failed result for the same
/// call, when its session and call IDs can still be read.
fn unreadable_tool_result(line: &str, error: &serde_json::Error) -> Option<ToolResultMessage> {
    let value: Value = serde_json::from_str(line).ok()?;
    if value.get("type")?.as_str()? != "tool_result" {
        return None;
    }
    Some(ToolResultMessage {
        session_id: value.get("session_id")?.as_str()?.to_owned(),
        call_id: value.get("call_id")?.as_str()?.to_owned(),
        success: false,
        output: format!("The application tool result could not be read by the host: {error}"),
        code_mode_value: None,
        metadata: None,
    })
}

fn prompt(payload: PromptPayload) -> Prompt {
    if payload.images.is_empty() {
        return Prompt::new(payload.text);
    }
    let mut content = vec![UserInput::Text { text: payload.text }];
    content.extend(
        payload
            .images
            .into_iter()
            .map(|image_url| UserInput::Image {
                image_url,
                detail: None,
            }),
    );
    Prompt::content(content)
}

fn send(outbound: &mpsc::UnboundedSender<Value>, message: &Outbound<'_>) -> Result<(), HostError> {
    let _ = outbound.send(encode(message)?);
    Ok(())
}

fn fail_request(
    outbound: &mpsc::UnboundedSender<Value>,
    request_id: &str,
    error: &HostError,
) -> Result<(), HostError> {
    send(
        outbound,
        &Outbound::Failed {
            protocol_version: PROTOCOL_VERSION,
            request_id: Some(request_id),
            error: &error.to_string(),
        },
    )
}

async fn write_outbound(mut receiver: mpsc::UnboundedReceiver<Value>) -> std::io::Result<()> {
    let mut stdout = tokio::io::stdout();
    while let Some(message) = receiver.recv().await {
        let mut encoded = serde_json::to_vec(&message)?;
        encoded.push(b'\n');
        stdout.write_all(&encoded).await?;
        stdout.flush().await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unreadable_tool_result_still_fails_its_call() {
        let line = r#"{"type":"tool_result","session_id":"s","call_id":"c","success":"yes"}"#;
        let error = serde_json::from_str::<Inbound>(line).expect_err("malformed");
        let result = unreadable_tool_result(line, &error).expect("ids are readable");
        assert_eq!(
            (
                result.session_id.as_str(),
                result.call_id.as_str(),
                result.success
            ),
            ("s", "c", false)
        );
        assert!(unreadable_tool_result(r#"{"type":"cancel"}"#, &error).is_none());
        assert!(unreadable_tool_result("not json", &error).is_none());
    }

    #[test]
    fn text_only_prompts_stay_plain_text() {
        let prompt = prompt(PromptPayload {
            text: "hello".into(),
            images: Vec::new(),
        });
        assert_eq!(
            serde_json::to_value(&prompt).expect("serializes")["instruction"],
            "hello"
        );
    }

    #[test]
    fn images_become_image_inputs_after_the_text() {
        let prompt = prompt(PromptPayload {
            text: "look".into(),
            images: vec!["data:image/png;base64,AA==".into()],
        });
        let value = serde_json::to_value(&prompt).expect("serializes");
        let content = value["instruction"].as_array().expect("content prompt");
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[1]["type"], "image");
        assert_eq!(content[1]["image_url"], "data:image/png;base64,AA==");
    }
}
