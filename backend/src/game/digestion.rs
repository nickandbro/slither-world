use super::constants::{
    DIGESTION_INTAKE_DELAY_STEPS, DIGESTION_TAIL_GROWTH_BACKLOG_SQRT_MULT,
    DIGESTION_TAIL_GROWTH_BASE_PER_STEP, DIGESTION_TAIL_GROWTH_MAX_PER_STEP,
    DIGESTION_TAIL_SETTLE_STEPS, DIGESTION_TRAVEL_SPEED_MULT, MIN_SURVIVAL_LENGTH, NODE_QUEUE_SIZE,
};
use super::math::clamp;
use super::snake::{add_snake_node_for_growth, remove_snake_tail_node};
use super::types::{Digestion, Player};

#[derive(Clone, Copy, Debug, Default)]
pub struct BoostDrainConfig {
    pub active: bool,
    pub min_length: usize,
    pub score_per_step: f64,
    pub node_per_step: f64,
}

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
    let intake_delay_steps = DIGESTION_INTAKE_DELAY_STEPS.max(0);
    let settle_steps = DIGESTION_TAIL_SETTLE_STEPS.max(0);
    let total = travel_steps + settle_steps + intake_delay_steps;
    let id = player.next_digestion_id;
    player.next_digestion_id = player.next_digestion_id.wrapping_add(1);
    player.digestions.push(Digestion {
        id,
        remaining: total,
        total,
        settle_steps,
        growth_amount: clamped_growth,
        applied_growth: 0.0,
        strength: clamp(strength as f64, 0.05, 1.0) as f32,
    });
}

pub fn advance_digestions(player: &mut Player, steps: i32) {
    let _ = advance_digestions_with_boost(player, steps, BoostDrainConfig::default());
}

fn tail_growth_rate_per_step(backlog: f64) -> f64 {
    if backlog <= 1e-9 {
        return 0.0;
    }
    let base = DIGESTION_TAIL_GROWTH_BASE_PER_STEP.max(0.0);
    let mult = DIGESTION_TAIL_GROWTH_BACKLOG_SQRT_MULT.max(0.0);
    let max = DIGESTION_TAIL_GROWTH_MAX_PER_STEP.max(base);
    let dynamic = base + mult * backlog.max(0.0).sqrt();
    dynamic.clamp(0.0, max)
}

fn can_continue_boost(player: &Player, min_length: usize) -> bool {
    if player.snake.len() > min_length.max(1) {
        return true;
    }
    if player.tail_extension > 1e-6 {
        return true;
    }
    // Allow boost to consume pending (in-flight) digestion growth so boost remains responsive
    // even when tail growth has not yet reached the end of the snake.
    player
        .digestions
        .iter()
        .any(|digestion| digestion.growth_amount - digestion.applied_growth > 1e-6)
}

fn apply_score_drain(player: &mut Player, score_drain: f64) {
    let drain = score_drain.max(0.0);
    if drain <= 0.0 {
        return;
    }

    player.pellet_growth_fraction -= drain;
    while player.pellet_growth_fraction < 0.0 && player.score > 0 {
        player.score -= 1;
        player.pellet_growth_fraction += 1.0;
    }
    if player.score <= 0 && player.pellet_growth_fraction < 0.0 {
        player.score = 0;
        player.pellet_growth_fraction = 0.0;
    }
    if player.pellet_growth_fraction >= 1.0 {
        let whole_score = player.pellet_growth_fraction.floor() as i64;
        if whole_score > 0 {
            player.score += whole_score;
            player.pellet_growth_fraction -= whole_score as f64;
        }
    }
    player.pellet_growth_fraction = clamp(player.pellet_growth_fraction, 0.0, 0.999_999);
}

