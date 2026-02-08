pub struct RoomCloudInitConfig<'a> {
    pub image: &'a str,
    pub registry_username: Option<&'a str>,
    pub registry_password: Option<&'a str>,
    pub room_id: &'a str,
    pub control_plane_url: &'a str,
    pub heartbeat_token: &'a str,
    pub room_proxy_secret: &'a str,
    pub max_human_players: usize,
    pub port: u16,
}

pub fn build_room_cloud_init(config: &RoomCloudInitConfig<'_>) -> String {
    let image = shell_escape(config.image);
    let registry_username = config.registry_username.map(shell_escape);
    let registry_password = config.registry_password.map(shell_escape);
    let room_id = shell_escape(config.room_id);
    let control_plane_url = shell_escape(config.control_plane_url);
    let heartbeat_token = shell_escape(config.heartbeat_token);
    let room_proxy_secret = shell_escape(config.room_proxy_secret);
    let port = config.port;
    let max_human_players = config.max_human_players;

    let login_lines = match (registry_username, registry_password) {
        (Some(user), Some(pass)) => {
            format!("  - echo {pass} | docker login ghcr.io -u {user} --password-stdin\n",)
        }
        _ => String::new(),
    };

    format!(
        r#"#cloud-config
package_update: true
packages:
  - docker.io
runcmd:
  - systemctl enable --now docker
{login_lines}
  - docker pull {image}
  - docker rm -f snake-room || true
  - >
    docker run -d --name snake-room --restart unless-stopped
    -p {port}:{port}
    -e SNAKE_ROLE=room
    -e PORT={port}
    -e ROOM_ID={room_id}
    -e MAX_HUMAN_PLAYERS={max_human_players}
    -e CONTROL_PLANE_URL={control_plane_url}
    -e ROOM_HEARTBEAT_TOKEN={heartbeat_token}
    -e ROOM_PROXY_SECRET={room_proxy_secret}
    {image}
"#,
    )
}

fn shell_escape(value: &str) -> String {
    let escaped = value.replace('\'', "'\"'\"'");
    format!("'{escaped}'")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloud_init_contains_room_and_image() {
        let script = build_room_cloud_init(&RoomCloudInitConfig {
            image: "ghcr.io/example/snake:latest",
            registry_username: None,
            registry_password: None,
            room_id: "room-abc",
            control_plane_url: "https://control.example.com",
            heartbeat_token: "heart",
            room_proxy_secret: "proxy",
            max_human_players: 25,
            port: 8787,
        });
        assert!(script.contains("ROOM_ID='room-abc'"));
        assert!(script.contains("ghcr.io/example/snake:latest"));
    }

    #[test]
    fn cloud_init_includes_registry_login_when_credentials_present() {
        let script = build_room_cloud_init(&RoomCloudInitConfig {
            image: "ghcr.io/example/snake:latest",
            registry_username: Some("user"),
            registry_password: Some("pass"),
            room_id: "room-auth",
            control_plane_url: "https://control.example.com",
            heartbeat_token: "heart",
            room_proxy_secret: "proxy",
            max_human_players: 25,
            port: 8787,
        });
        assert!(script.contains("docker login ghcr.io"));
    }

    #[test]
    fn cloud_init_does_not_emit_stray_backslash_line() {
        let script = build_room_cloud_init(&RoomCloudInitConfig {
            image: "ghcr.io/example/snake:latest",
            registry_username: Some("user"),
            registry_password: Some("pass"),
            room_id: "room-auth",
            control_plane_url: "https://control.example.com",
            heartbeat_token: "heart",
            room_proxy_secret: "proxy",
            max_human_players: 25,
            port: 8787,
        });
        assert!(!script.contains("\n\\\n"));
    }
}
