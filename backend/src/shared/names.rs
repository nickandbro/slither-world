pub const MAX_PLAYER_NAME_LENGTH: usize = 20;

pub fn sanitize_player_name(name: &str, fallback: &str) -> String {
    let cleaned = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.is_empty() {
        return fallback.to_string();
    }
    cleaned.chars().take(MAX_PLAYER_NAME_LENGTH).collect()
}
