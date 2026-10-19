// Native OpenCode v2 chat adapter.
//
// OpenCode is not an OpenAI-compatible server. Its local service owns an
// authenticated API and selects models as `{ providerID, id }`. The service
// registration supplies the rotating loopback URL and password, so Mochi
// never stores either value or asks the user to paste it.

use std::time::Duration;

use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::chat::{self, Chat, ChatContext, ChatReply, ModelInfo};
use crate::i18n::t;
use crate::net;

const DEFAULT_MODEL: &str = "opencode/nemotron-3-ultra-free";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const RUN_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Clone)]
struct Service {
    base: Url,
    authorization: String,
}

#[derive(Debug, Clone, Deserialize)]
struct AvailableModel {
    #[serde(rename = "providerID")]
    provider_id: String,
    #[serde(rename = "modelID")]
    model_id: String,
    name: String,
    #[serde(default = "enabled_by_default")]
    enabled: bool,
}

fn enabled_by_default() -> bool { true }

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct ModelRef {
    #[serde(rename = "providerID")]
    provider_id: String,
    id: String,
}

fn service_file() -> std::path::PathBuf {
    // This is OpenCode v2's documented user-level service registration.
    crate::platform::home_dir().join(".local/state/opencode/service.json")
}

fn executable() -> Option<std::path::PathBuf> {
    crate::platform::find_on_path("opencode").or_else(|| {
        let home = crate::platform::home_dir();
        [home.join(".opencode/bin/opencode"), home.join(".local/bin/opencode")]
            .into_iter().find(|p| p.is_file())
    })
}

async fn start_service() -> Result<(), String> {
    let exe = executable().ok_or_else(|| t("OpenCode is not running."))?;
    let mut command = tokio::process::Command::new(exe);
    command.args(["service", "start"]).kill_on_drop(true);
    let result = tokio::time::timeout(
        Duration::from_secs(15),
        command.output(),
    ).await.map_err(|_| t("OpenCode took too long to answer."))?
        .map_err(|_| t("OpenCode could not connect."))?;
    if result.status.success() { Ok(()) } else { Err(t("OpenCode could not connect.")) }
}

fn service() -> Result<Service, String> {
    let bytes = std::fs::read(service_file()).map_err(|_| t("OpenCode is not running."))?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| t("Restart OpenCode and try again."))?;
    let raw_url = value.get("url").and_then(Value::as_str)
        .ok_or_else(|| t("Restart OpenCode and try again."))?;
    let password = value.get("password").and_then(Value::as_str)
        .ok_or_else(|| t("Restart OpenCode and try again."))?;
    let base = net::normalise_server_url(raw_url)
        .map_err(|_| t("Restart OpenCode and try again."))?;
    // The password came from the local registration, not a user-entered URL.
    // Do not send it anywhere but this computer even if that file is tampered with.
    if !net::is_loopback_url(&base) {
        return Err(t("Restart OpenCode and try again."));
    }
    let basic = crate::claude::base64_for(format!("opencode:{password}").as_bytes());
    Ok(Service { base, authorization: format!("Basic {basic}") })
}

fn endpoint(service: &Service, path: &str) -> String {
    net::join(&service.base, &format!("api/{}", path.trim_start_matches('/')))
}

fn unavailable() -> String {
    t("OpenCode could not connect.")
}

async fn json_response(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    let bytes = net::read_capped(response, net::MAX_BODY).await?;
    if matches!(status.as_u16(), 401 | 403) {
        return Err(t("Restart OpenCode and try again."));
    }
    if !status.is_success() {
        let detail = net::error_detail(&bytes);
        return Err(if detail.is_empty() { format!("OpenCode returned HTTP {}.", status.as_u16()) } else { detail });
    }
    serde_json::from_slice(&bytes).map_err(|_| unavailable())
}

