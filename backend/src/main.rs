use axum::{
    extract::ws::{Message, WebSocket},
    extract::{Path, Query, State, WebSocketUpgrade},
    http::{HeaderMap, Method, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use sqlx::{sqlite::SqlitePoolOptions, Row, SqlitePool};
use std::collections::HashMap;
use std::env;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::mpsc;
use tower_http::cors::{Any, CorsLayer};
use tracing_subscriber::EnvFilter;

mod control;
mod game;
mod protocol;
mod shared;

use game::room::DebugKillTarget;
use game::room::Room;
use shared::room_token::{sign_room_token, RoomTokenClaims};

const MAX_SCORE: i64 = 1_000_000;
const DEFAULT_LIMIT: i64 = 10;
const MAX_LIMIT: i64 = 50;

#[derive(Clone)]
struct AppState {
    rooms: DashMap<String, Arc<Room>>,
    db: SqlitePool,
    debug_commands: bool,
    standalone_matchmake: StandaloneMatchmakeConfig,
}

#[derive(Clone)]
struct StandaloneMatchmakeConfig {
    capacity: usize,
    token_ttl_secs: i64,
    room_origin: String,
    room_token_secret: String,
}

#[derive(Debug, Serialize)]
struct LeaderboardEntry {
    name: String,
    score: i64,
    created_at: i64,
}

#[derive(Debug, Serialize)]
struct LeaderboardResponse {
    scores: Vec<LeaderboardEntry>,
}

#[derive(Debug, Deserialize)]
struct LeaderboardSubmission {
    name: Option<String>,
    score: Option<f64>,
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
struct DebugKillResponse {
    ok: bool,
    #[serde(rename = "playerId")]
    player_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DebugKillQuery {
    room: Option<String>,
    target: Option<String>,
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

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    match env::var("SNAKE_ROLE")
        .unwrap_or_else(|_| "standalone".to_string())
        .as_str()
    {
        "control" => control::run().await,
        "room" => run_room_mode().await,
        _ => run_standalone().await,
    }
}

#[derive(Clone)]
struct RoomModeState {
    room_id: String,
    room: Arc<Room>,
    proxy_secret: Option<String>,
}

#[derive(Debug, Serialize)]
struct RoomHeartbeatPayload {
    #[serde(rename = "roomId")]
    room_id: String,
    #[serde(rename = "playerCount")]
    player_count: usize,
    #[serde(rename = "totalSessions")]
    total_sessions: usize,
}

async fn run_room_mode() -> anyhow::Result<()> {
    let room_id = env::var("ROOM_ID")
        .map(|value| value.trim().to_string())
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "main".to_string());
    let max_human_players = env::var("MAX_HUMAN_PLAYERS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .or(Some(25));
    let proxy_secret = env::var("ROOM_PROXY_SECRET")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let state = Arc::new(RoomModeState {
        room_id: room_id.clone(),
        room: Arc::new(Room::with_max_human_players(max_human_players)),
        proxy_secret,
    });

    if let (Ok(control_plane_url), Ok(heartbeat_token)) = (
        env::var("CONTROL_PLANE_URL"),
        env::var("ROOM_HEARTBEAT_TOKEN"),
    ) {
        let heartbeat_room_id = room_id.clone();
        let heartbeat_room = Arc::clone(&state.room);
        tokio::spawn(async move {
            room_heartbeat_loop(
                heartbeat_room,
                heartbeat_room_id,
                control_plane_url,
                heartbeat_token,
            )
            .await;
        });
    }

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST])
        .allow_headers(Any);
    let app: Router = Router::new()
        .route("/api/health", get(health))
        .route("/api/room/:room", get(room_mode_ws_handler))
        .layer(cors)
        .with_state(state);

    let port: u16 = env::var("PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(8787);
    let address = format!("0.0.0.0:{port}");
    tracing::info!("room-mode listening on {address}");
    let listener = tokio::net::TcpListener::bind(&address).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn room_heartbeat_loop(
    room: Arc<Room>,
    room_id: String,
    control_plane_url: String,
    heartbeat_token: String,
) {
    let endpoint = format!(
        "{}/internal/room-heartbeat",
        control_plane_url.trim_end_matches('/')
    );
    let client = reqwest::Client::new();
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(2));
    loop {
        interval.tick().await;
        let stats = room.stats().await;
        let payload = RoomHeartbeatPayload {
            room_id: room_id.clone(),
            player_count: stats.human_players,
            total_sessions: stats.total_sessions,
        };
        if let Err(error) = client
            .post(&endpoint)
            .header("Authorization", format!("Bearer {heartbeat_token}"))
            .json(&payload)
            .send()
            .await
        {
            tracing::warn!(?error, room_id, "room heartbeat failed");
        }
    }
}

async fn room_mode_ws_handler(
    ws: WebSocketUpgrade,
    Path(room): Path<String>,
    State(state): State<Arc<RoomModeState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let trimmed = room.trim();
    let requested_room = if trimmed.is_empty() { "main" } else { trimmed };
    if requested_room != state.room_id {
        return (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                ok: false,
                error: "Unknown room".to_string(),
            }),
        )
            .into_response();
    }
    if let Some(proxy_secret) = &state.proxy_secret {
        let supplied_secret = headers
            .get("x-room-proxy-secret")
            .and_then(|value| value.to_str().ok());
        if supplied_secret != Some(proxy_secret.as_str()) {
            return (
                StatusCode::UNAUTHORIZED,
                Json(ErrorResponse {
                    ok: false,
                    error: "Unauthorized".to_string(),
                }),
            )
                .into_response();
        }
    }
    let room = Arc::clone(&state.room);
    ws.on_upgrade(move |socket| handle_socket(socket, room))
        .into_response()
}

async fn run_standalone() -> anyhow::Result<()> {
    let port: u16 = env::var("PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(8787);

    let database_url = env::var("DATABASE_URL").unwrap_or_else(|_| {
        let base = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let default_path = base.join("data").join("leaderboard.db");
        format!("sqlite://{}", default_path.display())
    });
    ensure_db_dir(&database_url)?;

    let db = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await?;
    sqlx::migrate!("./migrations").run(&db).await?;

    let debug_commands = env::var("ENABLE_DEBUG_COMMANDS")
        .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE"))
        .unwrap_or(false);

    let matchmake_capacity = env::var("STANDALONE_MATCHMAKE_CAPACITY")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(25);
    let matchmake_token_ttl_secs = env::var("STANDALONE_ROOM_TOKEN_TTL_SECS")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(90);
    let room_origin = env::var("STANDALONE_ROOM_ORIGIN")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("http://localhost:{port}"));
    let room_token_secret = env::var("ROOM_TOKEN_SECRET")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "dev-room-token-secret".to_string());

    let state = Arc::new(AppState {
        rooms: DashMap::new(),
        db,
        debug_commands,
        standalone_matchmake: StandaloneMatchmakeConfig {
            capacity: matchmake_capacity,
            token_ttl_secs: matchmake_token_ttl_secs,
            room_origin,
            room_token_secret,
        },
    });

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST])
        .allow_headers(Any);

    let mut app: Router<Arc<AppState>> = Router::new()
        .route("/api/health", get(health))
        .route("/api/matchmake", post(matchmake_standalone))
        .route(
            "/api/leaderboard",
            get(leaderboard_get).post(leaderboard_post),
        )
        .route("/api/room/:room", get(ws_handler))
        .layer(cors);

    if debug_commands {
        app = app.route("/api/debug/kill", post(debug_kill));
    }

    let app: Router = app.with_state(state);

    let address = format!("0.0.0.0:{port}");
    tracing::info!("listening on {address}");

    let listener = tokio::net::TcpListener::bind(&address).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

