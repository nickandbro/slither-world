use anyhow::Context;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomTokenClaims {
    #[serde(rename = "roomId")]
    pub room_id: String,
    pub origin: String,
    #[serde(rename = "exp")]
    pub expires_at_ms: i64,
}

pub fn sign_room_token(claims: &RoomTokenClaims, secret: &str) -> anyhow::Result<String> {
    let payload = serde_json::to_vec(claims).context("failed to serialize room token claims")?;
    let payload_b64 = URL_SAFE_NO_PAD.encode(payload);

    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .context("failed to initialize room token signer")?;
    mac.update(payload_b64.as_bytes());
    let signature = mac.finalize().into_bytes();
    let signature_b64 = URL_SAFE_NO_PAD.encode(signature);

    Ok(format!("{payload_b64}.{signature_b64}"))
}

#[cfg(test)]
mod tests {
    use super::*;

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
