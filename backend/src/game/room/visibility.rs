use super::*;

impl RoomState {
    fn session_view_params(&self, session_id: &str) -> Option<(Point, f64)> {
        let session = self.sessions.get(session_id)?;
        let player_id = session.player_id.as_ref()?;
        let player = self.players.get(player_id)?;
        let default_center = player
            .snake
            .first()
            .map(|node| Point {
                x: node.x,
                y: node.y,
                z: node.z,
            })
            .and_then(parse_axis);
        let view_center = session.view_center.or(default_center)?;
        let view_radius = session
            .view_radius
            .unwrap_or(1.0)
            .clamp(VIEW_RADIUS_MIN, VIEW_RADIUS_MAX);
        let view_cos = (view_radius + VIEW_RADIUS_MARGIN).cos();
        Some((view_center, view_cos))
    }

    pub(super) fn snake_window_for_player(
        &self,
        player: &Player,
        is_local_player: bool,
        view: Option<(Point, f64)>,
    ) -> SnakeWindow {
        let total_len = player.snake.len();
        if total_len == 0 {
            return SnakeWindow::stub(0);
        }
        if is_local_player {
            return SnakeWindow::full(total_len);
        }
        if view.is_none() {
            return SnakeWindow::stub(total_len);
        }
        let (view_center, view_cos) = view.expect("checked above");
        let mut best_start = 0usize;
        let mut best_len = 0usize;
        let mut run_start = 0usize;
        let mut run_len = 0usize;

        for (index, node) in player.snake.iter().enumerate() {
            let visible = dot(
                view_center,
                Point {
                    x: node.x,
                    y: node.y,
                    z: node.z,
                },
            ) >= view_cos;
            if visible {
                if run_len == 0 {
                    run_start = index;
                }
                run_len += 1;
                if run_len > best_len {
                    best_len = run_len;
                    best_start = run_start;
                }
            } else {
                run_len = 0;
            }
        }

        if best_len == 0 {
            return SnakeWindow::stub(total_len);
        }

        let start = best_start.saturating_sub(VIEW_NODE_PADDING);
        let end = (best_start + best_len + VIEW_NODE_PADDING).min(total_len);
        let len = end.saturating_sub(start);
        if len < VIEW_MIN_WINDOW_POINTS {
            return SnakeWindow::stub(total_len);
        }
        SnakeWindow::window(total_len, start, len)
    }

    pub(super) fn visible_players_for_session<'a>(
        &'a self,
        session_id: &str,
    ) -> Vec<VisiblePlayer<'a>> {
        let local_player_id = self
            .sessions
            .get(session_id)
            .and_then(|session| session.player_id.as_deref());
        let view = self.session_view_params(session_id);
        let mut visible_players = Vec::with_capacity(self.players.len());
        for player in self.players.values() {
            let is_local_player = local_player_id == Some(player.id.as_str());
            let window = self.snake_window_for_player(player, is_local_player, view);
            if is_local_player || window.detail != SnakeDetail::Stub {
                visible_players.push(VisiblePlayer { player, window });
            }
        }
        visible_players
    }

    fn pellet_zoom_t(camera_distance: Option<f64>) -> f64 {
        let distance = camera_distance
            .unwrap_or((VIEW_CAMERA_DISTANCE_MIN + VIEW_CAMERA_DISTANCE_MAX) * 0.5)
            .clamp(
                SMALL_PELLET_ZOOM_MIN_CAMERA_DISTANCE,
                SMALL_PELLET_ZOOM_MAX_CAMERA_DISTANCE,
            );
        let denom = (SMALL_PELLET_ZOOM_MAX_CAMERA_DISTANCE - SMALL_PELLET_ZOOM_MIN_CAMERA_DISTANCE)
            .max(1e-6);
        (distance - SMALL_PELLET_ZOOM_MIN_CAMERA_DISTANCE) / denom
    }

    pub(super) fn pellet_view_params(&self, session_id: &str) -> Option<(Point, f64, usize)> {
        let session = self.sessions.get(session_id)?;
        let player_id = session.player_id.as_ref()?;
        let player = self.players.get(player_id)?;
        let default_center = player
            .snake
            .first()
            .map(|node| Point {
                x: node.x,
                y: node.y,
                z: node.z,
            })
            .and_then(parse_axis);
        let view_center = session.view_center.or(default_center)?;
        let view_radius = session
            .view_radius
            .unwrap_or(1.0)
            .clamp(VIEW_RADIUS_MIN, VIEW_RADIUS_MAX);
        let zoom_t = Self::pellet_zoom_t(session.camera_distance);
        let visible_count = ((SMALL_PELLET_VISIBLE_MIN as f64)
            + ((SMALL_PELLET_VISIBLE_MAX - SMALL_PELLET_VISIBLE_MIN) as f64) * zoom_t)
            .round()
            .max(1.0) as usize;
        let extra_margin = SMALL_PELLET_VIEW_MARGIN_MIN
            + (SMALL_PELLET_VIEW_MARGIN_MAX - SMALL_PELLET_VIEW_MARGIN_MIN) * zoom_t;
        let visible_cos = (view_radius + VIEW_RADIUS_MARGIN + extra_margin).cos();
        Some((view_center, visible_cos, visible_count))
    }

    pub(super) fn visible_pellet_indices(
        &self,
        view_center: Point,
        view_cos: f64,
        max_visible: usize,
    ) -> Vec<usize> {
        let capped_visible = max_visible.min(u16::MAX as usize);
        if capped_visible == 0 || self.pellets.is_empty() {
            return Vec::new();
        }

        // Choose a stable subset so delta replication does not churn due to Vec order changes.
        // We keep the lowest IDs among visible pellets (IDs are monotonic for practical purposes).
        use std::collections::BinaryHeap;
        let mut heap: BinaryHeap<(u32, usize)> = BinaryHeap::new();
        for (index, pellet) in self.pellets.iter().enumerate() {
            if dot(view_center, pellet.normal) < view_cos {
                continue;
            }
            heap.push((pellet.id, index));
            if heap.len() > capped_visible {
                heap.pop();
            }
        }

        let mut out: Vec<usize> = heap.into_iter().map(|(_, index)| index).collect();
        out.sort_unstable_by_key(|&index| self.pellets[index].id);
        out
    }
}