impl AppState {
    fn room(&self, name: String) -> Arc<Room> {
        match self.rooms.entry(name) {
            dashmap::mapref::entry::Entry::Occupied(entry) => entry.get().clone(),
            dashmap::mapref::entry::Entry::Vacant(entry) => {
                let room = Arc::new(Room::new());
                entry.insert(room.clone());
                room
            }
        }
    }
}

fn ensure_db_dir(database_url: &str) -> anyhow::Result<()> {
    if database_url.starts_with("sqlite::memory:") {
        return Ok(());
    }
    let path = database_url
        .strip_prefix("sqlite://")
        .or_else(|| database_url.strip_prefix("sqlite:"));
    let Some(path) = path else { return Ok(()) };
    if path.is_empty() || path == ":memory:" {
        return Ok(());
    }
    let db_path = if path.starts_with('/') {
        PathBuf::from(path)
    } else {
        PathBuf::from(path)
    };
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if !db_path.exists() {
        let _ = std::fs::File::create(&db_path)?;
    }
    Ok(())
}

async fn health() -> impl IntoResponse {
    Json(OkResponse { ok: true })
}

async fn matchmake_standalone(
    State(state): State<Arc<AppState>>,
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

    let room_id = payload
        .preferred_room
        .as_deref()
        .map(sanitize_room_name)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "main".to_string());

    let expires_at = current_time_millis() + state.standalone_matchmake.token_ttl_secs * 1000;
    let claims = RoomTokenClaims {
        room_id: room_id.clone(),
        origin: state.standalone_matchmake.room_origin.clone(),
        expires_at_ms: expires_at,
    };
    let room_token = match sign_room_token(&claims, &state.standalone_matchmake.room_token_secret)
    {
        Ok(token) => token,
        Err(error) => {
            tracing::error!(?error, "standalone matchmake token signing failed");
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
            room_id,
            room_token,
            capacity: state.standalone_matchmake.capacity,
            expires_at,
        }),
    )
        .into_response()
}

