use super::constants::{NODE_ANGLE, NODE_QUEUE_SIZE, STARTING_LENGTH};
use super::math::{clamp, cross, dot, length, normalize, rotate_around_axis, rotate_y, rotate_z};
use super::types::{Point, SnakeNode};
use std::collections::VecDeque;

const TAIL_EXTENSION_MAX_RATIO: f64 = 0.999_999;

#[derive(Clone, Copy, Debug)]
struct TailContinuation {
    point: Point,
    history_axis: Option<Point>,
    history_spacing: Option<f64>,
    history_sign: f64,
}

fn project_tangent(from: Point, to: Point) -> Point {
    Point {
        x: to.x
            - from.x
            - to.x
                * dot(
                    Point {
                        x: to.x - from.x,
                        y: to.y - from.y,
                        z: to.z - from.z,
                    },
                    to,
                ),
        y: to.y
            - from.y
            - to.y
                * dot(
                    Point {
                        x: to.x - from.x,
                        y: to.y - from.y,
                        z: to.z - from.z,
                    },
                    to,
                ),
        z: to.z
            - from.z
            - to.z
                * dot(
                    Point {
                        x: to.x - from.x,
                        y: to.y - from.y,
                        z: to.z - from.z,
                    },
                    to,
                ),
    }
}

fn project_to_tangent(direction: Point, normal: Point) -> Point {
    Point {
        x: direction.x - normal.x * dot(direction, normal),
        y: direction.y - normal.y * dot(direction, normal),
        z: direction.z - normal.z * dot(direction, normal),
    }
}

fn tail_extension_basis(snake: &[SnakeNode]) -> Option<(Point, Point, f64)> {
    if snake.len() < 2 {
        return None;
    }
    let tail_node = snake.last()?;
    let prev_node = snake.get(snake.len().saturating_sub(2))?;
    let tail = normalize(Point {
        x: tail_node.x,
        y: tail_node.y,
        z: tail_node.z,
    });
    let prev = normalize(Point {
        x: prev_node.x,
        y: prev_node.y,
        z: prev_node.z,
    });

    let mut base_segment = Point {
        x: tail.x - prev.x,
        y: tail.y - prev.y,
        z: tail.z - prev.z,
    };
    let mut base_length = length(base_segment);
    let mut tail_dir = project_to_tangent(base_segment, tail);

    if length(tail_dir) <= 1e-8 && snake.len() >= 3 {
        let prev_prev_node = snake.get(snake.len().saturating_sub(3))?;
        let prev_prev = normalize(Point {
            x: prev_prev_node.x,
            y: prev_prev_node.y,
            z: prev_prev_node.z,
        });
        base_segment = Point {
            x: prev.x - prev_prev.x,
            y: prev.y - prev_prev.y,
            z: prev.z - prev_prev.z,
        };
        base_length = length(base_segment);
        tail_dir = project_to_tangent(base_segment, tail);
    }
    if base_length <= 1e-8 || !base_length.is_finite() {
        return None;
    }
    let tail_dir_len = length(tail_dir);
    if tail_dir_len <= 1e-8 || !tail_dir_len.is_finite() {
        return None;
    }
    Some((
        tail,
        Point {
            x: tail_dir.x / tail_dir_len,
            y: tail_dir.y / tail_dir_len,
            z: tail_dir.z / tail_dir_len,
        },
        base_length,
    ))
}

fn rotate_tail_along_direction(tail: Point, tail_dir: Point, extend_distance: f64) -> Option<Point> {
    if extend_distance <= 1e-8 || !extend_distance.is_finite() {
        return None;
    }
    let axis = cross(tail, tail_dir);
    let axis_len = length(axis);
    let tail_radius = length(tail).max(1e-6);
    let angle = extend_distance / tail_radius;
    if !angle.is_finite() {
        return None;
    }

    if axis_len > 1e-8 {
        let axis_unit = Point {
            x: axis.x / axis_len,
            y: axis.y / axis_len,
            z: axis.z / axis_len,
        };
        let mut extended = tail;
        rotate_around_axis(&mut extended, axis_unit, angle);
        return Some(normalize(extended));
    }

    Some(normalize(Point {
        x: tail.x + tail_dir.x * extend_distance,
        y: tail.y + tail_dir.y * extend_distance,
        z: tail.z + tail_dir.z * extend_distance,
    }))
}