pub fn advance_digestions_with_boost(
    player: &mut Player,
    steps: i32,
    boost_drain: BoostDrainConfig,
) -> bool {
    let step_count = steps.max(1) as i32;
    let min_length = if boost_drain.min_length > 0 {
        boost_drain.min_length
    } else {
        MIN_SURVIVAL_LENGTH
    };
    let mut boost_active = boost_drain.active && can_continue_boost(player, min_length);

    for _ in 0..step_count {
        let mut i = 0;
        while i < player.digestions.len() {
            player.digestions[i].remaining -= 1;

            i += 1;
        }

        // Drain tail growth from any digestions that have reached the tail.
        let mut tail_backlog = 0.0;
        for digestion in &player.digestions {
            if digestion.remaining > digestion.settle_steps {
                continue;
            }
            let remaining = (digestion.growth_amount - digestion.applied_growth).max(0.0);
            tail_backlog += remaining;
        }
        let mut budget = tail_growth_rate_per_step(tail_backlog).min(tail_backlog);
        if budget > 1e-9 {
            for digestion in &mut player.digestions {
                if budget <= 1e-9 {
                    break;
                }
                if digestion.remaining > digestion.settle_steps {
                    continue;
                }
                let remaining = (digestion.growth_amount - digestion.applied_growth).max(0.0);
                if remaining <= 1e-9 {
                    continue;
                }
                let delta = remaining.min(budget);
                digestion.applied_growth += delta;
                player.tail_extension += delta;
                budget -= delta;
            }
        }

        // Cleanup: digestions can outlive their visual window if a large burst is still draining.
        // Once they've fully applied their growth, they can be removed.
        let mut i = 0;
        while i < player.digestions.len() {
            let growth_remaining =
                (player.digestions[i].growth_amount - player.digestions[i].applied_growth).max(0.0);
            if player.digestions[i].remaining <= 0 && growth_remaining <= 1e-6 {
                player.digestions.remove(i);
                continue;
            }
            i += 1;
        }

        if boost_active {
            apply_score_drain(player, boost_drain.score_per_step);
            let node_drain = clamp(boost_drain.node_per_step, 0.0, 0.999_999);
            if node_drain > 0.0 {
                player.tail_extension -= node_drain;
            }
        }

        if player.tail_extension >= 1.0 {
            add_snake_node_for_growth(&mut player.snake, player.axis);
            player.tail_extension -= 1.0;
        }
        if player.tail_extension < 0.0 {
            if remove_snake_tail_node(&mut player.snake, min_length) {
                player.tail_extension += 1.0;
            } else {
                // We are at the floor. Instead of hard-stopping boost immediately, burn pending
                // digestion growth so players can boost as soon as they've earned reserve, even if
                // the growth is still traveling down the body.
                let deficit = -player.tail_extension;
                player.tail_extension = 0.0;

                let mut remaining = deficit;
                if remaining > 1e-9 {
                    for digestion in &mut player.digestions {
                        if remaining <= 1e-9 {
                            break;
                        }
                        let available =
                            (digestion.growth_amount - digestion.applied_growth).max(0.0);
                        if available <= 1e-9 {
                            continue;
                        }
                        let delta = available.min(remaining);
                        digestion.applied_growth += delta;
                        remaining -= delta;
                    }
                }

                if remaining > 1e-6 {
                    boost_active = false;
                }
            }
        }
        if boost_active && !can_continue_boost(player, min_length) {
            boost_active = false;
        }
    }

    boost_active
}

