//! Application tools: each call crosses to the Node worker as a `tool_call`
//! message and resolves when the matching `tool_result` arrives. Calls are
//! independent, so parallel calls from one Code Mode cell run concurrently.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use async_trait::async_trait;
use nanocode::{
    Tool,
    tool_contract::{ToolContext, ToolDefinition, ToolInput, ToolOutput, ToolResult},
};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use crate::protocol::{Outbound, PROTOCOL_VERSION, ToolResultMessage, encode};

#[derive(Default)]
pub struct Bridge {
    pending: Mutex<HashMap<String, oneshot::Sender<ToolResultMessage>>>,
    /// The worker request currently running in each session.
    active: Mutex<HashMap<String, String>>,
}

impl Bridge {
    pub fn begin(&self, session_id: &str, request_id: &str) {
        self.active
            .lock()
            .expect("bridge lock")
            .insert(session_id.to_owned(), request_id.to_owned());
    }

    pub fn end(&self, session_id: &str) {
        self.active.lock().expect("bridge lock").remove(session_id);
        let prefix = format!("{session_id}\0");
        self.pending
            .lock()
            .expect("bridge lock")
            .retain(|key, _| !key.starts_with(&prefix));
    }

    /// Routes a worker's tool result to the waiting call. Returns false when no
    /// call is waiting (the turn ended or the result is a duplicate).
    pub fn resolve(&self, result: ToolResultMessage) -> bool {
        let key = pending_key(&result.session_id, &result.call_id);
        match self.pending.lock().expect("bridge lock").remove(&key) {
            Some(waiting) => waiting.send(result).is_ok(),
            None => false,
        }
    }

    fn request_for(&self, session_id: &str) -> Option<String> {
        self.active
            .lock()
            .expect("bridge lock")
            .get(session_id)
            .cloned()
    }

    fn wait_for(&self, session_id: &str, call_id: &str) -> oneshot::Receiver<ToolResultMessage> {
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .expect("bridge lock")
            .insert(pending_key(session_id, call_id), sender);
        receiver
    }
}

fn pending_key(session_id: &str, call_id: &str) -> String {
    format!("{session_id}\0{call_id}")
}

#[derive(Clone)]
pub struct ProtocolTool {
    pub definition: ToolDefinition,
    pub bridge: Arc<Bridge>,
    pub outbound: mpsc::UnboundedSender<Value>,
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
        let session_id = context.session_id().to_owned();
        let call_id = context.call_id().to_owned();
        let Some(request_id) = self.bridge.request_for(&session_id) else {
            return Ok(ToolOutput::error(
                "No application turn is running for this session",
            ));
        };
        let receiver = self.bridge.wait_for(&session_id, &call_id);
        let message = encode(&Outbound::ToolCall {
            protocol_version: PROTOCOL_VERSION,
            request_id: &request_id,
            session_id: &session_id,
            call_id: &call_id,
            name: self.definition.name(),
            arguments,
        })?;
        if self.outbound.send(message).is_err() {
            return Ok(ToolOutput::error(
                "Application tool bridge closed before dispatch",
            ));
        }
        let Ok(result) = receiver.await else {
            return Ok(ToolOutput::error(
                "Application turn ended before the tool returned; the call may have run",
            ));
        };
        Ok(tool_output(result)?)
    }
}

pub fn tool_output(result: ToolResultMessage) -> Result<ToolOutput, serde_json::Error> {
    let mut output = if result.success {
        ToolOutput::text(result.output)
    } else {
        ToolOutput::error(result.output)
    };
    if let Some(value) = result.code_mode_value {
        output = output.with_structured_result(value);
    }
    if let Some(metadata) = result.metadata {
        output = output.with_metadata(metadata);
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(session_id: &str, call_id: &str) -> ToolResultMessage {
        serde_json::from_value(serde_json::json!({
            "session_id": session_id,
            "call_id": call_id,
            "success": true,
            "output": "ok",
        }))
        .expect("result parses")
    }

    #[tokio::test]
    async fn routes_results_to_the_waiting_call_only() {
        let bridge = Bridge::default();
        bridge.begin("s1", "r1");
        let first = bridge.wait_for("s1", "c1");
        let second = bridge.wait_for("s1", "c2");
        assert!(bridge.resolve(result("s1", "c2")));
        assert!(
            !bridge.resolve(result("s1", "c2")),
            "a duplicate result has no waiter"
        );
        assert_eq!(second.await.expect("resolved").call_id, "c2");
        assert!(bridge.resolve(result("s1", "c1")));
        assert_eq!(first.await.expect("resolved").call_id, "c1");
    }

    #[test]
    fn ending_a_turn_drops_its_pending_calls() {
        let bridge = Bridge::default();
        bridge.begin("s1", "r1");
        let _waiting = bridge.wait_for("s1", "c1");
        bridge.end("s1");
        assert!(bridge.request_for("s1").is_none());
        assert!(!bridge.resolve(result("s1", "c1")));
    }

    #[test]
    fn failed_results_become_tool_errors() {
        let mut failed = result("s", "c");
        failed.success = false;
        let output = tool_output(failed).expect("converts");
        assert!(!output.success);
    }
}
