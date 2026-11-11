//! JSON-lines protocol between the Node worker and this long-lived host.
//!
//! The worker writes one inbound message per line on stdin; the host writes one
//! outbound message per line on stdout. Every turn is identified by the
//! worker's request ID, and every application tool call by its session and
//! call IDs, so many sessions and parallel tool calls share one pipe.

use nanocode::tool_contract::ToolDefinition;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 2;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Inbound {
    /// Sent once, before any turn: the stable application tool catalog.
    Configure(Box<Configure>),
    Turn(Box<TurnRequest>),
    ToolResult(Box<ToolResultMessage>),
    Steer(SteerRequest),
    Cancel(CancelRequest),
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Configure {
    pub tools: Vec<ToolDefinition>,
    #[serde(default)]
    pub app_title: Option<String>,
    #[serde(default)]
    pub app_url: Option<String>,
    /// Replaces the OpenRouter gateway base URL (local capture servers, tests).
    #[serde(default)]
    pub api_base_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TurnRequest {
    pub request_id: String,
    pub session_id: String,
    pub model: String,
    pub thinking: String,
    /// Applied only when the session is created. The worker derives the
    /// session ID from a hash of these instructions, the tool catalog and the
    /// model, so a changed contract always starts a new session.
    pub instructions: String,
    /// Recent conversation the worker already had with this requester,
    /// prepended to the prompt only when the session is created here.
    #[serde(default)]
    pub bootstrap: Option<String>,
    pub prompt: PromptPayload,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PromptPayload {
    pub text: String,
    #[serde(default)]
    pub images: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolResultMessage {
    pub session_id: String,
    pub call_id: String,
    pub success: bool,
    pub output: String,
    #[serde(default)]
    pub code_mode_value: Option<Value>,
    /// A plain `Value`: serde_json's `RawValue` cannot be decoded inside an
    /// internally tagged enum, which made every tool result with metadata
    /// fail to parse.
    #[serde(default)]
    pub metadata: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SteerRequest {
    /// The running turn to steer.
    pub request_id: String,
    /// The worker's ID for the steering message, so a retried steer is not
    /// applied twice.
    pub steer_id: String,
    pub prompt: PromptPayload,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CancelRequest {
    pub request_id: String,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Outbound<'a> {
    Ready {
        protocol_version: u32,
    },
    Configured {
        protocol_version: u32,
        durable: bool,
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
    Steered {
        protocol_version: u32,
        request_id: &'a str,
        steer_id: &'a str,
        accepted: bool,
        error: Option<&'a str>,
    },
    Completed {
        protocol_version: u32,
        request_id: &'a str,
        session_id: &'a str,
        final_message: &'a str,
        usage: Value,
        resumed: bool,
    },
    Failed {
        protocol_version: u32,
        request_id: Option<&'a str>,
        error: &'a str,
    },
}

pub fn encode(message: &Outbound<'_>) -> Result<Value, serde_json::Error> {
    serde_json::to_value(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_turn_with_images_and_bootstrap() {
        let message: Inbound = serde_json::from_str(
            r#"{"type":"turn","request_id":"r","session_id":"s","model":"gpt-6-luna","thinking":"high","instructions":"i","bootstrap":"b","prompt":{"text":"t","images":["data:image/png;base64,AA=="]}}"#,
        )
        .expect("turn parses");
        let Inbound::Turn(turn) = message else {
            panic!("expected a turn")
        };
        assert_eq!(turn.bootstrap.as_deref(), Some("b"));
        assert_eq!(turn.prompt.images.len(), 1);
    }

    #[test]
    fn parses_tool_results_shaped_like_the_worker_sends_them() {
        let message: Inbound = serde_json::from_str(
            r#"{"type":"tool_result","session_id":"s","call_id":"c","success":true,"output":"ok","code_mode_value":{"n":1},"metadata":{"status":"ok","fileCount":0,"tableCount":0}}"#,
        )
        .expect("tool result parses");
        let Inbound::ToolResult(result) = message else {
            panic!("expected a tool result")
        };
        assert_eq!(result.metadata.expect("metadata")["status"], "ok");
        assert_eq!(result.code_mode_value.expect("value")["n"], 1);
    }

    #[test]
    fn rejects_unknown_fields() {
        let parsed = serde_json::from_str::<Inbound>(
            r#"{"type":"cancel","request_id":"r","surprise":true}"#,
        );
        assert!(parsed.is_err());
    }

    #[test]
    fn encodes_tool_calls_with_their_session_and_call_ids() {
        let value = encode(&Outbound::ToolCall {
            protocol_version: PROTOCOL_VERSION,
            request_id: "r",
            session_id: "s",
            call_id: "c",
            name: "add",
            arguments: serde_json::json!({"a": 1}),
        })
        .expect("encodes");
        assert_eq!(value["type"], "tool_call");
        assert_eq!(value["session_id"], "s");
        assert_eq!(value["call_id"], "c");
    }
}
