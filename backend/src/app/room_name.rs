pub fn sanitize_room_name(value: &str) -> String {
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