pub fn get_digestion_progress(digestion: &Digestion) -> f64 {
    let intake_delay_steps = DIGESTION_INTAKE_DELAY_STEPS.max(0);
    let settle_steps = digestion.settle_steps.max(0);
    let travel_total = (digestion.total - settle_steps - intake_delay_steps).max(1) as f64;
    let travel_remaining = (digestion.remaining - settle_steps).max(0) as f64;
    let delayed_travel_remaining = travel_remaining.min(travel_total);
    let travel_progress = clamp(1.0 - delayed_travel_remaining / travel_total, 0.0, 1.0);

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

pub fn get_digestion_visual_strength(digestion: &Digestion) -> f32 {
    let intake_delay_steps = DIGESTION_INTAKE_DELAY_STEPS.max(0);
    let settle_steps = digestion.settle_steps.max(0);
    let travel_total = (digestion.total - settle_steps - intake_delay_steps).max(1);
    let travel_remaining = (digestion.remaining - settle_steps).max(0);
    if travel_remaining >= travel_total {
        0.0
    } else {
        clamp(digestion.strength as f64, 0.05, 1.0) as f32
    }
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
            net_id: 1,
            name: "Player".to_string(),
            color: "#fff".to_string(),
            skin: None,
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
            is_boosting: false,
            oxygen: 1.0,
            oxygen_damage_accumulator: 0.0,
            score: 0,
            alive: true,
            connected: true,
            last_seen: 0,
            respawn_at: None,
            boost_floor_len: 4,
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
                remaining: 0,
                total: 1,
                settle_steps: 0,
                growth_amount: 0.05,
                applied_growth: 0.0,
                strength: 1.0,
            },
            Digestion {
                id: 9,
                remaining: 0,
                total: 4,
                settle_steps: 0,
                growth_amount: 0.5,
                applied_growth: 0.0,
                strength: 1.0,
            },
        ];

        let previous_len = player.snake.len();
        advance_digestions(&mut player, 1);

        assert_eq!(player.snake.len(), previous_len);
        assert_eq!(player.digestions.len(), 1);
        assert_eq!(player.digestions[0].id, 9);
        assert!(player.tail_extension > 0.0);
        assert!(player.tail_extension < 1.0);
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
            remaining: 0,
            total: 1,
            settle_steps: 0,
            growth_amount: 0.4,
            applied_growth: 0.0,
            strength: 0.4,
        });

        let before_len = player.snake.len();
        advance_digestions(&mut player, 1);
        assert_eq!(player.snake.len(), before_len);
        assert!(!player.digestions.is_empty());
        assert!(player.tail_extension > 0.0);
        assert!(player.tail_extension < 0.4);
        assert!((player.digestions[0].applied_growth - player.tail_extension).abs() < 1e-6);

        let mut iterations = 0;
        while !player.digestions.is_empty() && iterations < 300 {
            advance_digestions(&mut player, 1);
            iterations += 1;
        }
        assert!(player.digestions.is_empty());
        assert!((player.tail_extension - 0.4).abs() < 1e-3);
    }

    #[test]
    fn fractional_growth_crossing_one_adds_exactly_one_node() {
        let mut player = make_player();
        player.tail_extension = 0.8;
        player.digestions.push(Digestion {
            id: 1,
            remaining: 0,
            total: 1,
            settle_steps: 0,
            growth_amount: 0.35,
            applied_growth: 0.0,
            strength: 0.8,
        });

        let before_len = player.snake.len();
        let mut iterations = 0;
        while player.snake.len() == before_len && iterations < 300 {
            advance_digestions(&mut player, 1);
            iterations += 1;
        }
        assert_eq!(player.snake.len(), before_len + 1);

        iterations = 0;
        while !player.digestions.is_empty() && iterations < 300 {
            advance_digestions(&mut player, 1);
            iterations += 1;
        }
        assert!(player.digestions.is_empty());
        assert!(player.tail_extension > 0.149 && player.tail_extension < 0.151);
    }

    #[test]
    fn burst_growth_adds_only_one_node_per_step() {
        let mut player = make_player();
        player.digestions.push(Digestion {
            id: 1,
            remaining: 0,
            total: 1,
            settle_steps: 0,
            growth_amount: 2.4,
            applied_growth: 0.0,
            strength: 1.0,
        });

        let before_len = player.snake.len();
        let mut last_len = before_len;
        let mut iterations = 0;
        while !player.digestions.is_empty() && iterations < 2000 {
            advance_digestions(&mut player, 1);
            assert!(player.snake.len() <= last_len + 1);
            last_len = player.snake.len();
            iterations += 1;
        }
        assert!(player.digestions.is_empty());
        assert_eq!(player.snake.len(), before_len + 2);
        assert!((player.tail_extension - 0.4).abs() < 1e-3);
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
            applied_growth: 0.0,
            strength: 0.3,
        };
        let finished = Digestion {
            id: 6,
            remaining: 0,
            total: 10,
            settle_steps: 4,
            growth_amount: 0.2,
            applied_growth: 0.0,
            strength: 0.3,
        };

        let at_tail_progress = get_digestion_progress(&at_tail);
        let finished_progress = get_digestion_progress(&finished);
        assert!((at_tail_progress - 1.0).abs() < 1e-6);
        assert!((finished_progress - 2.0).abs() < 1e-6);
    }

    #[test]
    fn digestion_progress_holds_at_zero_during_intake_delay() {
        let mut player = make_player();
        add_digestion_with_strength(&mut player, 0.7, 0.2);
        assert_eq!(player.digestions.len(), 1);
        assert!(DIGESTION_INTAKE_DELAY_STEPS > 0);

        let mut digestion = player.digestions[0].clone();
        assert!(get_digestion_progress(&digestion) <= 1e-6);
        for _ in 0..DIGESTION_INTAKE_DELAY_STEPS {
            digestion.remaining -= 1;
            assert!(get_digestion_progress(&digestion) <= 1e-6);
        }

        digestion.remaining -= 1;
        assert!(get_digestion_progress(&digestion) > 1e-6);
    }

    #[test]
    fn digestion_visual_strength_is_zero_during_intake_delay() {
        let mut player = make_player();
        add_digestion_with_strength(&mut player, 0.7, 0.2);
        assert_eq!(player.digestions.len(), 1);
        assert!(DIGESTION_INTAKE_DELAY_STEPS > 0);

        let mut digestion = player.digestions[0].clone();
        assert!(get_digestion_visual_strength(&digestion) <= 1e-6);
        for _ in 0..DIGESTION_INTAKE_DELAY_STEPS {
            digestion.remaining -= 1;
            assert!(get_digestion_visual_strength(&digestion) <= 1e-6);
        }

        digestion.remaining -= 1;
        assert!(get_digestion_visual_strength(&digestion) >= 0.69);
    }

    #[test]
    fn boost_drain_ticks_score_interval_and_tail_extension_together() {
        let mut player = make_player();
        player.score = 2;
        player.pellet_growth_fraction = 0.2;
        player.tail_extension = 0.6;

        let boost_active = advance_digestions_with_boost(
            &mut player,
            1,
            BoostDrainConfig {
                active: true,
                score_per_step: 0.35,
                node_per_step: 0.35,
                min_length: MIN_SURVIVAL_LENGTH,
            },
        );

        assert!(boost_active);
        assert_eq!(player.score, 1);
        assert!((player.pellet_growth_fraction - 0.85).abs() < 1e-6);
        assert!((player.tail_extension - 0.25).abs() < 1e-6);
    }

    #[test]
    fn boost_drain_auto_stops_at_min_length_floor() {
        let mut player = make_player();
        player.snake = make_snake(MIN_SURVIVAL_LENGTH);
        player.tail_extension = 0.02;

        let boost_active = advance_digestions_with_boost(
            &mut player,
            2,
            BoostDrainConfig {
                active: true,
                score_per_step: 1.0,
                node_per_step: 0.05,
                min_length: MIN_SURVIVAL_LENGTH,
            },
        );

        assert!(!boost_active);
        assert_eq!(player.snake.len(), MIN_SURVIVAL_LENGTH);
        assert!(player.tail_extension.abs() < 1e-6);
        assert_eq!(player.score, 0);
        assert!(player.pellet_growth_fraction.abs() < 1e-6);
    }

    #[test]
    fn boost_drain_can_burn_pending_growth_at_floor() {
        let mut player = make_player();
        player.snake = make_snake(MIN_SURVIVAL_LENGTH);
        player.tail_extension = 0.0;
        player.digestions.push(Digestion {
            id: 1,
            remaining: 20,
            total: 20,
            settle_steps: 4,
            growth_amount: 0.2,
            applied_growth: 0.0,
            strength: 0.4,
        });

        let boost_active = advance_digestions_with_boost(
            &mut player,
            1,
            BoostDrainConfig {
                active: true,
                score_per_step: 0.0,
                node_per_step: 0.05,
                min_length: MIN_SURVIVAL_LENGTH,
            },
        );

        assert!(boost_active);
        assert_eq!(player.snake.len(), MIN_SURVIVAL_LENGTH);
        assert!(player.tail_extension.abs() < 1e-6);
        assert_eq!(player.digestions.len(), 1);
        assert!(player.digestions[0].applied_growth > 0.049);
        assert!(player.digestions[0].applied_growth < 0.051);
    }
}
