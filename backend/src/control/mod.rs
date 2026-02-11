mod cloud_init;
mod hetzner;
mod token;

use crate::control::cloud_init::{build_room_cloud_init, RoomCloudInitConfig};
use crate::control::hetzner::{CreateServerParams, HetznerClient};
use crate::control::token::{sign_room_token, RoomTokenClaims};
use anyhow::{bail, Context};
use axum::{
    extract::{Query, State},
    http::{HeaderMap, Method, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tower_http::cors::{Any, CorsLayer};

const ROOM_LABEL_SELECTOR: &str = "app=spherical-snake-room,managed_by=snake-control";

#[derive(Clone)]
pub struct ControlState {
    config: Arc<ControlConfig>,
    registry: Arc<Mutex<RoomRegistry>>,
    hetzner: HetznerClient,
    provision_lock: Arc<Mutex<()>>,
    http: reqwest::Client,
}

#[derive(Debug, Clone)]
struct ControlConfig {
    capacity: usize,
    min_warm_rooms: usize,
    idle_scale_down_secs: i64,
    token_ttl_secs: i64,
    room_port: u16,
    room_firewall_ids: Vec<i64>,
    room_image: String,
    room_registry_username: Option<String>,
    room_registry_password: Option<String>,
    hetzner_location: String,
    hetzner_server_type: String,
    hetzner_image: String,
    control_plane_url: String,
    room_heartbeat_token: String,
    room_token_secret: String,
    room_proxy_secret: String,
}

#[derive(Debug, Default)]
struct RoomRegistry {
    rooms: HashMap<String, RoomRecord>,
}

#[derive(Debug, Clone, Serialize)]
struct RoomRecord {
    #[serde(rename = "roomId")]
    room_id: String,
    #[serde(rename = "serverId")]
    server_id: i64,
    origin: String,
    #[serde(rename = "playerCount")]
    player_count: usize,
    #[serde(rename = "lastHeartbeatAt")]
    last_heartbeat_at: i64,
    #[serde(rename = "lastAssignedAt")]
    last_assigned_at: i64,
}

#[derive(Debug, Deserialize, Default)]
struct MatchmakeRequest {
    #[serde(rename = "preferredRoom")]
    preferred_room: Option<String>,
}

#[derive(Debug, Serialize)]
struct MatchmakeResponse {
    #[serde(rename = "roomId")]
    room_id: String,
    #[serde(rename = "roomToken")]
    room_token: String,
    capacity: usize,
    #[serde(rename = "expiresAt")]
    expires_at: i64,
}

#[derive(Debug, Deserialize)]
struct RoomHeartbeatRequest {
    #[serde(rename = "roomId")]
    room_id: String,
    #[serde(rename = "playerCount")]
    player_count: usize,
    #[serde(rename = "totalSessions")]
    total_sessions: usize,
}

#[derive(Debug, Serialize)]
struct OkResponse {
    ok: bool,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    ok: bool,
    error: String,
}

#[derive(Debug, Serialize)]
struct RoomsResponse {
    rooms: Vec<RoomRecord>,
}

pub async fn run() -> anyhow::Result<()> {
    let config = Arc::new(ControlConfig::from_env()?);
    let state = ControlState {
        config: Arc::clone(&config),
        registry: Arc::new(Mutex::new(RoomRegistry::default())),
        hetzner: HetznerClient::new(
            env::var("HETZNER_API_TOKEN").context("missing HETZNER_API_TOKEN")?,
        ),
        provision_lock: Arc::new(Mutex::new(())),
        http: reqwest::Client::new(),
    };

    if let Err(error) = state.seed_registry_from_hetzner().await {
        tracing::warn!(?error, "failed to seed room registry from hetzner");
    }

    // Seed a warm room as soon as control-plane boots.
    if let Err(error) = state.ensure_min_warm_rooms().await {
        tracing::warn!(?error, "failed to provision initial warm room");
    }

    let reconcile_state = state.clone();
    tokio::spawn(async move {
        loop {
            if let Err(error) = reconcile_state.reconcile().await {
                tracing::warn!(?error, "autoscaler reconcile failed");
            }
            tokio::time::sleep(Duration::from_secs(10)).await;
        }
    });

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST])
        .allow_headers(Any);

    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/matchmake", post(matchmake))
        .route("/internal/room-heartbeat", post(room_heartbeat))
        .route("/internal/rooms", get(list_rooms))
        .layer(cors)
        .with_state(Arc::new(state));

    let port = env::var("PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(8787);
    let address = format!("0.0.0.0:{port}");
    tracing::info!("control-plane listening on {address}");
    let listener = tokio::net::TcpListener::bind(&address).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

impl ControlConfig {
    fn from_env() -> anyhow::Result<Self> {
        Self {
            capacity: env::var("ROOM_CAPACITY")
                .ok()
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(25),
            min_warm_rooms: env::var("MIN_WARM_ROOMS")
                .ok()
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(1),
            idle_scale_down_secs: env::var("ROOM_IDLE_SCALE_DOWN_SECS")
                .ok()
                .and_then(|value| value.parse::<i64>().ok())
                .unwrap_or(180),
            token_ttl_secs: env::var("ROOM_TOKEN_TTL_SECS")
                .ok()
                .and_then(|value| value.parse::<i64>().ok())
                .unwrap_or(90),
            room_port: env::var("ROOM_PORT")
                .ok()
                .and_then(|value| value.parse::<u16>().ok())
                .unwrap_or(8787),
            room_firewall_ids: parse_required_id_list_env("HETZNER_ROOM_FIREWALL_IDS")?,
            room_image: env::var("ROOM_IMAGE").context("missing ROOM_IMAGE")?,
            room_registry_username: env::var("ROOM_REGISTRY_USERNAME")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            room_registry_password: env::var("ROOM_REGISTRY_PASSWORD")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            hetzner_location: env::var("HETZNER_LOCATION").unwrap_or_else(|_| "ash".to_string()),
            hetzner_server_type: env::var("HETZNER_SERVER_TYPE")
                .unwrap_or_else(|_| "cpx11".to_string()),
            hetzner_image: env::var("HETZNER_IMAGE").unwrap_or_else(|_| "ubuntu-24.04".to_string()),
            control_plane_url: env::var("CONTROL_PLANE_URL")
                .context("missing CONTROL_PLANE_URL")?,
            room_heartbeat_token: env::var("ROOM_HEARTBEAT_TOKEN")
                .context("missing ROOM_HEARTBEAT_TOKEN")?,
            room_token_secret: env::var("ROOM_TOKEN_SECRET")
                .context("missing ROOM_TOKEN_SECRET")?,
            room_proxy_secret: env::var("ROOM_PROXY_SECRET")
                .context("missing ROOM_PROXY_SECRET")?,
        }
        .validate_registry_auth()
    }
}

impl ControlConfig {
    fn validate_registry_auth(self) -> anyhow::Result<Self> {
        let has_user = self.room_registry_username.is_some();
        let has_pass = self.room_registry_password.is_some();
        if has_user != has_pass {
            bail!("ROOM_REGISTRY_USERNAME and ROOM_REGISTRY_PASSWORD must both be set or both be unset");
        }
        Ok(self)
    }
}

impl ControlState {
    async fn seed_registry_from_hetzner(&self) -> anyhow::Result<()> {
        let servers = self
            .hetzner
            .list_servers_by_label(ROOM_LABEL_SELECTOR)
            .await?;
        if servers.is_empty() {
            return Ok(());
        }

        let now = now_millis();
        let mut registry = self.registry.lock().await;
        for server in servers {
            let Some(room_id) = server.labels.get("room_id").cloned() else {
                continue;
            };
            if registry.rooms.contains_key(&room_id) {
                continue;
            }
            let Some(ip) = server
                .public_net
                .as_ref()
                .and_then(|public_net| public_net.ipv4.as_ref())
                .and_then(|ipv4| ipv4.ip.as_ref())
                .cloned()
            else {
                continue;
            };
            registry.rooms.insert(
                room_id.clone(),
                RoomRecord {
                    room_id,
                    server_id: server.id,
                    origin: format!("http://{}:{}", ip, self.config.room_port),
                    player_count: 0,
                    last_heartbeat_at: now,
                    last_assigned_at: now,
                },
            );
        }
        Ok(())
    }

    async fn assign_room(&self, preferred_room: Option<String>) -> anyhow::Result<RoomRecord> {
        if let Some(room) = self.reserve_ready_room(preferred_room.as_deref()).await {
            return Ok(room);
        }

        let _guard = self.provision_lock.lock().await;
        if let Some(room) = self.reserve_ready_room(preferred_room.as_deref()).await {
            return Ok(room);
        }

        let room = self.provision_room().await?;
        let mut registry = self.registry.lock().await;
        let record = registry
            .rooms
            .get_mut(&room.room_id)
            .context("provisioned room missing from registry")?;
        record.player_count = record.player_count.saturating_add(1);
        record.last_assigned_at = now_millis();
        Ok(record.clone())
    }

    async fn reserve_ready_room(&self, preferred_room: Option<&str>) -> Option<RoomRecord> {
        let now = now_millis();
        let mut registry = self.registry.lock().await;

        if let Some(preferred_room) = preferred_room {
            if let Some(record) = registry.rooms.get_mut(preferred_room) {
                if record.player_count < self.config.capacity {
                    record.player_count = record.player_count.saturating_add(1);
                    record.last_assigned_at = now;
                    return Some(record.clone());
                }
            }
        }

        let next_room_id = registry
            .rooms
            .values()
            .filter(|record| record.player_count < self.config.capacity)
            .min_by_key(|record| record.player_count)
            .map(|record| record.room_id.clone())?;

        let record = registry.rooms.get_mut(&next_room_id)?;
        record.player_count = record.player_count.saturating_add(1);
        record.last_assigned_at = now;
        Some(record.clone())
    }

    async fn provision_room(&self) -> anyhow::Result<RoomRecord> {
        let room_id = format!("room-{}", uuid::Uuid::new_v4().simple());
        let server_name = format!("snake-{room_id}");
        let user_data = build_room_cloud_init(&RoomCloudInitConfig {
            image: &self.config.room_image,
            registry_username: self.config.room_registry_username.as_deref(),
            registry_password: self.config.room_registry_password.as_deref(),
            room_id: &room_id,
            control_plane_url: &self.config.control_plane_url,
            heartbeat_token: &self.config.room_heartbeat_token,
            room_proxy_secret: &self.config.room_proxy_secret,
            max_human_players: self.config.capacity,
            port: self.config.room_port,
        });
        let mut labels = HashMap::new();
        labels.insert("app".to_string(), "spherical-snake-room".to_string());
        labels.insert("managed_by".to_string(), "snake-control".to_string());
        labels.insert("room_id".to_string(), room_id.clone());

        tracing::info!(room_id, "provisioning room server");
        let created = self
            .hetzner
            .create_server(&CreateServerParams {
                name: &server_name,
                server_type: &self.config.hetzner_server_type,
                image: &self.config.hetzner_image,
                location: &self.config.hetzner_location,
                firewall_ids: &self.config.room_firewall_ids,
                labels,
                user_data: &user_data,
            })
            .await?;

        if let Some(action_id) = created.action_id {
            self.hetzner
                .wait_for_action(action_id, Duration::from_secs(300))
                .await
                .with_context(|| format!("room {room_id} create action failed"))?;
        }

        let origin = match self.wait_for_server_origin(created.server_id).await {
            Ok(origin) => origin,
            Err(error) => {
                tracing::warn!(
                    room_id,
                    server_id = created.server_id,
                    ?error,
                    "failed to resolve room origin, deleting server"
                );
                let _ = self.safe_delete_server(created.server_id).await;
                return Err(error);
            }
        };

        let now = now_millis();
        let record = RoomRecord {
            room_id: room_id.clone(),
            server_id: created.server_id,
            origin,
            player_count: 0,
            last_heartbeat_at: now,
            last_assigned_at: now,
        };
        self.registry
            .lock()
            .await
            .rooms
            .insert(room_id.clone(), record.clone());
        tracing::info!(room_id, server_id = created.server_id, "room server ready");
        Ok(record)
    }

    async fn wait_for_server_origin(&self, server_id: i64) -> anyhow::Result<String> {
        let started = std::time::Instant::now();
        let max_wait = Duration::from_secs(240);
        loop {
            if started.elapsed() > max_wait {
                bail!("timed out waiting for room server {server_id} public ip");
            }
            let server = self.hetzner.get_server(server_id).await?;
            let ipv4 = server
                .public_net
                .as_ref()
                .and_then(|public_net| public_net.ipv4.as_ref())
                .and_then(|ipv4| ipv4.ip.as_ref())
                .cloned();

            if let Some(ip) = ipv4 {
                let origin = format!("http://{}:{}", ip, self.config.room_port);
                if self.is_room_healthy(&origin).await {
                    return Ok(origin);
                }
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }

    async fn is_room_healthy(&self, origin: &str) -> bool {
        let endpoint = format!("{}/api/health", origin.trim_end_matches('/'));
        let response = self
            .http
            .get(endpoint)
            .timeout(Duration::from_secs(2))
            .send()
            .await;
        matches!(response, Ok(result) if result.status().is_success())
    }

    async fn reconcile(&self) -> anyhow::Result<()> {
        self.ensure_min_warm_rooms().await?;
        self.scale_down_idle_room().await?;
        Ok(())
    }

    async fn ensure_min_warm_rooms(&self) -> anyhow::Result<()> {
        loop {
            let available = self
                .registry
                .lock()
                .await
                .rooms
                .values()
                .filter(|record| record.player_count < self.config.capacity)
                .count();
            if available >= self.config.min_warm_rooms {
                return Ok(());
            }

            let _guard = self.provision_lock.lock().await;
            let available_after_lock = self
                .registry
                .lock()
                .await
                .rooms
                .values()
                .filter(|record| record.player_count < self.config.capacity)
                .count();
            if available_after_lock >= self.config.min_warm_rooms {
                return Ok(());
            }
            self.provision_room().await?;
        }
    }

    async fn scale_down_idle_room(&self) -> anyhow::Result<()> {
        let now = now_millis();
        let idle_cutoff = now - self.config.idle_scale_down_secs * 1000;
        let candidate = {
            let mut registry = self.registry.lock().await;
            if registry.rooms.len() <= self.config.min_warm_rooms {
                return Ok(());
            }
            let room_id = registry
                .rooms
                .values()
                .filter(|record| record.player_count == 0)
                .filter(|record| record.last_heartbeat_at <= idle_cutoff)
                .filter(|record| record.last_assigned_at <= idle_cutoff)
                .min_by_key(|record| record.last_assigned_at)
                .map(|record| record.room_id.clone());
            room_id.and_then(|room_id| registry.rooms.remove(&room_id))
        };

        let Some(record) = candidate else {
            return Ok(());
        };
        let room_id = record.room_id.clone();

        tracing::info!(
            room_id,
            server_id = record.server_id,
            "scaling down idle room"
        );
        if let Err(error) = self.safe_delete_server(record.server_id).await {
            tracing::warn!(
                room_id,
                server_id = record.server_id,
                ?error,
                "failed to delete idle room server, reinserting room"
            );
            self.registry.lock().await.rooms.insert(room_id, record);
        }
        Ok(())
    }

    async fn safe_delete_server(&self, server_id: i64) -> anyhow::Result<()> {
        let action_id = self.hetzner.delete_server(server_id).await?;
        if let Some(action_id) = action_id {
            self.hetzner
                .wait_for_action(action_id, Duration::from_secs(300))
                .await?;
        }
        Ok(())
    }

    async fn update_heartbeat(&self, payload: &RoomHeartbeatRequest) {
        let now = now_millis();
        let mut registry = self.registry.lock().await;
        if let Some(record) = registry.rooms.get_mut(&payload.room_id) {
            record.player_count = payload.player_count;
            if payload.player_count > 0 || payload.total_sessions > 0 {
                record.last_heartbeat_at = now;
            }
        } else {
            tracing::warn!(
                room_id = payload.room_id,
                total_sessions = payload.total_sessions,
                "received heartbeat for unknown room"
            );
        }
    }
}

async fn health() -> impl IntoResponse {
    Json(OkResponse { ok: true })
}

async fn matchmake(
    State(state): State<Arc<ControlState>>,
    payload: Result<Json<MatchmakeRequest>, axum::extract::rejection::JsonRejection>,
) -> impl IntoResponse {
    let Json(payload) = match payload {
        Ok(payload) => payload,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    ok: false,
                    error: "Invalid JSON".to_string(),
                }),
            )
                .into_response();
        }
    };

    let preferred_room = payload
        .preferred_room
        .as_deref()
        .map(sanitize_room_name)
        .filter(|value| !value.is_empty());

    let room = match state.assign_room(preferred_room).await {
        Ok(room) => room,
        Err(error) => {
            tracing::error!(?error, "matchmake failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    ok: false,
                    error: "Failed to assign room".to_string(),
                }),
            )
                .into_response();
        }
    };

    let expires_at = now_millis() + state.config.token_ttl_secs * 1000;
    let claims = RoomTokenClaims {
        room_id: room.room_id.clone(),
        origin: room.origin,
        expires_at_ms: expires_at,
    };
    let room_token = match sign_room_token(&claims, &state.config.room_token_secret) {
        Ok(token) => token,
        Err(error) => {
            tracing::error!(?error, "failed to sign room token");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    ok: false,
                    error: "Failed to issue room token".to_string(),
                }),
            )
                .into_response();
        }
    };

    (
        StatusCode::OK,
        Json(MatchmakeResponse {
            room_id: claims.room_id,
            room_token,
            capacity: state.config.capacity,
            expires_at,
        }),
    )
        .into_response()
}

