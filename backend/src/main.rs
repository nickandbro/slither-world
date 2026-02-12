use std::env;
use tracing_subscriber::EnvFilter;

mod app;
mod control;
mod game;
mod protocol;
mod room_runtime;
mod shared;
mod standalone;
mod transport;

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
        "room" => room_runtime::run_room_mode().await,
        _ => standalone::run_standalone().await,
    }
}
