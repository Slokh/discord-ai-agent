use std::{
    fs::File,
    io::{self, BufRead, BufReader},
    os::fd::{FromRawFd, RawFd},
    path::PathBuf,
    sync::{Arc, atomic::{AtomicU64, Ordering}},
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
    fs,
    io::AsyncWriteExt,
    sync::mpsc,
    time::{Duration, sleep},
};

const PROTOCOL_VERSION: u32 = 1;
const PROTOCOL_INPUT_FD: i32 = 3;
const PRIVATE_PROTOCOL_FD_MIN: i32 = 128;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum InboundMessage {
    Run(Box<RunRequest>),
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ToolResultMessage {
    call_id: String,
    success: bool,
    output: ToolOutputBody,
    #[serde(default)]
    code_mode_value: Option<Value>,
    #[serde(default)]
    metadata: Option<Box<RawValue>>,
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
    result_directory: PathBuf,
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
        result_file: &'a str,
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
    #[error("invalid model: {0}")]
    InvalidModel(String),
    #[error("invalid thinking level: {0}")]
    InvalidThinking(String),
    #[error("invalid reasoning mode: {0}")]
    InvalidReasoningMode(String),
    #[error("invalid session ID: {0}")]
    InvalidSessionId(String),
    #[error("failed to read protocol input: {0}")]
    Read(#[from] io::Error),
    #[error("invalid protocol JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("NanoCodex failed: {0}")]
    Nanocodex(String),
}

#[derive(Clone)]
struct ProtocolTool {
    request_id: Arc<str>,
    definition: ToolDefinition,
    outbound: mpsc::UnboundedSender<Value>,
    result_directory: Arc<PathBuf>,
    result_sequence: Arc<AtomicU64>,
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
        let result_file = format!(
            "result-{}.json",
            self.result_sequence.fetch_add(1, Ordering::Relaxed),
        );
        let message = serde_json::to_value(OutboundMessage::ToolCall {
            protocol_version: PROTOCOL_VERSION,
            request_id: &self.request_id,
            session_id: context.session_id(),
            call_id: &call_id,
            name: self.definition.name(),
            arguments,
            result_file: &result_file,
        })?;
        if self.outbound.send(message).is_err() {
            return Ok(ToolOutput::error(
                "Application tool bridge closed before dispatch",
            ));
        }
        let result = read_tool_result(self.result_directory.join(&result_file)).await?;
        if result.call_id != call_id {
            return Ok(ToolOutput::error("Application tool result call ID mismatch"));
        }
        let wire = nanocodex::tools::contract::ToolOutputWire {
            output: result.output,
            success: result.success,
            code_mode_value: result
                .code_mode_value
                .map(|value| serde_json::value::to_raw_value(&value))
                .transpose()?,
            metadata: result.metadata,
            process_trace: None,
        };
        let output = ToolOutput::from_wire(wire)?;
        let accepted = serde_json::to_value(OutboundMessage::ToolResultAccepted {
            protocol_version: PROTOCOL_VERSION,
            request_id: &self.request_id,
            call_id: &call_id,
        })?;
        let _ = self.outbound.send(accepted);
        Ok(output)
    }
}

async fn read_tool_result(path: PathBuf) -> Result<ToolResultMessage, serde_json::Error> {
    loop {
        match fs::read(&path).await {
            Ok(bytes) => {
                let result = serde_json::from_slice(&bytes)?;
                let _ = fs::remove_file(path).await;
                return Ok(result);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                sleep(Duration::from_millis(10)).await;
            }
            Err(error) => return Err(serde_json::Error::io(error)),
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
    let protocol_input = private_protocol_input(PROTOCOL_INPUT_FD)?;
    write_stdout(&OutboundMessage::Ready {
        protocol_version: PROTOCOL_VERSION,
    })
    .await?;

    // fd 3 carries only the startup request and is closed before NanoCodex
    // starts. Later tool results use the run's private filesystem mailbox.
    let request = tokio::task::spawn_blocking(move || read_run_request(BufReader::new(protocol_input)))
        .await
        .map_err(|error| RuntimeError::Nanocodex(format!("protocol startup reader failed: {error}")))??;
    let (outbound_sender, outbound_receiver) = mpsc::unbounded_channel();
    let writer = tokio::spawn(write_outbound(outbound_receiver));

    let request_id: Arc<str> = request.request_id.clone().into();
    let result = run_agent(*request, request_id, outbound_sender.clone()).await;
    drop(outbound_sender);
    writer.await.map_err(|error| {
        RuntimeError::Nanocodex(format!("protocol writer task failed: {error}"))
    })??;
    result
}

fn private_protocol_input(fd: RawFd) -> Result<File, io::Error> {
    let private_fd = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, PRIVATE_PROTOCOL_FD_MIN) };
    if private_fd == -1 {
        return Err(io::Error::last_os_error());
    }
    if unsafe { libc::close(fd) } == -1 {
        let error = io::Error::last_os_error();
        unsafe { libc::close(private_fd) };
        return Err(error);
    }
    let flags = unsafe { libc::fcntl(private_fd, libc::F_GETFL) };
    if flags == -1 {
        let error = io::Error::last_os_error();
        unsafe { libc::close(private_fd) };
        return Err(error);
    }
    if flags & libc::O_NONBLOCK != 0 {
        let result = unsafe { libc::fcntl(private_fd, libc::F_SETFL, flags & !libc::O_NONBLOCK) };
        if result == -1 {
            let error = io::Error::last_os_error();
            unsafe { libc::close(private_fd) };
            return Err(error);
        }
    }
    Ok(unsafe { File::from_raw_fd(private_fd) })
}

async fn run_agent(
    request: RunRequest,
    request_id: Arc<str>,
    outbound: mpsc::UnboundedSender<Value>,
) -> Result<(), RuntimeError> {
    let result_directory = Arc::new(request.result_directory.clone());
    let result_sequence = Arc::new(AtomicU64::new(1));
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
            result_directory: Arc::clone(&result_directory),
            result_sequence: Arc::clone(&result_sequence),
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

fn read_run_request(mut input: impl BufRead) -> Result<Box<RunRequest>, RuntimeError> {
    let mut first = String::new();
    match input.read_line(&mut first) {
        Ok(0) => return Err(RuntimeError::MissingRunRequest),
        Ok(_) => {}
        Err(error) => return Err(RuntimeError::Read(error)),
    }
    match serde_json::from_str::<InboundMessage>(&first)? {
        InboundMessage::Run(request) => Ok(request),
    }
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
    fn protocol_input_owns_a_private_blocking_close_on_exec_descriptor() {
        let mut descriptors = [0; 2];
        assert_eq!(unsafe { libc::pipe(descriptors.as_mut_ptr()) }, 0);
        let read_fd = descriptors[0];
        let write_fd = descriptors[1];
        let flags = unsafe { libc::fcntl(read_fd, libc::F_GETFL) };
        assert_ne!(flags, -1);
        assert_ne!(unsafe { libc::fcntl(read_fd, libc::F_SETFL, flags | libc::O_NONBLOCK) }, -1);

        let input = private_protocol_input(read_fd).expect("private protocol input");
        assert!(input.as_raw_fd() >= PRIVATE_PROTOCOL_FD_MIN);
        let blocking_flags = unsafe { libc::fcntl(input.as_raw_fd(), libc::F_GETFL) };
        assert_eq!(blocking_flags & libc::O_NONBLOCK, 0);
        let descriptor_flags = unsafe { libc::fcntl(input.as_raw_fd(), libc::F_GETFD) };
        assert_ne!(descriptor_flags & libc::FD_CLOEXEC, 0);
        assert_eq!(unsafe { libc::fcntl(read_fd, libc::F_GETFL) }, -1);

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
        let result_directory = std::env::temp_dir().join(format!(
            "nanocodex-runtime-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("current time")
                .as_nanos(),
        ));
        std::fs::create_dir(&result_directory).expect("result directory");
        let (outbound, mut calls) = mpsc::unbounded_channel();
        let tools = Tools::builder()
            .without_defaults()
            .tool(ProtocolTool {
                request_id: Arc::from("request-test"),
                definition,
                outbound,
                result_directory: Arc::new(result_directory.clone()),
                result_sequence: Arc::new(AtomicU64::new(1)),
            })
            .build()
            .expect("valid tools");
        let runtime = ToolRuntime::new_with_tools(".", None, None, &tools);
        let result_sender = tokio::spawn(async move {
            let call = calls.recv().await.expect("protocol tool call");
            let call_id = call["call_id"].as_str().expect("call id").to_owned();
            let result_file = call["result_file"].as_str().expect("result file");
            std::fs::write(
                result_directory.join(result_file),
                serde_json::to_vec(&json!({
                    "call_id": call_id,
                    "success": true,
                    "output": "bridge ok"
                })).expect("result JSON"),
            ).expect("write result");
            result_directory
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

        let result_directory = result_sender.await.expect("result sender completed");
        std::fs::remove_dir_all(result_directory).expect("remove result directory");
        assert!(execution.success);
        assert_eq!(execution.nested_calls.len(), 1);
    }
}
