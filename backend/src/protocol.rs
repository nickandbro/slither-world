use crate::game::types::Point;
use uuid::Uuid;

pub const VERSION: u8 = 17;

pub const TYPE_JOIN: u8 = 0x01;
pub const TYPE_INPUT: u8 = 0x02;
pub const TYPE_RESPAWN: u8 = 0x03;
pub const TYPE_VIEW: u8 = 0x04;

pub const TYPE_INIT: u8 = 0x10;
pub const TYPE_PLAYER_META: u8 = 0x12;
pub const TYPE_PELLET_DELTA: u8 = 0x13;
pub const TYPE_PELLET_RESET: u8 = 0x14;
pub const TYPE_STATE_DELTA: u8 = 0x15;
pub const TYPE_PELLET_CONSUME: u8 = 0x16;

pub const FLAG_JOIN_PLAYER_ID: u16 = 1 << 0;
pub const FLAG_JOIN_NAME: u16 = 1 << 1;
pub const FLAG_JOIN_DEFER_SPAWN: u16 = 1 << 2;
pub const FLAG_JOIN_SKIN: u16 = 1 << 3;

pub const FLAG_INPUT_AXIS: u16 = 1 << 0;
pub const FLAG_INPUT_BOOST: u16 = 1 << 1;

pub const FLAG_VIEW_CENTER: u16 = 1 << 0;
pub const FLAG_VIEW_RADIUS: u16 = 1 << 1;
pub const FLAG_VIEW_CAMERA_DISTANCE: u16 = 1 << 2;

pub const SNAKE_DETAIL_FULL: u8 = 0;
pub const SNAKE_DETAIL_WINDOW: u8 = 1;
pub const SNAKE_DETAIL_STUB: u8 = 2;

pub const VIEW_RADIUS_MIN: f32 = 0.2;
pub const VIEW_RADIUS_MAX: f32 = 1.4;
pub const VIEW_CAMERA_DISTANCE_MIN: f32 = 4.0;
pub const VIEW_CAMERA_DISTANCE_MAX: f32 = 10.0;

fn dequantize_u16_to_range(value: u16, min: f32, max: f32) -> f32 {
    let t = value as f32 / u16::MAX as f32;
    min + (max - min) * t
}

fn decode_oct_i16_to_point(xq: i16, yq: i16) -> Point {
    let inv = 1.0 / i16::MAX as f64;
    let mut x = xq as f64 * inv;
    let mut y = yq as f64 * inv;
    let z = 1.0 - x.abs() - y.abs();
    let t = (-z).max(0.0);
    x += if x >= 0.0 { -t } else { t };
    y += if y >= 0.0 { -t } else { t };
    let len = (x * x + y * y + z * z).sqrt();
    if !len.is_finite() || len <= 1e-9 {
        return Point {
            x: 0.0,
            y: 0.0,
            z: 1.0,
        };
    }
    let inv_len = 1.0 / len;
    Point {
        x: x * inv_len,
        y: y * inv_len,
        z: z * inv_len,
    }
}

#[derive(Debug)]
pub enum ClientMessage {
    Join {
        name: Option<String>,
        player_id: Option<Uuid>,
        defer_spawn: bool,
        skin: Option<Vec<[u8; 3]>>,
    },
    Respawn,
    Input {
        axis: Option<Point>,
        boost: bool,
    },
    View {
        view_center: Option<Point>,
        view_radius: Option<f32>,
        camera_distance: Option<f32>,
    },
}

pub fn decode_client_message(data: &[u8]) -> Option<ClientMessage> {
    let mut reader = Reader::new(data);
    let version = reader.read_u8()?;
    if version != VERSION {
        return None;
    }
    let message_type = reader.read_u8()?;
    let flags = reader.read_u16()?;
    match message_type {
        TYPE_JOIN => {
            let player_id = if flags & FLAG_JOIN_PLAYER_ID != 0 {
                Some(reader.read_uuid()?)
            } else {
                None
            };
            let name = if flags & FLAG_JOIN_NAME != 0 {
                Some(reader.read_string()?)
            } else {
                None
            };
            let defer_spawn = flags & FLAG_JOIN_DEFER_SPAWN != 0;
            let skin = if flags & FLAG_JOIN_SKIN != 0 {
                let skin_len = reader.read_u8()? as usize;
                let skin_len = skin_len.min(8);
                if skin_len == 0 {
                    None
                } else {
                    let mut out = Vec::with_capacity(skin_len);
                    for _ in 0..skin_len {
                        let rgb = reader.read_bytes::<3>()?;
                        out.push(rgb);
                    }
                    Some(out)
                }
            } else {
                None
            };
            Some(ClientMessage::Join {
                name,
                player_id,
                defer_spawn,
                skin,
            })
        }
        TYPE_RESPAWN => Some(ClientMessage::Respawn),
        TYPE_INPUT => {
            let axis = if flags & FLAG_INPUT_AXIS != 0 {
                let ox = reader.read_i16()?;
                let oy = reader.read_i16()?;
                Some(decode_oct_i16_to_point(ox, oy))
            } else {
                None
            };
            let boost = flags & FLAG_INPUT_BOOST != 0;
            Some(ClientMessage::Input { axis, boost })
        }
        TYPE_VIEW => {
            let view_center = if flags & FLAG_VIEW_CENTER != 0 {
                let ox = reader.read_i16()?;
                let oy = reader.read_i16()?;
                Some(decode_oct_i16_to_point(ox, oy))
            } else {
                None
            };
            let view_radius = if flags & FLAG_VIEW_RADIUS != 0 {
                let q = reader.read_u16()?;
                Some(dequantize_u16_to_range(q, VIEW_RADIUS_MIN, VIEW_RADIUS_MAX))
            } else {
                None
            };
            let camera_distance = if flags & FLAG_VIEW_CAMERA_DISTANCE != 0 {
                let q = reader.read_u16()?;
                Some(dequantize_u16_to_range(
                    q,
                    VIEW_CAMERA_DISTANCE_MIN,
                    VIEW_CAMERA_DISTANCE_MAX,
                ))
            } else {
                None
            };
            Some(ClientMessage::View {
                view_center,
                view_radius,
                camera_distance,
            })
        }
        _ => None,
    }
}

