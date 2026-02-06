use super::constants::{DIGESTION_TAIL_SETTLE_STEPS, DIGESTION_TRAVEL_SPEED_MULT, NODE_QUEUE_SIZE};
use super::math::clamp;
use super::snake::add_snake_node;
use super::types::{Digestion, Player};

pub fn add_digestion(player: &mut Player) {
    add_digestion_with_strength(player, 1.0, 1.0);
}

pub fn add_digestion_with_strength(player: &mut Player, strength: f32, growth_amount: f64) {
    let clamped_growth = growth_amount.max(0.0);
    if clamped_growth <= 0.0 {
        return;
    }
    let travel_steps = (((player.snake.len().saturating_sub(1)) * NODE_QUEUE_SIZE) as f64
        / DIGESTION_TRAVEL_SPEED_MULT)
        .round()
        .max(1.0) as i64;
    let settle_steps = DIGESTION_TAIL_SETTLE_STEPS.max(0);
    let total = travel_steps + settle_steps;
    let id = player.next_digestion_id;
    player.next_digestion_id = player.next_digestion_id.wrapping_add(1);
    player.digestions.push(Digestion {
        id,
        remaining: total,
        total,
        settle_steps,
        growth_amount: clamped_growth,
        applied: false,
        strength: clamp(strength as f64, 0.05, 1.0) as f32,
    });
}

pub fn advance_digestions(player: &mut Player, steps: i32) {
    let step_count = steps.max(1) as i32;

    for _ in 0..step_count {
        let mut i = 0;
        while i < player.digestions.len() {
            player.digestions[i].remaining -= 1;

            if !player.digestions[i].applied
                && player.digestions[i].remaining <= player.digestions[i].settle_steps
            {
                player.tail_extension += player.digestions[i].growth_amount.max(0.0);
                player.digestions[i].applied = true;
            }

            if player.digestions[i].remaining <= 0 {
                player.digestions.remove(i);
                continue;
            }

            i += 1;
        }

        if player.tail_extension >= 1.0 {
            add_snake_node(&mut player.snake, player.axis);
            player.tail_extension -= 1.0;
        }
        if player.tail_extension < 0.0 {
            player.tail_extension = 0.0;
        }
    }
}

pub fn get_digestion_progress(digestion: &Digestion) -> f64 {
    let settle_steps = digestion.settle_steps.max(0);
    let travel_total = (digestion.total - settle_steps).max(1) as f64;
    let travel_remaining = (digestion.remaining - settle_steps).max(0) as f64;
    let travel_progress = clamp(1.0 - travel_remaining / travel_total, 0.0, 1.0);

    let settle_progress = if settle_steps > 0 && digestion.remaining <= settle_steps {
        clamp(
            1.0 - (digestion.remaining as f64) / (settle_steps as f64),
            0.0,
            1.0,
        )
    } else if settle_steps <= 0 && digestion.remaining <= 0 {
        1.0
    } else {
        0.0
    };
    clamp(travel_progress + settle_progress, 0.0, 2.0)
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
            tail_extension: 0.0,
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
                settle_steps: 0,
                growth_amount: 1.0,
                applied: false,
                strength: 1.0,
            },
            Digestion {
                id: 9,
                remaining: 4,
                total: 4,
                settle_steps: 0,
                growth_amount: 0.5,
                applied: false,
                strength: 1.0,
            },
        ];

        let previous_len = player.snake.len();
        advance_digestions(&mut player, 1);

        assert_eq!(player.snake.len(), previous_len + 1);
        assert_eq!(player.digestions.len(), 1);
        assert_eq!(player.digestions[0].id, 9);
        assert_eq!(player.digestions[0].remaining, 3);
        assert!(player.tail_extension.abs() < 1e-6);
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
    fn fractional_growth_accumulates_without_new_node() {
        let mut player = make_player();
        player.digestions.push(Digestion {
            id: 1,
            remaining: 1,
            total: 1,
            settle_steps: 0,
            growth_amount: 0.4,
            applied: false,
            strength: 0.4,
        });

        let before_len = player.snake.len();
        advance_digestions(&mut player, 1);
        assert_eq!(player.snake.len(), before_len);
        assert!(player.digestions.is_empty());
        assert!((player.tail_extension - 0.4).abs() < 1e-6);
    }

    #[test]
    fn fractional_growth_crossing_one_adds_exactly_one_node() {
        let mut player = make_player();
        player.tail_extension = 0.8;
        player.digestions.push(Digestion {
            id: 1,
            remaining: 1,
            total: 1,
            settle_steps: 0,
            growth_amount: 0.35,
            applied: false,
            strength: 0.8,
        });

        let before_len = player.snake.len();
        advance_digestions(&mut player, 1);

        assert_eq!(player.snake.len(), before_len + 1);
        assert!(player.tail_extension > 0.14 && player.tail_extension < 0.16);
    }

    #[test]
    fn burst_growth_adds_only_one_node_per_step() {
        let mut player = make_player();
        player.digestions.push(Digestion {
            id: 1,
            remaining: 1,
            total: 1,
            settle_steps: 0,
            growth_amount: 2.4,
            applied: false,
            strength: 1.0,
        });

        let before_len = player.snake.len();
        advance_digestions(&mut player, 1);

        assert_eq!(player.snake.len(), before_len + 1);
        assert!(player.tail_extension > 1.39 && player.tail_extension < 1.41);
    }

    #[test]
    fn tail_extension_carryover_consumes_one_node_per_substep() {
        let mut player = make_player();
        player.tail_extension = 2.2;
        let before_len = player.snake.len();

        advance_digestions(&mut player, 2);

        assert_eq!(player.snake.len(), before_len + 2);
        assert!(player.tail_extension > 0.19 && player.tail_extension < 0.21);
    }

    #[test]
    fn digestion_progress_reaches_tail_at_one_and_cleanup_at_two() {
        let at_tail = Digestion {
            id: 5,
            remaining: 4,
            total: 10,
            settle_steps: 4,
            growth_amount: 0.2,
            applied: true,
            strength: 0.3,
        };
        let finished = Digestion {
            id: 6,
            remaining: 0,
            total: 10,
            settle_steps: 4,
            growth_amount: 0.2,
            applied: true,
            strength: 0.3,
        };

        let at_tail_progress = get_digestion_progress(&at_tail);
        let finished_progress = get_digestion_progress(&finished);
        assert!((at_tail_progress - 1.0).abs() < 1e-6);
        assert!((finished_progress - 2.0).abs() < 1e-6);
    }
}
