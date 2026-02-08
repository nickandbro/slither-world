use anyhow::{anyhow, bail, Context};
use reqwest::Method;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::{Duration, Instant};

const DEFAULT_BASE_URL: &str = "https://api.hetzner.cloud/v1";

#[derive(Clone)]
pub struct HetznerClient {
    http: reqwest::Client,
    token: String,
    base_url: String,
}

pub struct CreateServerParams<'a> {
    pub name: &'a str,
    pub server_type: &'a str,
    pub image: &'a str,
    pub location: &'a str,
    pub firewall_ids: &'a [i64],
    pub labels: HashMap<String, String>,
    pub user_data: &'a str,
}

#[derive(Debug, Clone)]
pub struct CreatedServer {
    pub server_id: i64,
    pub action_id: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Server {
    pub id: i64,
    #[serde(default)]
    pub labels: HashMap<String, String>,
    #[serde(default)]
    pub public_net: Option<PublicNet>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PublicNet {
    #[serde(default)]
    pub ipv4: Option<ServerIpv4>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ServerIpv4 {
    #[serde(default)]
    pub ip: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Action {
    pub id: i64,
    pub status: String,
    #[serde(default)]
    pub error: Option<ActionError>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ActionError {
    pub code: String,
    pub message: String,
}

impl HetznerClient {
    pub fn new(token: String) -> Self {
        Self {
            http: reqwest::Client::new(),
            token,
            base_url: DEFAULT_BASE_URL.to_string(),
        }
    }

    pub async fn create_server(
        &self,
        params: &CreateServerParams<'_>,
    ) -> anyhow::Result<CreatedServer> {
        let mut body = json!({
            "name": params.name,
            "server_type": params.server_type,
            "image": params.image,
            "location": params.location,
            "start_after_create": true,
            "labels": params.labels,
            "user_data": params.user_data,
        });
        if !params.firewall_ids.is_empty() {
            let firewalls = params
                .firewall_ids
                .iter()
                .copied()
                .map(|firewall_id| json!({ "firewall": firewall_id }))
                .collect::<Vec<_>>();
            body["firewalls"] = Value::Array(firewalls);
        }

        let response: CreateServerResponse = self
            .request_json(Method::POST, "/servers", Some(body), None)
            .await
            .context("failed to create hetzner server")?;

        Ok(CreatedServer {
            server_id: response.server.id,
            action_id: response.action.map(|action| action.id),
        })
    }

    pub async fn get_server(&self, server_id: i64) -> anyhow::Result<Server> {
        let response: GetServerResponse = self
            .request_json(Method::GET, &format!("/servers/{server_id}"), None, None)
            .await
            .with_context(|| format!("failed to get hetzner server {server_id}"))?;
        Ok(response.server)
    }

    pub async fn list_servers_by_label(&self, label_selector: &str) -> anyhow::Result<Vec<Server>> {
        let mut all_servers = Vec::new();
        let mut page = 1i64;
        loop {
            let query = vec![
                ("label_selector", label_selector.to_string()),
                ("per_page", "50".to_string()),
                ("page", page.to_string()),
            ];
            let response: ListServersResponse = self
                .request_json(Method::GET, "/servers", None, Some(&query))
                .await
                .context("failed to list hetzner servers")?;

            all_servers.extend(response.servers);
            let next_page = response
                .meta
                .and_then(|meta| meta.pagination)
                .and_then(|pagination| pagination.next_page);
            match next_page {
                Some(next) => page = next,
                None => break,
            }
        }
        Ok(all_servers)
    }

    pub async fn delete_server(&self, server_id: i64) -> anyhow::Result<Option<i64>> {
        let response: DeleteServerResponse = self
            .request_json(Method::DELETE, &format!("/servers/{server_id}"), None, None)
            .await
            .with_context(|| format!("failed to delete hetzner server {server_id}"))?;
        Ok(response.action.map(|action| action.id))
    }

    pub async fn get_action(&self, action_id: i64) -> anyhow::Result<Action> {
        let response: GetActionResponse = self
            .request_json(Method::GET, &format!("/actions/{action_id}"), None, None)
            .await
            .with_context(|| format!("failed to get hetzner action {action_id}"))?;
        Ok(response.action)
    }

    pub async fn wait_for_action(&self, action_id: i64, timeout: Duration) -> anyhow::Result<()> {
        let started = Instant::now();
        loop {
            if started.elapsed() > timeout {
                bail!("hetzner action {action_id} timed out after {:?}", timeout);
            }
            let action = self.get_action(action_id).await?;
            match action.status.as_str() {
                "success" => return Ok(()),
                "error" => {
                    let error = action
                        .error
                        .map(|err| format!("{}: {}", err.code, err.message))
                        .unwrap_or_else(|| "unknown action error".to_string());
                    bail!("hetzner action {action_id} failed: {error}");
                }
                _ => tokio::time::sleep(Duration::from_secs(2)).await,
            }
        }
    }

    async fn request_json<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        query: Option<&Vec<(&str, String)>>,
    ) -> anyhow::Result<T> {
        let url = format!("{}{}", self.base_url.trim_end_matches('/'), path);
        let mut request = self
            .http
            .request(method, &url)
            .bearer_auth(&self.token)
            .header("Content-Type", "application/json");
        if let Some(query) = query {
            request = request.query(query);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .await
            .with_context(|| format!("hetzner api request failed for {url}"))?;
        decode_response(response).await
    }
}

async fn decode_response<T: DeserializeOwned>(response: reqwest::Response) -> anyhow::Result<T> {
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        if let Ok(error) = serde_json::from_str::<HetznerErrorResponse>(&body) {
            bail!(
                "hetzner api error {} {}: {}",
                status.as_u16(),
                error.error.code,
                error.error.message
            );
        }
        bail!("hetzner api error {}: {}", status.as_u16(), body);
    }
    response
        .json::<T>()
        .await
        .map_err(|error| anyhow!("failed to decode hetzner response: {error}"))
}

#[derive(Debug, Deserialize)]
struct CreateServerResponse {
    server: Server,
    #[serde(default)]
    action: Option<Action>,
}

#[derive(Debug, Deserialize)]
struct GetServerResponse {
    server: Server,
}

#[derive(Debug, Deserialize)]
struct ListServersResponse {
    #[serde(default)]
    servers: Vec<Server>,
    #[serde(default)]
    meta: Option<ListMeta>,
}

#[derive(Debug, Deserialize)]
struct ListMeta {
    #[serde(default)]
    pagination: Option<Pagination>,
}

#[derive(Debug, Deserialize)]
struct Pagination {
    #[serde(default)]
    next_page: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct DeleteServerResponse {
    #[serde(default)]
    action: Option<Action>,
}

#[derive(Debug, Deserialize)]
struct GetActionResponse {
    action: Action,
}

#[derive(Debug, Deserialize)]
struct HetznerErrorResponse {
    error: HetznerErrorBody,
}

#[derive(Debug, Deserialize)]
struct HetznerErrorBody {
    code: String,
    message: String,
}