pub fn compute_extended_tail_point(snake: &[SnakeNode], tail_extension: f64) -> Option<Point> {
    let ratio = clamp(tail_extension, 0.0, TAIL_EXTENSION_MAX_RATIO);
    if ratio <= 1e-6 {
        return None;
    }
    let (tail, tail_dir, base_length) = tail_extension_basis(snake)?;
    let extend_distance = base_length * ratio;
    if extend_distance <= 1e-8 || !extend_distance.is_finite() {
        return None;
    }
    rotate_tail_along_direction(tail, tail_dir, extend_distance)
}

pub fn compute_tail_tip_point(snake: &[SnakeNode], tail_extension: f64) -> Option<Point> {
    if let Some(extended) = compute_extended_tail_point(snake, tail_extension) {
        return Some(extended);
    }
    snake.last().map(|tail_node| {
        normalize(Point {
            x: tail_node.x,
            y: tail_node.y,
            z: tail_node.z,
        })
    })
}

fn resolve_growth_continuity_from_extension(
    snake: &[SnakeNode],
    tail_extension_after: f64,
) -> Option<TailContinuation> {
    if snake.len() < 2 {
        return None;
    }
    let (tail, tail_dir, base_length) = tail_extension_basis(snake)?;
    let pre_tip = rotate_tail_along_direction(
        tail,
        tail_dir,
        base_length * TAIL_EXTENSION_MAX_RATIO,
    )?;
    let ratio_after = clamp(tail_extension_after, 0.0, TAIL_EXTENSION_MAX_RATIO);

    let axis = cross(tail, tail_dir);
    let axis_len = length(axis);
    if axis_len <= 1e-8 || !axis_len.is_finite() {
        return None;
    }
    let axis_unit = Point {
        x: axis.x / axis_len,
        y: axis.y / axis_len,
        z: axis.z / axis_len,
    };

    let total_angle = clamp(dot(tail, pre_tip), -1.0, 1.0).acos();
    if !total_angle.is_finite() || total_angle <= 1e-8 {
        return None;
    }
    let seg_angle = (total_angle / (1.0 + ratio_after)).max(1e-6);
    let mut point = tail;
    rotate_around_axis(&mut point, axis_unit, seg_angle);
    Some(TailContinuation {
        point: normalize(point),
        history_axis: Some(axis_unit),
        history_spacing: Some(seg_angle),
        history_sign: 1.0,
    })
}

fn collect_distinct_tail_points(snake: &[SnakeNode]) -> Vec<Point> {
    let mut distinct_tail_points: Vec<Point> = Vec::with_capacity(3);
    for node in snake.iter().rev() {
        let point = normalize(Point {
            x: node.x,
            y: node.y,
            z: node.z,
        });
        let should_push = if let Some(last_point) = distinct_tail_points.last() {
            let angular = clamp(dot(*last_point, point), -1.0, 1.0).acos();
            angular.is_finite() && angular > 1e-5
        } else {
            true
        };
        if should_push {
            distinct_tail_points.push(point);
        }
        if distinct_tail_points.len() >= 3 {
            break;
        }
    }
    distinct_tail_points
}

fn resolve_tail_continuation(
    snake: &[SnakeNode],
    axis: Point,
    allow_queue_history: bool,
) -> Option<TailContinuation> {
    let last = snake.last()?;

    if allow_queue_history {
        if let Some(Some(last_pos)) = last.pos_queue.back() {
            return Some(TailContinuation {
                point: Point {
                    x: last_pos.x,
                    y: last_pos.y,
                    z: last_pos.z,
                },
                history_axis: None,
                history_spacing: None,
                history_sign: 1.0,
            });
        }
    }

    let distinct_tail_points = collect_distinct_tail_points(snake);
    if distinct_tail_points.len() >= 2 {
        let tail = distinct_tail_points[0];
        let prev = distinct_tail_points[1];
        let raw_spacing = clamp(dot(prev, tail), -1.0, 1.0).acos();
        let spacing = if raw_spacing.is_finite() && raw_spacing > 1e-6 {
            clamp(raw_spacing, NODE_ANGLE * 0.75, NODE_ANGLE * 3.0)
        } else {
            NODE_ANGLE * 2.0
        };

        let mut tangent = project_tangent(prev, tail);
        if length(tangent) <= 1e-8 && distinct_tail_points.len() >= 3 {
            tangent = project_tangent(distinct_tail_points[2], prev);
        }
        let tangent_len = length(tangent);
        if tangent_len > 1e-8 {
            tangent = Point {
                x: tangent.x / tangent_len,
                y: tangent.y / tangent_len,
                z: tangent.z / tangent_len,
            };
            let local_axis = cross(tail, tangent);
            let axis_len = length(local_axis);
            if axis_len > 1e-8 && spacing.is_finite() {
                let axis_norm = Point {
                    x: local_axis.x / axis_len,
                    y: local_axis.y / axis_len,
                    z: local_axis.z / axis_len,
                };
                let mut point = tail;
                rotate_around_axis(&mut point, axis_norm, spacing);
                return Some(TailContinuation {
                    point: normalize(point),
                    history_axis: Some(axis_norm),
                    history_spacing: Some(spacing),
                    history_sign: 1.0,
                });
            }
        }
    }

    let mut point = Point {
        x: last.x,
        y: last.y,
        z: last.z,
    };
    rotate_around_axis(&mut point, axis, -NODE_ANGLE * 2.0);
    Some(TailContinuation {
        point: normalize(point),
        history_axis: Some(axis),
        history_spacing: Some(NODE_ANGLE * 2.0),
        history_sign: -1.0,
    })
}

