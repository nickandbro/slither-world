use super::constants::{NODE_ANGLE, NODE_QUEUE_SIZE, STARTING_LENGTH};
use super::math::{rotate_around_axis, rotate_y, rotate_z};
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
      snake_node.x = last.x;
      snake_node.y = last.y;
      snake_node.z = last.z;
      let mut point = Point {
        x: snake_node.x,
        y: snake_node.y,
        z: snake_node.z,
      };
      rotate_around_axis(&mut point, axis, -NODE_ANGLE * 2.0);
      snake_node.x = point.x;
      snake_node.y = point.y;
      snake_node.z = point.z;
    }
  }

  snake.push(snake_node);
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
pub fn apply_snake_rotation(
  snake: &mut [SnakeNode],
  axis: Point,
  step_velocity: f64,
  steps: i32,
) {
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
      let Some(mut queued_point) = queued.take() else { continue };
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
      let Some(mut queued_point) = queued.take() else { continue };
      rotate_around_axis(&mut queued_point, axis, angle);
      *queued = Some(queued_point);
    }
  }
}
