use crate::game::room::Room;
use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;

pub async fn handle_socket(socket: WebSocket, room: Arc<Room>) {
    let (mut sender, mut receiver) = socket.split();
    let session = room.add_session().await;
    let session_id = session.session_id;
    let inbound = session.inbound;
    let outbound_state = session.outbound_state;
    let mut outbound_hi_rx = session.outbound_hi_rx;
    let mut outbound_lo_rx = session.outbound_lo_rx;

    let send_task = tokio::spawn(async move {
        use std::collections::VecDeque;

        let mut pending_hi: VecDeque<Vec<u8>> = VecDeque::new();
        let mut pending_lo: VecDeque<Vec<u8>> = VecDeque::new();
        let mut pending_state: Option<Vec<u8>> = None;

        loop {
            tokio::select! {
                Some(payload) = outbound_hi_rx.recv() => {
                    pending_hi.push_back(payload);
                }
                Some(payload) = outbound_lo_rx.recv() => {
                    pending_lo.push_back(payload);
                }
                _ = outbound_state.wait_for_update() => {}
            }

            while let Ok(payload) = outbound_hi_rx.try_recv() {
                pending_hi.push_back(payload);
            }
            while let Ok(payload) = outbound_lo_rx.try_recv() {
                pending_lo.push_back(payload);
            }
            if let Some(payload) = outbound_state.take_latest() {
                pending_state = Some(payload);
            }

            while let Some(payload) = pending_hi.pop_front() {
                if sender.send(Message::Binary(payload)).await.is_err() {
                    return;
                }
            }

            if let Some(payload) = pending_state.take() {
                if sender.send(Message::Binary(payload)).await.is_err() {
                    return;
                }
            }

            if let Some(payload) = pending_lo.pop_front() {
                if sender.send(Message::Binary(payload)).await.is_err() {
                    return;
                }
            }
        }
    });

    while let Some(result) = receiver.next().await {
        let Ok(message) = result else { break };
        match message {
            Message::Binary(data) => {
                if !room
                    .handle_binary_message(&session_id, &inbound, &data)
                    .await
                {
                    break;
                }
            }
            Message::Text(text) => {
                if !room.handle_text_message(&session_id, &inbound, &text).await {
                    break;
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    room.remove_session(&session_id).await;
    send_task.abort();
}
