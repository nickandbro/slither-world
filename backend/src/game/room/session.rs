use crate::app::time::now_millis;
use crate::game::input::parse_axis;
use crate::game::math::clamp;
use crate::game::types::Point;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use tokio::sync::{mpsc, Notify};

#[derive(Debug)]
pub struct LatestFrame {
    frame: StdMutex<Option<Vec<u8>>>,
    notify: Notify,
}

impl LatestFrame {
    pub(crate) fn new() -> Self {
        Self {
            frame: StdMutex::new(None),
            notify: Notify::new(),
        }
    }

    pub(crate) fn store(&self, payload: Vec<u8>) {
        *self.frame.lock().unwrap() = Some(payload);
        self.notify.notify_one();
    }

    pub(crate) fn take_latest(&self) -> Option<Vec<u8>> {
        self.frame.lock().unwrap().take()
    }

    pub(crate) async fn wait_for_update(&self) {
        self.notify.notified().await;
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct SessionInboundState {
    pub(crate) input_axis: Option<Point>,
    pub(crate) boost: bool,
    pub(crate) last_input_at: i64,
    pub(crate) view_center: Option<Point>,
    pub(crate) view_radius: Option<f64>,
    pub(crate) camera_distance: Option<f64>,
}

#[derive(Debug)]
pub struct SessionInbound {
    inner: StdMutex<SessionInboundState>,
}

impl SessionInbound {
    pub(crate) fn new() -> Self {
        Self {
            inner: StdMutex::new(SessionInboundState::default()),
        }
    }

    pub(crate) fn update_input(&self, axis: Option<Point>, boost: bool) {
        let mut state = self.inner.lock().unwrap();
        if let Some(axis) = axis.and_then(parse_axis) {
            state.input_axis = Some(axis);
        }
        state.boost = boost;
        state.last_input_at = now_millis();
    }

    pub(crate) fn update_view(
        &self,
        view_center: Option<Point>,
        view_radius: Option<f32>,
        camera_distance: Option<f32>,
    ) {
        let mut state = self.inner.lock().unwrap();
        state.view_center = view_center.and_then(parse_axis);
        state.view_radius = view_radius
            .map(|value| value as f64)
            .filter(|value| value.is_finite())
            .map(|value| clamp(value, super::VIEW_RADIUS_MIN, super::VIEW_RADIUS_MAX));
        state.camera_distance = camera_distance
            .map(|value| value as f64)
            .filter(|value| value.is_finite())
            .map(|value| {
                clamp(
                    value,
                    super::VIEW_CAMERA_DISTANCE_MIN,
                    super::VIEW_CAMERA_DISTANCE_MAX,
                )
            });
    }

    pub(crate) fn snapshot(&self) -> SessionInboundState {
        *self.inner.lock().unwrap()
    }
}

pub struct SessionIo {
    pub session_id: String,
    pub inbound: Arc<SessionInbound>,
    pub outbound_state: Arc<LatestFrame>,
    pub outbound_hi_rx: mpsc::Receiver<Vec<u8>>,
    pub outbound_lo_rx: mpsc::Receiver<Vec<u8>>,
}