fn apply_growth_history(
    snake: &mut Vec<SnakeNode>,
    snake_node: &mut SnakeNode,
    continuation: TailContinuation,
) {
    if let (Some(axis), Some(spacing)) = (continuation.history_axis, continuation.history_spacing) {
        if let Some(tail_node) = snake.last_mut() {
            let start = normalize(Point {
                x: tail_node.x,
                y: tail_node.y,
                z: tail_node.z,
            });
            tail_node.pos_queue.clear();
            tail_node.pos_queue.reserve(NODE_QUEUE_SIZE);
            let denom = (NODE_QUEUE_SIZE as f64).max(1.0);
            for k in 1..=NODE_QUEUE_SIZE {
                let t = (k as f64) / denom;
                let mut point = start;
                rotate_around_axis(&mut point, axis, continuation.history_sign * spacing * t);
                tail_node.pos_queue.push_back(Some(normalize(point)));
            }
        }
    }

    if let (Some(axis), Some(spacing)) = (continuation.history_axis, continuation.history_spacing) {
        let step_angle = (spacing / (NODE_QUEUE_SIZE as f64).max(1.0)).max(1e-6);
        let start = normalize(Point {
            x: snake_node.x,
            y: snake_node.y,
            z: snake_node.z,
        });
        for k in 1..=NODE_QUEUE_SIZE {
            let mut point = start;
            rotate_around_axis(
                &mut point,
                axis,
                continuation.history_sign * step_angle * (k as f64),
            );
            snake_node.pos_queue.push_back(Some(normalize(point)));
        }
    } else {
        for _ in 0..NODE_QUEUE_SIZE {
            snake_node.pos_queue.push_back(None);
        }
    }
}

pub fn add_snake_node(snake: &mut Vec<SnakeNode>, axis: Point) {
    let mut snake_node = SnakeNode {
        x: 0.0,
        y: 0.0,
        z: -1.0,
        pos_queue: VecDeque::with_capacity(NODE_QUEUE_SIZE),
    };

    if let Some(continuation) = resolve_tail_continuation(snake, axis, true) {
        snake_node.x = continuation.point.x;
        snake_node.y = continuation.point.y;
        snake_node.z = continuation.point.z;
    }

    for _ in 0..NODE_QUEUE_SIZE {
        snake_node.pos_queue.push_back(None);
    }

    snake.push(snake_node);
}

