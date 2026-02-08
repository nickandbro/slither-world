pub use crate::shared::room_token::{sign_room_token, RoomTokenClaims};

#[cfg(test)]
mod tests {
    use super::{sign_room_token, RoomTokenClaims};

    #[test]
    fn sign_room_token_returns_two_part_token() {
        let claims = RoomTokenClaims {
            room_id: "room-1".to_string(),
            origin: "http://127.0.0.1:8787".to_string(),
            expires_at_ms: 12345,
        };
        let token = sign_room_token(&claims, "secret").expect("token should be signed");
        let mut parts = token.split('.');
        assert!(parts.next().is_some());
        assert!(parts.next().is_some());
        assert!(parts.next().is_none());
    }
}