async fn room_heartbeat(
    State(state): State<Arc<ControlState>>,
    headers: HeaderMap,
    payload: Result<Json<RoomHeartbeatRequest>, axum::extract::rejection::JsonRejection>,
) -> impl IntoResponse {
    if bearer_token(&headers) != Some(state.config.room_heartbeat_token.as_str()) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                ok: false,
                error: "Unauthorized".to_string(),
            }),
        )
            .into_response();
    }

    let Json(payload) = match payload {
        Ok(payload) => payload,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse {
                    ok: false,
                    error: "Invalid JSON".to_string(),
                }),
            )
                .into_response();
        }
    };

    state.update_heartbeat(&payload).await;
    (StatusCode::OK, Json(OkResponse { ok: true })).into_response()
}

async fn list_rooms(
    State(state): State<Arc<ControlState>>,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    if let Some(expected_token) = params.get("token") {
        if expected_token != &state.config.room_heartbeat_token {
            return (
                StatusCode::UNAUTHORIZED,
                Json(ErrorResponse {
                    ok: false,
                    error: "Unauthorized".to_string(),
                }),
            )
                .into_response();
        }
    } else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                ok: false,
                error: "Unauthorized".to_string(),
            }),
        )
            .into_response();
    }

    let rooms = state
        .registry
        .lock()
        .await
        .rooms
        .values()
        .cloned()
        .collect::<Vec<_>>();
    (StatusCode::OK, Json(RoomsResponse { rooms })).into_response()
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let authorization = headers.get("authorization")?;
    let value = authorization.to_str().ok()?;
    value.strip_prefix("Bearer ").map(str::trim)
}