pub fn add_snake_node_for_growth(snake: &mut Vec<SnakeNode>, axis: Point, tail_extension_after: f64) {
    let mut snake_node = SnakeNode {
        x: 0.0,
        y: 0.0,
        z: -1.0,
        pos_queue: VecDeque::with_capacity(NODE_QUEUE_SIZE),
    };

    // We want to support rapid tail growth (multiple nodes added in quick succession) without
    // "pops" caused by newly-added segments lacking enough position history.
    //
    // To do that, we synthesize a full history queue by continuing the current tail arc. This
    // ensures the next segment can immediately follow (next_position is never `None`).
    //
    // Important: we intentionally do NOT seed the new node from the existing tail's `pos_queue`.
    // Using history points can disagree with the client-side fractional tail extension (which is a
    // local arc continuation). That mismatch shows up as a visible "pop" right when
    // `tail_extension` crosses 1.0 and a full node is committed.
    if let Some(continuity) = resolve_growth_continuity_from_extension(snake, tail_extension_after) {
        snake_node.x = continuity.point.x;
        snake_node.y = continuity.point.y;
        snake_node.z = continuity.point.z;
        apply_growth_history(snake, &mut snake_node, continuity);
    } else if let Some(continuation) = resolve_tail_continuation(snake, axis, false) {
        snake_node.x = continuation.point.x;
        snake_node.y = continuation.point.y;
        snake_node.z = continuation.point.z;
        apply_growth_history(snake, &mut snake_node, continuation);
    } else {
        for _ in 0..NODE_QUEUE_SIZE {
            snake_node.pos_queue.push_back(None);
        }
    }

    snake.push(snake_node);
}

pub fn remove_snake_tail_node(snake: &mut Vec<SnakeNode>, min_length: usize) -> bool {
    if snake.len() <= min_length {
        return false;
    }
    snake.pop();
    true
}

pub fn apply_snake_rotation_step(snake: &mut [SnakeNode], axis: Point, velocity: f64) {
    let mut next_position: Option<Point> = None;

    for (index, node) in snake.iter_mut().enumerate() {
        let old_position = Point {
            x: node.x,
            y: node.y,
            z: node.z,
        };

        if index == 0 || next_position.is_none() {
            let mut point = Point {
                x: node.x,
                y: node.y,
                z: node.z,
            };
            rotate_around_axis(&mut point, axis, velocity);
            node.x = point.x;
            node.y = point.y;
            node.z = point.z;
        } else if let Some(next) = next_position {
            node.x = next.x;
            node.y = next.y;
            node.z = next.z;
        }

        node.pos_queue.push_front(Some(old_position));
        next_position = node.pos_queue.pop_back().unwrap_or(None);
    }
}

pub fn create_snake(axis: Point) -> Vec<SnakeNode> {
    let mut snake = Vec::with_capacity(STARTING_LENGTH);
    for _ in 0..STARTING_LENGTH {
        add_snake_node(&mut snake, axis);
    }
    snake
}

pub fn rotate_snake(snake: &mut [SnakeNode], z_angle: f64, y_angle: f64) {
    for node in snake {
        let mut point = Point {
            x: node.x,
            y: node.y,
            z: node.z,
        };
        rotate_y(&mut point, y_angle);
        rotate_z(&mut point, z_angle);
        node.x = point.x;
        node.y = point.y;
        node.z = point.z;

        for queued in node.pos_queue.iter_mut() {
            let Some(mut queued_point) = queued.take() else {
                continue;
            };
            rotate_y(&mut queued_point, y_angle);
            rotate_z(&mut queued_point, z_angle);
            *queued = Some(queued_point);
        }
    }
}

pub fn rotate_snake_around_axis(snake: &mut [SnakeNode], axis: Point, angle: f64) {
    for node in snake {
        let mut point = Point {
            x: node.x,
            y: node.y,
            z: node.z,
        };
        rotate_around_axis(&mut point, axis, angle);
        node.x = point.x;
        node.y = point.y;
        node.z = point.z;

        for queued in node.pos_queue.iter_mut() {
            let Some(mut queued_point) = queued.take() else {
                continue;
            };
            rotate_around_axis(&mut queued_point, axis, angle);
            *queued = Some(queued_point);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_snake_node_continues_tail_arc_when_queue_history_missing() {
        let angle = 0.2f64;
        let prev = SnakeNode {
            x: 1.0,
            y: 0.0,
            z: 0.0,
            pos_queue: VecDeque::new(),
        };
        let last = SnakeNode {
            x: angle.cos(),
            y: angle.sin(),
            z: 0.0,
            pos_queue: VecDeque::new(),
        };
        let mut snake = vec![prev, last];

        add_snake_node(
            &mut snake,
            Point {
                x: 0.0,
                y: 1.0,
                z: 0.0,
            },
        );

        let added = snake.last().expect("added node");
        let expected = Point {
            x: (angle * 2.0).cos(),
            y: (angle * 2.0).sin(),
            z: 0.0,
        };
        let alignment = added.x * expected.x + added.y * expected.y + added.z * expected.z;
        assert!(alignment > 0.98);
    }
}