pub struct Encoder {
    buffer: Vec<u8>,
}

impl Encoder {
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            buffer: Vec::with_capacity(capacity),
        }
    }

    pub fn into_vec(self) -> Vec<u8> {
        self.buffer
    }

    pub fn write_header(&mut self, message_type: u8, flags: u16) {
        self.write_u8(VERSION);
        self.write_u8(message_type);
        self.write_u16(flags);
    }

    pub fn write_u8(&mut self, value: u8) {
        self.buffer.push(value);
    }

    pub fn write_u16(&mut self, value: u16) {
        self.buffer.extend_from_slice(&value.to_le_bytes());
    }

    pub fn write_i16(&mut self, value: i16) {
        self.buffer.extend_from_slice(&value.to_le_bytes());
    }

    pub fn write_i32(&mut self, value: i32) {
        self.buffer.extend_from_slice(&value.to_le_bytes());
    }

    pub fn write_u32(&mut self, value: u32) {
        self.buffer.extend_from_slice(&value.to_le_bytes());
    }

    pub fn write_var_u32(&mut self, mut value: u32) {
        while value >= 0x80 {
            self.write_u8(((value & 0x7f) as u8) | 0x80);
            value >>= 7;
        }
        self.write_u8(value as u8);
    }

    pub fn write_var_i32(&mut self, value: i32) {
        let zigzag = ((value << 1) ^ (value >> 31)) as u32;
        self.write_var_u32(zigzag);
    }

    pub fn write_i64(&mut self, value: i64) {
        self.buffer.extend_from_slice(&value.to_le_bytes());
    }

    pub fn write_f32(&mut self, value: f32) {
        self.buffer.extend_from_slice(&value.to_le_bytes());
    }

    pub fn write_uuid(&mut self, value: &[u8; 16]) {
        self.buffer.extend_from_slice(value);
    }

    pub fn write_string(&mut self, value: &str) {
        let bytes = value.as_bytes();
        let mut end = bytes.len().min(u8::MAX as usize);
        while !value.is_char_boundary(end) {
            end = end.saturating_sub(1);
        }
        self.write_u8(end as u8);
        self.buffer.extend_from_slice(&bytes[..end]);
    }
}

