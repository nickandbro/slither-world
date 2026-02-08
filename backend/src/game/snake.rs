use super::constants::{NODE_ANGLE, NODE_QUEUE_SIZE, STARTING_LENGTH};
use super::math::{clamp, cross, dot, length, normalize, rotate_around_axis, rotate_y, rotate_z};
use super::types::{Point, SnakeNode};
use std::collections::VecDeque;

pub fn add_snake_node(snake: &mut Vec<SnakeNode>, axis: Point) {
    let mut snake_node = SnakeNode {
        x: 0.0,
        y: 0.0,
        z: -1.0,
        pos_queue: VecDeque::with_capacity(NODE_QUEUE_SIZE),
    };

    for _ in 0..NODE_QUEUE_SIZE {
        snake_node.pos_queue.push_back(None);
    }

    if let Some(last) = snake.last() {
        if let Some(Some(last_pos)) = last.pos_queue.back() {
            snake_node.x = last_pos.x;
            snake_node.y = last_pos.y;
            snake_node.z = last_pos.z;
        } else {
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

            let mut used_local_continuation = false;
            if distinct_tail_points.len() >= 2 {
                let tail = distinct_tail_points[0];
                let prev = distinct_tail_points[1];
                let raw_spacing = clamp(dot(prev, tail), -1.0, 1.0).acos();
                let spacing = if raw_spacing.is_finite() && raw_spacing > 1e-6 {
                    clamp(raw_spacing, NODE_ANGLE * 0.75, NODE_ANGLE * 3.0)
                } else {
                    NODE_ANGLE * 2.0
                };

                let project_tangent = |from: Point, to: Point| Point {
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
                        let point = normalize(point);
                        snake_node.x = point.x;
                        snake_node.y = point.y;
                        snake_node.z = point.z;
                        used_local_continuation = true;
                    }
                }
            }

            if !used_local_continuation {
                snake_node.x = last.x;
                snake_node.y = last.y;
                snake_node.z = last.z;
                let mut point = Point {
                    x: snake_node.x,
                    y: snake_node.y,
                    z: snake_node.z,
                };
                rotate_around_axis(&mut point, axis, -NODE_ANGLE * 2.0);
                let point = normalize(point);
                snake_node.x = point.x;
                snake_node.y = point.y;
                snake_node.z = point.z;
            }
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

#[allow(dead_code)]
pub fn apply_snake_rotation(snake: &mut [SnakeNode], axis: Point, step_velocity: f64, steps: i32) {
    let step_count = steps.max(1);
    for _ in 0..step_count {
        apply_snake_rotation_step(snake, axis, step_velocity);
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