async fn request_models(service: &Service) -> Result<Vec<AvailableModel>, String> {
    let client = net::client(&service.base, REQUEST_TIMEOUT)?;
    let response = client.get(endpoint(service, "model"))
        .header("Authorization", &service.authorization)
        .send().await.map_err(|_| unavailable())?;
    let body = json_response(response).await?;
    let items = body.get("data").and_then(Value::as_array).ok_or_else(unavailable)?;
    Ok(items.iter()
        .filter_map(|item| serde_json::from_value::<AvailableModel>(item.clone()).ok())
        .filter(|model| model.enabled)
        .collect())
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct ActiveSession {
    id: String,
    cwd: String,
}

fn active_ids(body: &Value) -> Result<Vec<String>, String> {
    let data = body.get("data").and_then(Value::as_object).ok_or_else(unavailable)?;
    data.iter().map(|(id, status)| {
        if id.starts_with("ses") && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
            && status.get("type").and_then(Value::as_str) == Some("running") {
            Ok(id.clone())
        } else {
            Err(unavailable())
        }
    }).collect()
}

/// Recover live work after Mochi restarts, without starting OpenCode or mistaking
/// saved history (or an idle client process) for a running session.
#[tauri::command]
pub async fn opencode_active_sessions() -> Result<Vec<ActiveSession>, String> {
    if !service_file().is_file() { return Ok(Vec::new()); }
    let service = service()?;
    tokio::time::timeout(Duration::from_secs(8), async {
        let client = net::client(&service.base, Duration::from_secs(3))?;
        let read_active = || async {
            let response = client.get(endpoint(&service, "session/active"))
                .header("Authorization", &service.authorization)
                .send().await.map_err(|_| unavailable())?;
            active_ids(&json_response(response).await?)
        };
        let mut sessions = Vec::new();
        for id in read_active().await? {
            let response = client.get(endpoint(&service, &format!("session/{id}")))
                .header("Authorization", &service.authorization)
                .send().await.map_err(|_| unavailable())?;
            // A session can disappear while its metadata is being fetched.
            if response.status() == reqwest::StatusCode::NOT_FOUND { continue; }
            let body = json_response(response).await?;
            let Some(info) = body.get("data") else { continue };
            if info.get("id").and_then(Value::as_str) != Some(id.as_str()) { continue; }
            let Some(cwd) = info.pointer("/location/directory").and_then(Value::as_str)
                .filter(|cwd| !cwd.is_empty()) else { continue };
            sessions.push(ActiveSession { id, cwd: cwd.to_string() });
        }
        if !sessions.is_empty() {
            // Do not revive a turn that finished during the metadata requests.
            let still_running = read_active().await?;
            sessions.retain(|session| still_running.contains(&session.id));
        }
        Ok(sessions)
    }).await.map_err(|_| unavailable())?
}

fn model_key(model: &AvailableModel) -> String {
    format!("{}/{}", model.provider_id, model.model_id)
}

fn model_ref_key(model: &ModelRef) -> String {
    format!("{}/{}", model.provider_id, model.id)
}

fn model_ref(models: &[AvailableModel], chosen: &str) -> Result<ModelRef, String> {
    let chosen = if chosen.trim().is_empty() { DEFAULT_MODEL } else { chosen.trim() };
    if let Some(model) = models.iter().find(|model| model_key(model) == chosen) {
        return Ok(ModelRef { provider_id: model.provider_id.clone(), id: model.model_id.clone() });
    }
    // OpenCode renamed the saved model from `nemotron-3-ultra` to the current
    // `nemotron-3-ultra-free`. Preserve that OpenCode choice across the rename.
    if chosen == "opencode/nemotron-3-ultra" {
        if let Some(model) = models.iter().find(|model| model_key(model) == DEFAULT_MODEL) {
            return Ok(ModelRef { provider_id: model.provider_id.clone(), id: model.model_id.clone() });
        }
    }
    Err(t("That model is not available. Pick another one."))
}

/// Models currently exposed by the installed OpenCode service. IDs stay in
/// OpenCode's own `provider/model` format so the picker and service agree.
pub async fn models() -> Result<Vec<ModelInfo>, String> {
    start_service().await?;
    let service = service()?;
    let mut models = request_models(&service).await?;
    models.sort_by(|a, b| model_key(a).cmp(&model_key(b)));
    if models.is_empty() {
        return Err(t("OpenCode has no enabled models."));
    }
    Ok(models.into_iter().map(|model| ModelInfo {
        id: model_key(&model),
        label: format!("{} · {}", model.provider_id, model.name),
    }).collect())
}

/// Decodes `opencode run --format json`'s line-delimited events. Only text
/// parts are shown in Mochi; tool and reasoning events stay in OpenCode.
fn run_result(stdout: &[u8]) -> Result<(String, String), String> {
    let mut session = None;
    let mut answer = String::new();
    let mut error = None;
    for line in String::from_utf8_lossy(stdout).lines() {
        let Ok(event) = serde_json::from_str::<Value>(line) else { continue };
        if session.is_none() {
            session = event.get("sessionID").and_then(Value::as_str).map(str::to_string);
        }
        if event.get("type").and_then(Value::as_str) == Some("text") {
            if let Some(text) = event.pointer("/part/text").and_then(Value::as_str) {
                answer.push_str(text);
            }
        }
        if event.get("type").and_then(Value::as_str) == Some("error") {
            error = event.pointer("/error/message").and_then(Value::as_str)
                .or_else(|| event.get("error").and_then(Value::as_str))
                .map(str::to_string);
        }
    }
    if let Some(error) = error { return Err(error); }
    let session = session.ok_or_else(|| t("OpenCode could not connect."))?;
    let answer = answer.trim().to_string();
    if answer.is_empty() { return Err(t("No response text.")); }
    Ok((session, answer))
}

/// Runs the installed OpenCode client instead of sending an inference request
/// as an arbitrary HTTP client. This is required for OpenCode Zen's free tier
/// and keeps all provider authentication inside OpenCode.
async fn run(model: &ModelRef, session: Option<&str>, text: String) -> Result<(String, String), String> {
    let mut command = tokio::process::Command::new(executable().ok_or_else(|| t("OpenCode is not running."))?);
    command.arg("run")
        .arg("--format").arg("json")
        .arg("--model").arg(model_ref_key(model))
        .arg("--title").arg("Mochi chat")
        .current_dir(crate::platform::home_dir())
        .kill_on_drop(true);
    if let Some(session) = session {
        command.arg("--session").arg(session);
    }
    command.arg(text);
    let output = tokio::time::timeout(RUN_TIMEOUT, command.output()).await
        .map_err(|_| t("OpenCode took too long to answer."))?
        .map_err(|_| t("OpenCode is not running."))?;
    if output.status.success() {
        return run_result(&output.stdout);
    }
    if let Ok(result) = run_result(&output.stdout) {
        return Ok(result);
    }
    let error = String::from_utf8_lossy(&output.stderr).trim().chars().take(400).collect::<String>();
    Err(if error.is_empty() { t("OpenCode could not connect.") } else { error })
}

/// One turn through the installed OpenCode client. The first turn starts a
/// session, and later turns pass that session back to the CLI.
pub async fn send(
    _app: &AppHandle,
    chat: &Chat,
    chosen_model: &str,
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, String> {
    let turn = chat.begin("opencode");
    let (request, cancelled) = chat.begin_opencode_request();
    let result = tokio::select! {
        answer = async {
            start_service().await?;
            let service = service()?;
            let model = model_ref(&request_models(&service).await?, chosen_model)?;
            let existing = chat.opencode_session(&turn);
            let question = chat::plain_question(turn.first, context.as_ref(), &query);
            let text = if turn.first {
                format!("{}\n\nDo not run tools or modify files.\n\n{}", chat::system_prompt(false), question)
            } else {
                question
            };
            run(&model, existing.as_deref(), text).await
        } => answer,
        _ = cancelled => Err(t("Workflow stopped.")),
    };
    chat.end_opencode_request(request);
    let (session, answer) = result?;
    chat.remember_opencode_session(&turn, session);
    let user = json!({ "role": "user", "content": query.clone() });
    let assistant = json!({ "role": "assistant", "content": answer.clone() });
    let plain = chat::plain_question(turn.first, context.as_ref(), &query);
    chat.commit(&turn, user, assistant, &plain, &answer);
    Ok(ChatReply { text: answer })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn available() -> Vec<AvailableModel> {
        serde_json::from_value(json!([
            { "providerID": "nvidia", "modelID": "meta/muse", "name": "Muse", "enabled": true },
            { "providerID": "opencode", "modelID": "nemotron-3-ultra-free", "name": "Nemotron 3 Ultra Free", "enabled": true }
        ])).unwrap()
    }

    #[test]
    fn the_saved_pre_rename_nemotron_model_uses_its_current_opencode_id() {
        assert_eq!(
            model_ref(&available(), "opencode/nemotron-3-ultra").unwrap(),
            ModelRef { provider_id: "opencode".into(), id: "nemotron-3-ultra-free".into() },
        );
        assert_eq!(
            model_ref(&available(), "nvidia/meta/muse").unwrap(),
            ModelRef { provider_id: "nvidia".into(), id: "meta/muse".into() },
        );
        assert!(model_ref(&available(), "missing/model").is_err());
    }

    #[test]
    fn cli_events_keep_text_and_the_open_code_session_id() {
        let events = br#"{"type":"step_start","sessionID":"ses_1","part":{"type":"step-start"}}
{"type":"text","sessionID":"ses_1","part":{"type":"text","text":"Hello"}}
{"type":"text","sessionID":"ses_1","part":{"type":"text","text":", world"}}
"#;
        assert_eq!(run_result(events).unwrap(), ("ses_1".into(), "Hello, world".into()));
    }

    #[test]
    fn endpoints_keep_the_open_code_api_prefix() {
        let service = Service {
            base: Url::parse("http://127.0.0.1:49374").unwrap(),
            authorization: "Basic test".into(),
        };
        assert_eq!(endpoint(&service, "model"), "http://127.0.0.1:49374/api/model");
    }

    #[test]
    fn startup_reads_only_authoritative_running_session_ids() {
        assert_eq!(active_ids(&json!({ "data": {
            "ses_one": { "type": "running" }, "ses_two": { "type": "running" }
        }})).unwrap(), vec!["ses_one", "ses_two"]);
        assert!(active_ids(&json!({ "data": {} })).unwrap().is_empty());
    }

    #[test]
    fn startup_rejects_history_errors_and_unsafe_session_paths() {
        for body in [
            json!({ "data": [{ "id": "ses_old" }] }),
            json!({ "error": "unavailable" }),
            json!({ "data": { "ses_idle": { "type": "idle" } } }),
            json!({ "data": { "ses/../../config": { "type": "running" } } }),
        ] {
            assert!(active_ids(&body).is_err());
        }
    }
}