struct Reader<'a> {
    data: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, offset: 0 }
    }

    fn read_u8(&mut self) -> Option<u8> {
        let value = *self.data.get(self.offset)?;
        self.offset += 1;
        Some(value)
    }

    fn read_u16(&mut self) -> Option<u16> {
        let bytes = self.read_bytes::<2>()?;
        Some(u16::from_le_bytes(bytes))
    }

    fn read_i16(&mut self) -> Option<i16> {
        let bytes = self.read_bytes::<2>()?;
        Some(i16::from_le_bytes(bytes))
    }

    fn read_uuid(&mut self) -> Option<Uuid> {
        let bytes = self.read_bytes::<16>()?;
        Some(Uuid::from_bytes(bytes))
    }

    fn read_string(&mut self) -> Option<String> {
        let len = self.read_u8()? as usize;
        if self.offset + len > self.data.len() {
            return None;
        }
        let slice = &self.data[self.offset..self.offset + len];
        self.offset += len;
        Some(String::from_utf8_lossy(slice).into_owned())
    }

    fn read_bytes<const N: usize>(&mut self) -> Option<[u8; N]> {
        if self.offset + N > self.data.len() {
            return None;
        }
        let mut out = [0u8; N];
        out.copy_from_slice(&self.data[self.offset..self.offset + N]);
        self.offset += N;
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_join_with_name_and_id() {
        let id = Uuid::new_v4();
        let name = "Player-7";
        let mut encoder = Encoder::with_capacity(64);
        encoder.write_header(TYPE_JOIN, FLAG_JOIN_PLAYER_ID | FLAG_JOIN_NAME);
        encoder.write_uuid(id.as_bytes());
        encoder.write_string(name);
        let data = encoder.into_vec();

        let message = decode_client_message(&data).expect("message");
        match message {
            ClientMessage::Join {
                name,
                player_id,
                defer_spawn,
                skin,
            } => {
                assert_eq!(name.as_deref(), Some("Player-7"));
                assert_eq!(player_id, Some(id));
                assert!(!defer_spawn);
                assert!(skin.is_none());
            }
            _ => panic!("unexpected message"),
        }
    }

    #[test]
    fn decode_join_with_deferred_spawn_flag() {
        let mut encoder = Encoder::with_capacity(16);
        encoder.write_header(TYPE_JOIN, FLAG_JOIN_DEFER_SPAWN);
        let data = encoder.into_vec();

        let message = decode_client_message(&data).expect("message");
        match message {
            ClientMessage::Join {
                name,
                player_id,
                defer_spawn,
                skin,
            } => {
                assert!(name.is_none());
                assert!(player_id.is_none());
                assert!(defer_spawn);
                assert!(skin.is_none());
            }
            _ => panic!("unexpected message"),
        }
    }

    #[test]
    fn decode_join_with_skin_pattern() {
        let mut encoder = Encoder::with_capacity(64);
        encoder.write_header(TYPE_JOIN, FLAG_JOIN_SKIN);
        encoder.write_u8(3);
        encoder.write_u8(0xff);
        encoder.write_u8(0x00);
        encoder.write_u8(0x00);
        encoder.write_u8(0x00);
        encoder.write_u8(0xff);
        encoder.write_u8(0x00);
        encoder.write_u8(0x00);
        encoder.write_u8(0x00);
        encoder.write_u8(0xff);
        let data = encoder.into_vec();

        let message = decode_client_message(&data).expect("message");
        match message {
            ClientMessage::Join {
                name,
                player_id,
                defer_spawn,
                skin,
            } => {
                assert!(name.is_none());
                assert!(player_id.is_none());
                assert!(!defer_spawn);
                let skin = skin.expect("skin");
                assert_eq!(skin.len(), 3);
                assert_eq!(skin[0], [0xff, 0x00, 0x00]);
                assert_eq!(skin[1], [0x00, 0xff, 0x00]);
                assert_eq!(skin[2], [0x00, 0x00, 0xff]);
            }
            _ => panic!("unexpected message"),
        }
    }

    #[test]
    fn decode_input_axis_and_boost() {
        let mut encoder = Encoder::with_capacity(32);
        encoder.write_header(TYPE_INPUT, FLAG_INPUT_AXIS | FLAG_INPUT_BOOST);
        encoder.write_i16(0);
        encoder.write_i16(i16::MAX);
        let data = encoder.into_vec();

        let message = decode_client_message(&data).expect("message");
        match message {
            ClientMessage::Input { axis, boost } => {
                let axis = axis.expect("axis");
                assert!(boost);
                assert!(axis.x.abs() < 1e-3);
                assert!((axis.y - 1.0).abs() < 1e-3);
                assert!(axis.z.abs() < 1e-3);
            }
            _ => panic!("unexpected message"),
        }
    }

    #[test]
    fn decode_view_message() {
        let mut encoder = Encoder::with_capacity(64);
        encoder.write_header(
            TYPE_VIEW,
            FLAG_VIEW_CENTER | FLAG_VIEW_RADIUS | FLAG_VIEW_CAMERA_DISTANCE,
        );
        encoder.write_i16(0);
        encoder.write_i16(0);
        encoder.write_u16(u16::MAX / 2);
        encoder.write_u16(u16::MAX / 2);
        let data = encoder.into_vec();

        let message = decode_client_message(&data).expect("message");
        match message {
            ClientMessage::View {
                view_center,
                view_radius,
                camera_distance,
            } => {
                let view_center = view_center.expect("view_center");
                assert!(view_center.x.abs() < 1e-3);
                assert!(view_center.y.abs() < 1e-3);
                assert!((view_center.z - 1.0).abs() < 1e-3);

                let expected_radius = VIEW_RADIUS_MIN + (VIEW_RADIUS_MAX - VIEW_RADIUS_MIN) * 0.5;
                let expected_camera = VIEW_CAMERA_DISTANCE_MIN
                    + (VIEW_CAMERA_DISTANCE_MAX - VIEW_CAMERA_DISTANCE_MIN) * 0.5;
                assert!((view_radius.expect("view_radius") - expected_radius).abs() < 0.01);
                assert!((camera_distance.expect("camera_distance") - expected_camera).abs() < 0.01);
            }
            _ => panic!("unexpected message"),
        }
    }
}
