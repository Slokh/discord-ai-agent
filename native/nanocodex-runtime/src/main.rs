use std::{
    collections::HashMap,
    fs::File,
    io::{self, BufRead, BufReader},
    os::fd::{FromRawFd, RawFd},
    sync::{Arc, Mutex as StdMutex},
    thread,
};

use async_trait::async_trait;
use nanocodex::{
    Model, Nanocodex, OpenAi, ReasoningMode, Thinking, Tool, Tools,
    agent::session::{SessionId, SessionSnapshot},
    oai::transport::ResponsesTransport,
    tools::{
        ToolContext, ToolDefinition, ToolInput, ToolOutput, ToolResult, contract::ToolOutputBody,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, value::RawValue};
use thiserror::Error;
use tokio::{
    io::AsyncWriteExt,
    sync::{mpsc, oneshot},
};

const PROTOCOL_VERSION: u32 = 1;
const PROTOCOL_INPUT_FD: i32 = 3;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum InboundMessage {
    Run(Box<RunRequest>),
    ToolResult {
        call_id: String,
        success: bool,
        output: ToolOutputBody,
        #[serde(default)]
        code_mode_value: Option<Value>,
        #[serde(default)]
        metadata: Option<Box<RawValue>>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RunRequest {
    request_id: String,
    api_key: String,
    api_base_url: String,
    model: String,
    #[serde(default)]
    model_id_prefix: Option<String>,
    thinking: String,
    #[serde(default = "default_reasoning_mode")]
    reasoning_mode: String,
    #[serde(default)]
    fast_mode: bool,
    #[serde(default)]
    hosted_web_search: bool,
    #[serde(default)]
    workspace_tools: bool,
    instructions: String,
    prompt: String,
    session_id: String,
    #[serde(default)]
    workspace: Option<String>,
    #[serde(default)]
    resume: Option<SessionSnapshot>,
    tools: Vec<ToolDefinition>,
}

fn default_reasoning_mode() -> String {
    "standard".to_owned()
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum OutboundMessage<'a> {
    Ready {
        protocol_version: u32,
    },
    Event {
        protocol_version: u32,
        request_id: &'a str,
        event: Value,
    },
    ToolCall {
        protocol_version: u32,
        request_id: &'a str,
        session_id: &'a str,
        call_id: &'a str,
        name: &'a str,
        arguments: Value,
    },
    ToolResultAccepted {
        protocol_version: u32,
        request_id: &'a str,
        call_id: &'a str,
    },
    Completed {
        protocol_version: u32,
        request_id: &'a str,
        final_message: &'a str,
        usage: Value,
        snapshot: Value,
    },
    Failed {
        protocol_version: u32,
        request_id: Option<&'a str>,
        error: &'a str,
    },
}

#[derive(Debug, Error)]
enum RuntimeError {
    #[error("stdin closed before a run request was received")]
    MissingRunRequest,
    #[error("stdin closed while the NanoCodex runtime was active")]
    InputClosed,
    #[error("the first protocol message must be run")]
    RunRequestNotFirst,
    #[error("a second run request is not allowed")]
    DuplicateRunRequest,
    #[error("invalid model: {0}")]
    InvalidModel(String),
    #[error("invalid thinking level: {0}")]
    InvalidThinking(String),
    #[error("invalid reasoning mode: {0}")]
    InvalidReasoningMode(String),
    #[error("invalid session ID: {0}")]
    InvalidSessionId(String),
    #[error("tool result references unknown call ID: {0}")]
    UnknownToolCall(String),
    #[error("failed to read protocol input: {0}")]
    Read(#[from] io::Error),
    #[error("invalid protocol JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("NanoCodex failed: {0}")]
    Nanocodex(String),
}

type PendingCalls = Arc<StdMutex<HashMap<String, oneshot::Sender<ToolOutput>>>>;

#[derive(Clone)]
struct ProtocolTool {
    request_id: Arc<str>,
    definition: ToolDefinition,
    outbound: mpsc::UnboundedSender<Value>,
    pending: PendingCalls,
}

#[async_trait]
impl Tool for ProtocolTool {
    fn definition(&self) -> ToolDefinition {
        self.definition.clone()
    }

    async fn execute(&self, input: ToolInput, context: ToolContext<'_>) -> ToolResult {
        let arguments = match input {
            ToolInput::Function(raw) => serde_json::from_str(raw.get())?,
            ToolInput::Freeform(text) => Value::String(text),
        };
        let call_id = context.call_id().to_owned();
        let (sender, receiver) = oneshot::channel();
        pending_calls(&self.pending).insert(call_id.clone(), sender);
        let message = serde_json::to_value(OutboundMessage::ToolCall {
            protocol_version: PROTOCOL_VERSION,
            request_id: &self.request_id,
            session_id: context.session_id(),
            call_id: &call_id,
            name: self.definition.name(),
            arguments,
        })?;
        if self.outbound.send(message).is_err() {
            pending_calls(&self.pending).remove(&call_id);
            return Ok(ToolOutput::error(
                "Application tool bridge closed before dispatch",
            ));
        }
        match receiver.await {
            Ok(output) => Ok(output),
            Err(_) => Ok(ToolOutput::error(
                "Application tool bridge closed before returning a result",
            )),
        }
    }
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        let message = OutboundMessage::Failed {
            protocol_version: PROTOCOL_VERSION,
            request_id: None,
            error: &error.to_string(),
        };
        let _ = write_stdout(&message).await;
        std::process::exit(1);
    }
}

async fn run() -> Result<(), RuntimeError> {
    let protocol_input = blocking_protocol_input(PROTOCOL_INPUT_FD)?;
    write_stdout(&OutboundMessage::Ready {
        protocol_version: PROTOCOL_VERSION,
    })
    .await?;

    // The application bridge owns fd 3. Stdin is deliberately disconnected by
    // the parent so the embedded runtime and its child processes can never
    // compete with protocol replies. A dedicated reader thread also keeps the
    // bridge independent of the async executor driving Code Mode.
    let pending: PendingCalls = Arc::new(StdMutex::new(HashMap::new()));
    let (outbound_sender, outbound_receiver) = mpsc::unbounded_channel();
    let writer = tokio::spawn(write_outbound(outbound_receiver));
    let (run_sender, run_receiver) = oneshot::channel();
    let (input_error_sender, mut input_errors) = mpsc::unbounded_channel();
    let input_pending = Arc::clone(&pending);
    let input_outbound = outbound_sender.clone();
    thread::Builder::new()
        .name("nanocodex-protocol-input".to_owned())
        .spawn(move || {
            read_protocol_input(
                BufReader::new(protocol_input),
                input_pending,
                input_outbound,
                run_sender,
                input_error_sender,
            );
        })
        .map_err(RuntimeError::Read)?;
    let request = run_receiver
        .await
        .map_err(|_| RuntimeError::MissingRunRequest)??;

    let request_id: Arc<str> = request.request_id.clone().into();
    let agent = run_agent(*request, request_id, outbound_sender.clone(), pending);
    tokio::pin!(agent);
    let result = tokio::select! {
        result = &mut agent => result,
        Some(error) = input_errors.recv() => Err(error),
    };
    drop(outbound_sender);
    writer.await.map_err(|error| {
        RuntimeError::Nanocodex(format!("protocol writer task failed: {error}"))
    })??;
    result
}

fn blocking_protocol_input(fd: RawFd) -> Result<File, io::Error> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags == -1 {
        return Err(io::Error::last_os_error());
    }
    if flags & libc::O_NONBLOCK != 0 {
        let result = unsafe { libc::fcntl(fd, libc::F_SETFL, flags & !libc::O_NONBLOCK) };
        if result == -1 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

async fn run_agent(
    request: RunRequest,
    request_id: Arc<str>,
    outbound: mpsc::UnboundedSender<Value>,
    pending: PendingCalls,
) -> Result<(), RuntimeError> {
    let model = request
        .model
        .parse::<Model>()
        .map_err(RuntimeError::InvalidModel)?;
    let thinking = request
        .thinking
        .parse::<Thinking>()
        .map_err(RuntimeError::InvalidThinking)?;
    let reasoning_mode = request
        .reasoning_mode
        .parse::<ReasoningMode>()
        .map_err(RuntimeError::InvalidReasoningMode)?;
    let session_id = request
        .session_id
        .parse::<SessionId>()
        .map_err(|error| RuntimeError::InvalidSessionId(error.to_string()))?;

    let mut openai = OpenAi::builder(request.api_key)
        .model(model)
        .thinking(thinking)
        .reasoning_mode(reasoning_mode)
        .fast_mode(request.fast_mode)
        .transport(ResponsesTransport::Https)
        .api_base_url(request.api_base_url);
    if let Some(prefix) = request.model_id_prefix {
        openai = openai.model_id_prefix(prefix);
    }
    let openai = openai
        .build()
        .map_err(|error| RuntimeError::Nanocodex(error.to_string()))?;

    // Discord turns never receive NanoCodex workspace or image-generation
    // tools. Hosted search is the one native capability enabled here; every
    // application mutation still crosses the typed protocol bridge below.
    let mut tools = Tools::builder()
        .without_defaults()
        .web_search(request.hosted_web_search)
        .workspace(request.workspace_tools);
    for definition in request.tools {
        tools = tools.tool(ProtocolTool {
            request_id: Arc::clone(&request_id),
            definition,
            outbound: outbound.clone(),
            pending: Arc::clone(&pending),
        });
    }
    let tools = tools
        .build()
        .map_err(|error| RuntimeError::Nanocodex(error.to_string()))?;

    let mut builder = Nanocodex::builder(openai)
        .session_id(session_id)
        .instructions(request.instructions)
        .thinking(thinking)
        .reasoning_mode(reasoning_mode)
        .fast_mode(request.fast_mode)
        .tools(tools);
    if let Some(workspace) = request.workspace {
        builder = builder.workspace(workspace);
    }
    if let Some(snapshot) = request.resume {
        builder = builder.resume(snapshot);
    }
    let (agent, mut events) = builder
        .build()
        .map_err(|error| RuntimeError::Nanocodex(error.to_string()))?;

    let event_request_id = Arc::clone(&request_id);
    let event_outbound = outbound.clone();
    let event_task = tokio::spawn(async move {
        while let Some(event) = events.recv().await {
            let event = serde_json::to_value(event)?;
            let message = serde_json::to_value(OutboundMessage::Event {
                protocol_version: PROTOCOL_VERSION,
                request_id: &event_request_id,
                event,
            })?;
            if event_outbound.send(message).is_err() {
                break;
            }
        }
        Ok::<(), serde_json::Error>(())
    });

    let turn = agent
        .prompt(request.prompt)
        .await
        .map_err(|error| RuntimeError::Nanocodex(error.to_string()))?;
    let result = turn
        .result()
        .await
        .map_err(|error| RuntimeError::Nanocodex(error.to_string()))?;
    let usage = serde_json::to_value(result.usage())?;
    let snapshot = serde_json::to_value(result.snapshot())?;
    let completed = serde_json::to_value(OutboundMessage::Completed {
        protocol_version: PROTOCOL_VERSION,
        request_id: &request_id,
        final_message: result.final_message(),
        usage,
        snapshot,
    })?;
    let _ = outbound.send(completed);
    drop(agent);
    event_task
        .await
        .map_err(|error| RuntimeError::Nanocodex(format!("event task failed: {error}")))?
        .map_err(RuntimeError::Json)?;
    Ok(())
}

fn read_protocol_input(
    mut input: impl BufRead,
    pending: PendingCalls,
    outbound: mpsc::UnboundedSender<Value>,
    run_sender: oneshot::Sender<Result<Box<RunRequest>, RuntimeError>>,
    input_error_sender: mpsc::UnboundedSender<RuntimeError>,
) {
    let mut first = String::new();
    match input.read_line(&mut first) {
        Ok(0) => {
            let _ = run_sender.send(Err(RuntimeError::MissingRunRequest));
            return;
        }
        Ok(_) => {}
        Err(error) => {
            let _ = run_sender.send(Err(RuntimeError::Read(error)));
            return;
        }
    }
    let request = match serde_json::from_str::<InboundMessage>(&first) {
        Ok(InboundMessage::Run(request)) => request,
        Ok(InboundMessage::ToolResult { .. }) => {
            let _ = run_sender.send(Err(RuntimeError::RunRequestNotFirst));
            return;
        }
        Err(error) => {
            let _ = run_sender.send(Err(RuntimeError::Json(error)));
            return;
        }
    };
    let request_id = request.request_id.clone();
    if run_sender.send(Ok(request)).is_err() {
        return;
    }

    for line in input.lines() {
        let result = (|| -> Result<(), RuntimeError> {
            match serde_json::from_str::<InboundMessage>(&line?)? {
                InboundMessage::Run(_) => return Err(RuntimeError::DuplicateRunRequest),
                InboundMessage::ToolResult {
                    call_id,
                    success,
                    output,
                    code_mode_value,
                    metadata,
                } => {
                    let sender = pending_calls(&pending)
                        .remove(&call_id)
                        .ok_or_else(|| RuntimeError::UnknownToolCall(call_id.clone()))?;
                    let wire = nanocodex::tools::contract::ToolOutputWire {
                        output,
                        success,
                        code_mode_value: code_mode_value
                            .map(|value| serde_json::value::to_raw_value(&value))
                            .transpose()?,
                        metadata,
                        process_trace: None,
                    };
                    let output = ToolOutput::from_wire(wire)?;
                    sender.send(output).map_err(|_| {
                        RuntimeError::Nanocodex(format!(
                            "tool result receiver closed before accepting call {call_id}"
                        ))
                    })?;
                    let accepted = serde_json::to_value(OutboundMessage::ToolResultAccepted {
                        protocol_version: PROTOCOL_VERSION,
                        request_id: &request_id,
                        call_id: &call_id,
                    })?;
                    outbound.send(accepted).map_err(|_| {
                        RuntimeError::Nanocodex(
                            "protocol writer closed before acknowledging a tool result".to_owned(),
                        )
                    })?;
                }
            }
            Ok(())
        })();
        if let Err(error) = result {
            let _ = input_error_sender.send(error);
            return;
        }
    }
    let _ = input_error_sender.send(RuntimeError::InputClosed);
}

fn pending_calls(
    pending: &PendingCalls,
) -> std::sync::MutexGuard<'_, HashMap<String, oneshot::Sender<ToolOutput>>> {
    pending
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

async fn write_outbound(mut receiver: mpsc::UnboundedReceiver<Value>) -> Result<(), RuntimeError> {
    let mut stdout = tokio::io::stdout();
    while let Some(message) = receiver.recv().await {
        let mut encoded = serde_json::to_vec(&message)?;
        encoded.push(b'\n');
        stdout.write_all(&encoded).await?;
        stdout.flush().await?;
    }
    Ok(())
}

async fn write_stdout(message: &impl Serialize) -> Result<(), RuntimeError> {
    let mut stdout = tokio::io::stdout();
    let mut encoded = serde_json::to_vec(message)?;
    encoded.push(b'\n');
    stdout.write_all(&encoded).await?;
    stdout.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use nanocodex::tools::{ToolContext, runtime::ToolRuntime};
    use serde_json::json;
    use std::os::fd::AsRawFd;
    use tokio::time::{Duration, timeout};

    #[test]
    fn protocol_input_clears_inherited_nonblocking_flag() {
        let mut descriptors = [0; 2];
        assert_eq!(unsafe { libc::pipe(descriptors.as_mut_ptr()) }, 0);
        let read_fd = descriptors[0];
        let write_fd = descriptors[1];
        let flags = unsafe { libc::fcntl(read_fd, libc::F_GETFL) };
        assert_ne!(flags, -1);
        assert_ne!(unsafe { libc::fcntl(read_fd, libc::F_SETFL, flags | libc::O_NONBLOCK) }, -1);

        let input = blocking_protocol_input(read_fd).expect("blocking protocol input");
        let blocking_flags = unsafe { libc::fcntl(input.as_raw_fd(), libc::F_GETFL) };
        assert_eq!(blocking_flags & libc::O_NONBLOCK, 0);

        assert_eq!(unsafe { libc::close(write_fd) }, 0);
    }

    #[tokio::test]
    async fn protocol_tool_result_resumes_nested_code_mode_call() {
        let definition: ToolDefinition = serde_json::from_value(json!({
            "type": "function",
            "name": "lookup",
            "description": "Return a value.",
            "strict": false,
            "parameters": { "type": "object", "properties": {} }
        }))
        .expect("valid tool definition");
        let pending: PendingCalls = Arc::new(StdMutex::new(HashMap::new()));
        let (outbound, mut calls) = mpsc::unbounded_channel();
        let tools = Tools::builder()
            .without_defaults()
            .tool(ProtocolTool {
                request_id: Arc::from("request-test"),
                definition,
                outbound,
                pending: Arc::clone(&pending),
            })
            .build()
            .expect("valid tools");
        let runtime = ToolRuntime::new_with_tools(".", None, None, &tools);
        let result_sender = tokio::spawn(async move {
            let call = calls.recv().await.expect("protocol tool call");
            let call_id = call["call_id"].as_str().expect("call id").to_owned();
            let sent = pending_calls(&pending)
                .remove(&call_id)
                .expect("pending call")
                .send(ToolOutput::text("bridge ok"));
            assert!(sent.is_ok(), "active receiver");
        });
        let history = Vec::new();
        let context =
            ToolContext::new("gpt-5.6-sol", "session-test", "outer-call", &history, 1_000);
        let execution = timeout(
            Duration::from_secs(2),
            runtime.execute_code(
                "const value = await tools.lookup({}); text(value);",
                context,
            ),
        )
        .await
        .expect("code mode completed");

        result_sender.await.expect("result sender completed");
        assert!(execution.success);
        assert_eq!(execution.nested_calls.len(), 1);
    }
}
