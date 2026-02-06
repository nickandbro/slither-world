use super::constants::{DIGESTION_GROWTH_STEPS, DIGESTION_TRAVEL_SPEED_MULT, NODE_QUEUE_SIZE};
use super::math::clamp;
use super::snake::add_snake_node;
use super::types::{Digestion, Player};

pub fn add_digestion(player: &mut Player) {
    add_digestion_with_strength(player, 1.0, true);
}

pub fn add_digestion_with_strength(player: &mut Player, strength: f32, grows: bool) {
    let travel_steps = (((player.snake.len().saturating_sub(1)) * NODE_QUEUE_SIZE) as f64
        / DIGESTION_TRAVEL_SPEED_MULT)
        .round()
        .max(1.0) as i64;
    let growth_steps = if grows { DIGESTION_GROWTH_STEPS } else { 0 };
    let total = travel_steps + growth_steps;
    let id = player.next_digestion_id;
    player.next_digestion_id = player.next_digestion_id.wrapping_add(1);
    player.digestions.push(Digestion {
        id,
        remaining: total,
        total,
        growth_steps,
        strength: clamp(strength as f64, 0.05, 1.0) as f32,
        grows,
    });
}

pub fn advance_digestions(player: &mut Player, steps: i32) {
    let step_count = steps.max(1) as i32;
    for _ in 0..step_count {
        let mut growth_taken = false;

        let mut i = 0;
        while i < player.digestions.len() {
            if !player.digestions[i].grows {
                player.digestions[i].remaining -= 1;
                if player.digestions[i].remaining <= 0 {
                    player.digestions.remove(i);
                    continue;
                }
                i += 1;
                continue;
            }

            let at_tail = player.digestions[i].remaining <= player.digestions[i].growth_steps;
            if at_tail {
                if !growth_taken {
                    player.digestions[i].remaining -= 1;
                    growth_taken = true;
                } else {
                    let growth_steps = player.digestions[i].growth_steps;
                    player.digestions[i].remaining =
                        player.digestions[i].remaining.max(growth_steps);
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
    if !digestion.grows || digestion.growth_steps <= 0 {
        if digestion.total <= 1 {
            return 1.0;
        }
        let travel_total = (digestion.total - 1) as f64;
        let travel_remaining = (digestion.remaining - 1).max(0) as f64;
        return clamp(1.0 - travel_remaining / travel_total, 0.0, 1.0);
    }
    let travel_total = (digestion.total - digestion.growth_steps).max(1) as f64;
    let travel_remaining = (digestion.remaining - digestion.growth_steps).max(0) as f64;
    let travel_progress = clamp(1.0 - travel_remaining / travel_total, 0.0, 1.0);
    let growth_progress = if digestion.remaining <= digestion.growth_steps {
        clamp(
            1.0 - (digestion.remaining as f64) / (digestion.growth_steps as f64),
            0.0,
            1.0,
        )
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
            axis: Point {
                x: 1.0,
                y: 0.0,
                z: 0.0,
            },
            target_axis: Point {
                x: 1.0,
                y: 0.0,
                z: 0.0,
            },
            boost: false,
            stamina: 1.0,
            oxygen: 1.0,
            oxygen_damage_accumulator: 0.0,
            score: 0,
            alive: true,
            connected: true,
            last_seen: 0,
            respawn_at: None,
            snake: make_snake(4),
            pellet_growth_fraction: 0.0,
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
                strength: 1.0,
                grows: true,
            },
            Digestion {
                id: 9,
                remaining: 4,
                total: 4,
                growth_steps: 1,
                strength: 1.0,
                grows: true,
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

    #[test]
    fn non_growing_digestion_reaches_tail_before_cleanup() {
        let digestion = Digestion {
            id: 5,
            remaining: 1,
            total: 12,
            growth_steps: 0,
            strength: 0.3,
            grows: false,
        };

        let progress = get_digestion_progress(&digestion);
        assert!((progress - 1.0).abs() < 1e-6);
    }
}
