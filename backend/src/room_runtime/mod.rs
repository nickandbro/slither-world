use crate::game::room::Room;
use crate::transport::ws_session::handle_socket;
use axum::{
    extract::{Path, State, WebSocketUpgrade},
    http::{HeaderMap, Method, StatusCode},
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use serde::Serialize;
use std::env;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};

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

#[derive(Debug, Serialize)]
struct OkResponse {
    ok: bool,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    ok: bool,
    error: String,
}

pub async fn run_room_mode() -> anyhow::Result<()> {
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
        room: if room_id == "main" {
            Arc::new(Room::with_max_human_players(max_human_players))
        } else {
            Arc::new(Room::with_room_id_and_max_human_players(
                room_id.clone(),
                max_human_players,
            ))
        },
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

async fn health() -> impl IntoResponse {
    Json(OkResponse { ok: true })
}