fn sanitize_room_name(value: &str) -> String {
    let mut cleaned = String::with_capacity(value.len().min(64));
    for ch in value.chars() {
        if cleaned.len() >= 64 {
            break;
        }
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            cleaned.push(ch);
        }
    }
    cleaned
}

fn parse_required_id_list_env(var_name: &str) -> anyhow::Result<Vec<i64>> {
    let raw = env::var(var_name).with_context(|| format!("missing {var_name}"))?;
    parse_id_list(var_name, &raw)
}

fn parse_id_list(var_name: &str, raw: &str) -> anyhow::Result<Vec<i64>> {
    let mut ids = Vec::new();
    for token in raw.split(',') {
        let trimmed = token.trim();
        if trimmed.is_empty() {
            bail!("{var_name} contains an empty id segment");
        }
        let id = trimmed
            .parse::<i64>()
            .with_context(|| format!("{var_name} has invalid id '{trimmed}'"))?;
        if id <= 0 {
            bail!("{var_name} must contain only positive integer IDs");
        }
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    if ids.is_empty() {
        bail!("{var_name} must contain at least one firewall id");
    }
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::{parse_id_list, sanitize_room_name};

    #[test]
    fn sanitize_room_name_preserves_generated_room_ids() {
        let room_id = "room-e0d805ef307540a0b0315c6a8f787d47";
        assert_eq!(sanitize_room_name(room_id), room_id);
    }

    #[test]
    fn sanitize_room_name_strips_invalid_chars_and_bounds_length() {
        let source = "room-abc!@#$%^&*()_+[]{}<>?/|`~xyz123456789012345678901234567890";
        let cleaned = sanitize_room_name(source);
        assert!(cleaned
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_'));
        assert!(cleaned.len() <= 64);
    }

    #[test]
    fn parse_id_list_accepts_csv_and_deduplicates() {
        let ids = parse_id_list("HETZNER_ROOM_FIREWALL_IDS", "123, 456,123").unwrap();
        assert_eq!(ids, vec![123, 456]);
    }

    #[test]
    fn parse_id_list_rejects_empty_segment() {
        let error = parse_id_list("HETZNER_ROOM_FIREWALL_IDS", "123,,456")
            .expect_err("empty segment should fail");
        assert!(error.to_string().contains("contains an empty id segment"));
    }

    #[test]
    fn parse_id_list_rejects_non_positive_or_non_numeric() {
        assert!(parse_id_list("HETZNER_ROOM_FIREWALL_IDS", "0").is_err());
        assert!(parse_id_list("HETZNER_ROOM_FIREWALL_IDS", "-1").is_err());
        assert!(parse_id_list("HETZNER_ROOM_FIREWALL_IDS", "abc").is_err());
    }
}

fn now_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
