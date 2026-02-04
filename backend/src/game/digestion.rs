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
  player.digestions.push(Digestion {
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
