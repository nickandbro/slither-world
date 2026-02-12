use super::environment::{Environment, PLANET_RADIUS, TREE_TRUNK_RADIUS};
use super::geometry::{sample_outline_radius, tangent_basis};
use super::math::{clamp, cross, dot, length, normalize};
use super::snake::{apply_snake_rotation_step, rotate_snake_around_axis};
use super::types::{Point, SnakeNode};
use std::f64::consts::PI;

const CONTACT_ITERATIONS: usize = 4;
const STICK_THRESHOLD: f64 = 0.01;

pub fn apply_snake_with_collisions(
    snake: &mut Vec<SnakeNode>,
    axis: &mut Point,
    snake_angular_radius: f64,
    step_velocity: f64,
    steps: i32,
    env: &Environment,
) {
    let step_count = steps.max(1);
    for _ in 0..step_count {
        apply_snake_rotation_step(snake, *axis, step_velocity);
        if snake.is_empty() {
            continue;
        }
        let raw_head = Point {
            x: snake[0].x,
            y: snake[0].y,
            z: snake[0].z,
        };
        let (corrected_head, corrected_axis) =
            resolve_head_collisions(raw_head, *axis, snake_angular_radius, env);
        let dot_value = clamp(
            dot(normalize(raw_head), normalize(corrected_head)),
            -1.0,
            1.0,
        );
        let angle = dot_value.acos();
        if angle.is_finite() && angle > 1e-6 {
            let axis_vec = cross(raw_head, corrected_head);
            if length(axis_vec) > 1e-8 {
                let axis_norm = normalize(axis_vec);
                rotate_snake_around_axis(snake, axis_norm, angle);
            }
        }
        *axis = corrected_axis;
    }
}

fn resolve_head_collisions(
    head: Point,
    axis: Point,
    snake_angular_radius: f64,
    env: &Environment,
) -> (Point, Point) {
    let mut head = normalize(head);
    let mut tangent = cross(axis, head);
    if length(tangent) > 1e-6 {
        tangent = normalize(tangent);
    }

    for _ in 0..CONTACT_ITERATIONS {
        let mut any_contact = false;

        for tree in &env.trees {
            if tree.width_scale < 0.0 {
                continue;
            }
            let tree_radius = (TREE_TRUNK_RADIUS * tree.width_scale) / PLANET_RADIUS;
            if let Some((new_head, normal)) =
                resolve_circle_contact(head, tree.normal, tree_radius, snake_angular_radius)
            {
                head = new_head;
                tangent = project_tangent(tangent, normal);
                any_contact = true;
            }
        }

        for mountain in &env.mountains {
            if let Some((new_head, normal)) =
                resolve_mountain_contact(head, mountain, snake_angular_radius)
            {
                head = new_head;
                tangent = project_tangent(tangent, normal);
                any_contact = true;
            }
        }

        if !any_contact {
            break;
        }
    }

    let axis_out = if length(tangent) < 1e-6 {
        axis
    } else {
        normalize(cross(head, tangent))
    };

    (head, axis_out)
}

fn resolve_circle_contact(
    head: Point,
    center: Point,
    radius: f64,
    snake_angular_radius: f64,
) -> Option<(Point, Point)> {
    let dot_value = clamp(dot(head, center), -1.0, 1.0);
    let angle = dot_value.acos();
    let target_angle = radius + snake_angular_radius;
    if !angle.is_finite() || angle >= target_angle {
        return None;
    }
    let mut dir = Point {
        x: head.x - center.x * dot_value,
        y: head.y - center.y * dot_value,
        z: head.z - center.z * dot_value,
    };
    if length(dir) < 1e-6 {
        dir = fallback_tangent(center);
    }
    let dir = normalize(dir);
    let new_head = Point {
        x: center.x * target_angle.cos() + dir.x * target_angle.sin(),
        y: center.y * target_angle.cos() + dir.y * target_angle.sin(),
        z: center.z * target_angle.cos() + dir.z * target_angle.sin(),
    };
    Some((normalize(new_head), dir))
}

fn resolve_mountain_contact(
    head: Point,
    mountain: &super::environment::MountainInstance,
    snake_angular_radius: f64,
) -> Option<(Point, Point)> {
    let dot_value = clamp(dot(head, mountain.normal), -1.0, 1.0);
    let angle = dot_value.acos();
    if !angle.is_finite() {
        return None;
    }

    let (tangent, bitangent) = tangent_basis(mountain.normal);
    let mut projection = Point {
        x: head.x - mountain.normal.x * dot_value,
        y: head.y - mountain.normal.y * dot_value,
        z: head.z - mountain.normal.z * dot_value,
    };
    let proj_len = length(projection);
    if proj_len < 1e-6 {
        projection = tangent;
    }
    let x = dot(projection, tangent);
    let y = dot(projection, bitangent);
    let mut theta = y.atan2(x);
    if theta < 0.0 {
        theta += PI * 2.0;
    }
    let outline_radius = sample_outline_radius(&mountain.outline, theta);
    let target_angle = outline_radius + snake_angular_radius;
    if angle >= target_angle {
        return None;
    }
    let dir = normalize(Point {
        x: tangent.x * x + bitangent.x * y,
        y: tangent.y * x + bitangent.y * y,
        z: tangent.z * x + bitangent.z * y,
    });
    let new_head = Point {
        x: mountain.normal.x * target_angle.cos() + dir.x * target_angle.sin(),
        y: mountain.normal.y * target_angle.cos() + dir.y * target_angle.sin(),
        z: mountain.normal.z * target_angle.cos() + dir.z * target_angle.sin(),
    };
    Some((normalize(new_head), dir))
}

fn project_tangent(mut tangent: Point, normal: Point) -> Point {
    if length(tangent) < 1e-6 {
        return tangent;
    }
    let inward = dot(tangent, normal);
    if inward < 0.0 {
        tangent = Point {
            x: tangent.x - normal.x * inward,
            y: tangent.y - normal.y * inward,
            z: tangent.z - normal.z * inward,
        };
    }
    if length(tangent) < STICK_THRESHOLD {
        Point {
            x: 0.0,
            y: 0.0,
            z: 0.0,
        }
    } else {
        normalize(tangent)
    }
}

fn fallback_tangent(normal: Point) -> Point {
    let (tangent, _) = tangent_basis(normal);
    tangent
}
