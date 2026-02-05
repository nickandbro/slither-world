use crate::game::types::Point;
use uuid::Uuid;

pub const VERSION: u8 = 3;

pub const TYPE_JOIN: u8 = 0x01;
pub const TYPE_INPUT: u8 = 0x02;
pub const TYPE_RESPAWN: u8 = 0x03;

pub const TYPE_INIT: u8 = 0x10;
pub const TYPE_STATE: u8 = 0x11;
pub const TYPE_PLAYER_META: u8 = 0x12;

pub const FLAG_JOIN_PLAYER_ID: u16 = 1 << 0;
pub const FLAG_JOIN_NAME: u16 = 1 << 1;

pub const FLAG_INPUT_AXIS: u16 = 1 << 0;
pub const FLAG_INPUT_BOOST: u16 = 1 << 1;

#[derive(Debug)]
pub enum ClientMessage {
  Join {
    name: Option<String>,
    player_id: Option<Uuid>,
  },
  Respawn,
  Input {
    axis: Option<Point>,
    boost: bool,
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
      Some(ClientMessage::Join { name, player_id })
    }
    TYPE_RESPAWN => Some(ClientMessage::Respawn),
    TYPE_INPUT => {
      let axis = if flags & FLAG_INPUT_AXIS != 0 {
        Some(Point {
          x: reader.read_f32()? as f64,
          y: reader.read_f32()? as f64,
          z: reader.read_f32()? as f64,
        })
      } else {
        None
      };
      let boost = flags & FLAG_INPUT_BOOST != 0;
      Some(ClientMessage::Input { axis, boost })
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

  pub fn write_i32(&mut self, value: i32) {
    self.buffer.extend_from_slice(&value.to_le_bytes());
  }

  pub fn write_u32(&mut self, value: u32) {
    self.buffer.extend_from_slice(&value.to_le_bytes());
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

  fn read_f32(&mut self) -> Option<f32> {
    let bytes = self.read_bytes::<4>()?;
    Some(f32::from_le_bytes(bytes))
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
      ClientMessage::Join { name, player_id } => {
        assert_eq!(name.as_deref(), Some("Player-7"));
        assert_eq!(player_id, Some(id));
      }
      _ => panic!("unexpected message"),
    }
  }

  #[test]
  fn decode_input_axis_and_boost() {
    let mut encoder = Encoder::with_capacity(32);
    encoder.write_header(TYPE_INPUT, FLAG_INPUT_AXIS | FLAG_INPUT_BOOST);
    encoder.write_f32(1.5);
    encoder.write_f32(-2.0);
    encoder.write_f32(0.25);
    let data = encoder.into_vec();

    let message = decode_client_message(&data).expect("message");
    match message {
      ClientMessage::Input { axis, boost } => {
        let axis = axis.expect("axis");
        assert!(boost);
        assert!((axis.x - 1.5).abs() < 1e-6);
        assert!((axis.y + 2.0).abs() < 1e-6);
        assert!((axis.z - 0.25).abs() < 1e-6);
      }
      _ => panic!("unexpected message"),
    }
  }
}
