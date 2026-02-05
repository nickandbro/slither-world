use super::constants::{DIGESTION_GROWTH_STEPS, DIGESTION_TRAVEL_SPEED_MULT, NODE_QUEUE_SIZE};
use super::math::clamp;
use super::snake::add_snake_node;
use super::types::{Digestion, Player};

pub fn add_digestion(player: &mut Player) {
  let travel_steps = (((player.snake.len().saturating_sub(1)) * NODE_QUEUE_SIZE) as f64
    / DIGESTION_TRAVEL_SPEED_MULT)
    .round()
    .max(1.0) as i64;
  let total = travel_steps + DIGESTION_GROWTH_STEPS;
  let id = player.next_digestion_id;
  player.next_digestion_id = player.next_digestion_id.wrapping_add(1);
  player.digestions.push(Digestion {
    id,
    remaining: total,
    total,
    growth_steps: DIGESTION_GROWTH_STEPS,
  });
}

pub fn advance_digestions(player: &mut Player, steps: i32) {
  let step_count = steps.max(1) as i32;
  for _ in 0..step_count {
    let mut growth_taken = false;

    let mut i = 0;
    while i < player.digestions.len() {
      let at_tail = player.digestions[i].remaining <= player.digestions[i].growth_steps;
      if at_tail {
        if !growth_taken {
          player.digestions[i].remaining -= 1;
          growth_taken = true;
        } else {
          let growth_steps = player.digestions[i].growth_steps;
          player.digestions[i].remaining = player.digestions[i].remaining.max(growth_steps);
        }
      } else {
        player.digestions[i].remaining -= 1;
      }

      if player.digestions[i].remaining <= 0 {
        add_snake_node(&mut player.snake, player.axis);
        player.digestions.remove(i);
        continue;
      }

      i += 1;
    }
  }
}

pub fn get_digestion_progress(digestion: &Digestion) -> f64 {
  let travel_total = (digestion.total - digestion.growth_steps).max(1) as f64;
  let travel_remaining = (digestion.remaining - digestion.growth_steps).max(0) as f64;
  let travel_progress = clamp(1.0 - travel_remaining / travel_total, 0.0, 1.0);
  let growth_progress = if digestion.remaining <= digestion.growth_steps {
    clamp(1.0 - (digestion.remaining as f64) / (digestion.growth_steps as f64), 0.0, 1.0)
  } else {
    0.0
  };
  travel_progress + growth_progress
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::game::types::{Point, SnakeNode};
  use std::collections::VecDeque;

  fn make_snake(len: usize) -> Vec<SnakeNode> {
    (0..len)
      .map(|index| SnakeNode {
        x: index as f64,
        y: 0.0,
        z: 0.0,
        pos_queue: VecDeque::new(),
      })
      .collect()
  }

  fn make_player() -> Player {
    Player {
      id: "player".to_string(),
      id_bytes: [0u8; 16],
      name: "Player".to_string(),
      color: "#fff".to_string(),
      is_bot: false,
      axis: Point { x: 1.0, y: 0.0, z: 0.0 },
      target_axis: Point { x: 1.0, y: 0.0, z: 0.0 },
      boost: false,
      stamina: 1.0,
      oxygen: 1.0,
      score: 0,
      alive: true,
      connected: true,
      last_seen: 0,
      respawn_at: None,
      snake: make_snake(4),
      next_digestion_id: 0,
      digestions: Vec::new(),
    }
  }

  #[test]
  fn add_digestion_assigns_monotonic_ids() {
    let mut player = make_player();
    add_digestion(&mut player);
    add_digestion(&mut player);
    add_digestion(&mut player);

    assert_eq!(player.next_digestion_id, 3);
    assert_eq!(player.digestions.len(), 3);
    assert_eq!(player.digestions[0].id, 0);
    assert_eq!(player.digestions[1].id, 1);
    assert_eq!(player.digestions[2].id, 2);
  }

  #[test]
  fn advance_digestions_keeps_remaining_ids_when_head_item_completes() {
    let mut player = make_player();
    player.digestions = vec![
      Digestion {
        id: 7,
        remaining: 1,
        total: 1,
        growth_steps: 1,
      },
      Digestion {
        id: 9,
        remaining: 4,
        total: 4,
        growth_steps: 1,
      },
    ];

    let previous_len = player.snake.len();
    advance_digestions(&mut player, 1);

    assert_eq!(player.snake.len(), previous_len + 1);
    assert_eq!(player.digestions.len(), 1);
    assert_eq!(player.digestions[0].id, 9);
    assert_eq!(player.digestions[0].remaining, 3);
  }

  #[test]
  fn add_digestion_id_wraps_after_u32_max() {
    let mut player = make_player();
    player.next_digestion_id = u32::MAX;

    add_digestion(&mut player);
    add_digestion(&mut player);

    assert_eq!(player.digestions[0].id, u32::MAX);
    assert_eq!(player.digestions[1].id, 0);
    assert_eq!(player.next_digestion_id, 1);
  }
}