async fn leaderboard_get(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let limit = params
        .get("limit")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(DEFAULT_LIMIT);
    let limit = limit.clamp(1, MAX_LIMIT);

    let rows = sqlx::query(
        "SELECT name, score, created_at FROM scores ORDER BY score DESC, created_at ASC LIMIT ?",
    )
    .bind(limit)
    .fetch_all(&state.db)
    .await;

    let rows = match rows {
        Ok(rows) => rows,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    ok: false,
                    error: "Failed to load leaderboard".to_string(),
                }),
            )
                .into_response();
        }
    };

    let scores = rows
        .into_iter()
        .filter_map(|row| {
            let name: String = row.try_get("name").ok()?;
            let score: i64 = row.try_get("score").ok()?;
            let created_at: i64 = row.try_get("created_at").ok()?;
            Some(LeaderboardEntry {
                name,
                score,
                created_at,
            })
        })
        .collect::<Vec<_>>();

    (StatusCode::OK, Json(LeaderboardResponse { scores })).into_response()
}

async fn debug_kill(
    State(state): State<Arc<AppState>>,
    Query(params): Query<DebugKillQuery>,
) -> impl IntoResponse {
    if !state.debug_commands {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                ok: false,
                error: "Debug commands disabled".to_string(),
            }),
        )
            .into_response();
    }

    let room_name = params.room.unwrap_or_else(|| "main".to_string());
    let target = match params.target.as_deref() {
        Some("bot") => DebugKillTarget::Bot,
        Some("human") => DebugKillTarget::Human,
        _ => DebugKillTarget::Any,
    };
    let room = state.room(room_name);

    match room.debug_kill(target).await {
        Some(player_id) => Json(DebugKillResponse {
            ok: true,
            player_id: Some(player_id),
        })
        .into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                ok: false,
                error: "No matching player to kill".to_string(),
            }),
        )
            .into_response(),
    }
}

async fn leaderboard_post(
    State(state): State<Arc<AppState>>,
    payload: Result<Json<LeaderboardSubmission>, axum::extract::rejection::JsonRejection>,
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

    let raw_name = payload.name.unwrap_or_else(|| "Player".to_string());
    let name = shared::names::sanitize_player_name(&raw_name, "Player");
    let score_value = payload.score.unwrap_or(f64::NAN);

    if !score_value.is_finite() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                ok: false,
                error: "Score must be a number".to_string(),
            }),
        )
            .into_response();
    }

    let score = score_value.floor() as i64;
    if score < 0 || score > MAX_SCORE {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                ok: false,
                error: "Score out of range".to_string(),
            }),
        )
            .into_response();
    }

    let id = uuid::Uuid::new_v4().to_string();
    let created_at = current_time_millis();

    let result =
        sqlx::query("INSERT INTO scores (id, name, score, created_at) VALUES (?, ?, ?, ?)")
            .bind(id)
            .bind(name)
            .bind(score)
            .bind(created_at)
            .execute(&state.db)
            .await;

    if result.is_err() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                ok: false,
                error: "Submission failed".to_string(),
            }),
        )
            .into_response();
    }

    (StatusCode::OK, Json(OkResponse { ok: true })).into_response()
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Path(room): Path<String>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let trimmed = room.trim();
    let room_name = if trimmed.is_empty() { "main" } else { trimmed }.to_string();
    let room = state.room(room_name);
    ws.on_upgrade(move |socket| handle_socket(socket, room))
}

async fn handle_socket(socket: WebSocket, room: Arc<Room>) {
    let (mut sender, mut receiver) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let session_id = room.add_session(tx).await;

    let send_task = tokio::spawn(async move {
        while let Some(payload) = rx.recv().await {
            if sender.send(Message::Binary(payload)).await.is_err() {
                break;
            }
        }
    });

    while let Some(result) = receiver.next().await {
        let Ok(message) = result else { break };
        match message {
            Message::Binary(data) => {
                if !room.handle_binary_message(&session_id, &data).await {
                    break;
                }
            }
            Message::Text(text) => {
                if !room.handle_text_message(&session_id, &text).await {
                    break;
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    room.remove_session(&session_id).await;
    send_task.abort();
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

fn current_time_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
