
use super::*;
use crate::game::types::Digestion;
use std::collections::{HashMap, HashSet, VecDeque};

fn make_snake(len: usize, start: f64) -> Vec<SnakeNode> {
    (0..len)
        .map(|index| SnakeNode {
            x: start + index as f64,
            y: 0.0,
            z: 0.0,
            pos_queue: VecDeque::new(),
        })
        .collect()
}

fn make_player(id: &str, snake: Vec<SnakeNode>) -> Player {
    Player {
        id: id.to_string(),
        id_bytes: [0u8; 16],
        net_id: 1,
        name: "Test".to_string(),
        color: "#ffffff".to_string(),
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
        oxygen: OXYGEN_MAX,
        oxygen_damage_accumulator: 0.0,
        score: 0,
        alive: true,
        connected: true,
        last_seen: 0,
        respawn_at: None,
        boost_floor_len: snake.len().max(STARTING_LENGTH),
        snake,
        pellet_growth_fraction: 0.0,
        tail_extension: 0.0,
        next_digestion_id: 0,
        digestions: Vec::new(),
    }
}

fn snake_from_xs(xs: &[f64]) -> Vec<SnakeNode> {
    xs.iter()
        .map(|x| SnakeNode {
            x: *x,
            y: 0.0,
            z: 0.0,
            pos_queue: VecDeque::new(),
        })
        .collect()
}

fn make_state() -> RoomState {
    RoomState {
        sessions: HashMap::new(),
        players: HashMap::new(),
        pellets: Vec::new(),
        next_pellet_id: 0,
        next_state_seq: 1,
        next_player_net_id: 1,
        next_evasive_spawn_at: HashMap::new(),
        pending_pellet_consumes: Vec::new(),
        environment: Environment::generate(),
    }
}

fn make_pellet(id: u32, normal: Point) -> Pellet {
    Pellet {
        id,
        normal,
        color_index: 0,
        base_size: 1.0,
        current_size: 1.0,
        growth_fraction: SMALL_PELLET_GROWTH_FRACTION,
        state: PelletState::Idle,
    }
}

fn make_snake_with_head(head: Point, trailing: Point, len: usize) -> Vec<SnakeNode> {
    let mut snake = Vec::with_capacity(len.max(2));
    snake.push(SnakeNode {
        x: head.x,
        y: head.y,
        z: head.z,
        pos_queue: VecDeque::new(),
    });
    snake.push(SnakeNode {
        x: trailing.x,
        y: trailing.y,
        z: trailing.z,
        pos_queue: VecDeque::new(),
    });
    for _ in 2..len.max(2) {
        snake.push(SnakeNode {
            x: trailing.x,
            y: trailing.y,
            z: trailing.z,
            pos_queue: VecDeque::new(),
        });
    }
    snake
}

fn read_u8(bytes: &[u8], offset: &mut usize) -> u8 {
    let value = bytes[*offset];
    *offset += 1;
    value
}

fn read_u16(bytes: &[u8], offset: &mut usize) -> u16 {
    let value = u16::from_le_bytes(bytes[*offset..*offset + 2].try_into().unwrap());
    *offset += 2;
    value
}

fn read_u32(bytes: &[u8], offset: &mut usize) -> u32 {
    let value = u32::from_le_bytes(bytes[*offset..*offset + 4].try_into().unwrap());
    *offset += 4;
    value
}

fn read_var_u32(bytes: &[u8], offset: &mut usize) -> u32 {
    let mut result = 0u32;
    let mut shift = 0u32;
    for _ in 0..5 {
        let byte = read_u8(bytes, offset);
        result |= ((byte & 0x7f) as u32) << shift;
        if byte & 0x80 == 0 {
            return result;
        }
        shift += 7;
    }
    panic!("invalid varint");
}

fn read_var_i32(bytes: &[u8], offset: &mut usize) -> i32 {
    let value = read_var_u32(bytes, offset);
    ((value >> 1) as i32) ^ (-((value & 1) as i32))
}

fn skip_player_state(bytes: &[u8], offset: &mut usize) {
    let _net_id = read_u16(bytes, offset);
    let field_mask = read_u16(bytes, offset);
    if field_mask & DELTA_FIELD_FLAGS != 0 {
        *offset += 1;
    }
    if field_mask & DELTA_FIELD_SCORE != 0 {
        let _score = read_var_i32(bytes, offset);
    }
    if field_mask & DELTA_FIELD_SCORE_FRACTION != 0 {
        *offset += 1;
    }
    if field_mask & DELTA_FIELD_OXYGEN != 0 {
        *offset += 1;
    }
    if field_mask & DELTA_FIELD_GIRTH != 0 {
        *offset += 1;
    }
    if field_mask & DELTA_FIELD_TAIL_EXT != 0 {
        *offset += 1;
    }
    if field_mask & DELTA_FIELD_SNAKE != 0 {
        let mode = read_u8(bytes, offset);
        if mode == DELTA_SNAKE_SHIFT_HEAD {
            *offset += 4;
        } else {
            let detail = read_u8(bytes, offset);
            let total_len = read_u16(bytes, offset);
            let snake_len = match detail {
                protocol::SNAKE_DETAIL_FULL => read_u16(bytes, offset),
                protocol::SNAKE_DETAIL_WINDOW => {
                    let _start = read_u16(bytes, offset);
                    read_u16(bytes, offset)
                }
                protocol::SNAKE_DETAIL_STUB => 0,
                _ => panic!("unexpected snake detail"),
            };
            assert!(snake_len <= total_len);
            *offset += snake_len as usize * 4;
        }
    }
    if field_mask & DELTA_FIELD_DIGESTIONS != 0 {
        let digestion_len = read_u8(bytes, offset);
        *offset += digestion_len as usize * 7;
    }
}

fn skip_init_player_state(bytes: &[u8], offset: &mut usize) {
    *offset += 2; // net id
    *offset += 1; // flags
    *offset += 4; // score
    *offset += 2; // score fraction (q16)
    *offset += 2; // oxygen (q16)
    *offset += 1; // girth (q8)
    *offset += 1; // tail extension (q8)
    let detail = read_u8(bytes, offset);
    let total_len = read_u16(bytes, offset);
    let snake_len = match detail {
        protocol::SNAKE_DETAIL_FULL => read_u16(bytes, offset),
        protocol::SNAKE_DETAIL_WINDOW => {
            let _start = read_u16(bytes, offset);
            read_u16(bytes, offset)
        }
        protocol::SNAKE_DETAIL_STUB => 0,
        _ => panic!("unexpected snake detail"),
    };
    assert!(snake_len <= total_len);
    *offset += snake_len as usize * 4;
    let digestion_len = read_u8(bytes, offset);
    *offset += digestion_len as usize * 12;
}

fn decode_state_counts(payload: &[u8]) -> (u32, u16, u16) {
    let mut offset = 0usize;
    let version = read_u8(payload, &mut offset);
    assert_eq!(version, protocol::VERSION);
    let message_type = read_u8(payload, &mut offset);
    assert_eq!(message_type, protocol::TYPE_STATE_DELTA);
    let _flags = read_u16(payload, &mut offset);
    offset += 8; // now
    let state_seq = read_u32(payload, &mut offset);
    let total_players = read_u16(payload, &mut offset);
    let _frame_flags = read_u8(payload, &mut offset);
    let visible_players = read_u16(payload, &mut offset);
    for _ in 0..visible_players {
        skip_player_state(payload, &mut offset);
    }
    assert_eq!(offset, payload.len());
    (state_seq, total_players, visible_players)
}

fn decode_init_counts(payload: &[u8]) -> (u32, u16, u16) {
    let mut offset = 0usize;
    let version = read_u8(payload, &mut offset);
    assert_eq!(version, protocol::VERSION);
    let message_type = read_u8(payload, &mut offset);
    assert_eq!(message_type, protocol::TYPE_INIT);
    let _flags = read_u16(payload, &mut offset);
    offset += 16; // local player id
    offset += 8; // now
    let state_seq = read_u32(payload, &mut offset);
    let tick_ms = read_u16(payload, &mut offset);
    assert_eq!(tick_ms, TICK_MS.min(u16::MAX as u64) as u16);
    let total_players = read_u16(payload, &mut offset);
    let meta_count = read_u16(payload, &mut offset);
    for _ in 0..meta_count {
        offset += 2; // net id
        offset += 16; // player id
        let name_len = read_u8(payload, &mut offset) as usize;
        offset += name_len;
        let color_len = read_u8(payload, &mut offset) as usize;
        offset += color_len;
        let skin_len = read_u8(payload, &mut offset) as usize;
        offset += skin_len * 3;
    }
    let visible_players = read_u16(payload, &mut offset);
    for _ in 0..visible_players {
        skip_init_player_state(payload, &mut offset);
    }
    assert!(offset <= payload.len());
    (state_seq, total_players, visible_players)
}

#[test]
fn girth_scale_grows_per_node_and_caps() {
    assert!((RoomState::player_girth_scale_from_len(STARTING_LENGTH) - 1.0).abs() < 1e-9);
    assert!((RoomState::player_girth_scale_from_len(STARTING_LENGTH + 1) - 1.01).abs() < 1e-9);
    assert!((RoomState::player_girth_scale_from_len(STARTING_LENGTH + 9) - 1.09).abs() < 1e-9);
    assert!((RoomState::player_girth_scale_from_len(STARTING_LENGTH + 10) - 1.1).abs() < 1e-9);
    assert!((RoomState::player_girth_scale_from_len(STARTING_LENGTH + 15) - 1.15).abs() < 1e-9);
    assert!((RoomState::player_girth_scale_from_len(STARTING_LENGTH + 20) - 1.2).abs() < 1e-9);
    assert!((RoomState::player_girth_scale_from_len(STARTING_LENGTH + 500) - 2.0).abs() < 1e-9);
}

#[test]
fn self_overlap_does_not_kill_player() {
    let radius = RoomState::snake_body_angular_radius_for_scale(1.0);
    let snapshot = PlayerCollisionSnapshot {
        id: "self-overlap".to_string(),
        alive: true,
        snake: vec![
            Point {
                x: 0.0,
                y: 0.0,
                z: 1.0,
            },
            Point {
                x: 0.0,
                y: 1.0,
                z: 0.0,
            },
            Point {
                x: 0.0,
                y: 0.0,
                z: 1.0,
            },
        ],
        contact_angular_radius: radius,
        body_angular_radius: radius,
    };
    let mut dead = HashSet::new();
    let mut death_reasons = HashMap::new();
    RoomState::detect_snake_head_body_collisions(&[snapshot], &mut dead, &mut death_reasons);
    assert!(dead.is_empty());
    assert!(death_reasons.is_empty());
}

#[test]
fn snake_collision_still_kills_on_head_body_overlap() {
    let radius = RoomState::snake_body_angular_radius_for_scale(1.0);
    let a = PlayerCollisionSnapshot {
        id: "a".to_string(),
        alive: true,
        snake: vec![
            Point {
                x: 0.0,
                y: 0.0,
                z: 1.0,
            },
            Point {
                x: 0.0,
                y: 1.0,
                z: 0.0,
            },
            Point {
                x: -1.0,
                y: 0.0,
                z: 0.0,
            },
        ],
        contact_angular_radius: radius,
        body_angular_radius: radius,
    };
    let b = PlayerCollisionSnapshot {
        id: "b".to_string(),
        alive: true,
        snake: vec![
            Point {
                x: 1.0,
                y: 0.0,
                z: 0.0,
            },
            Point {
                x: 0.0,
                y: 0.0,
                z: 1.0,
            },
            Point {
                x: 0.0,
                y: -1.0,
                z: 0.0,
            },
        ],
        contact_angular_radius: radius,
        body_angular_radius: radius,
    };
    let mut dead = HashSet::new();
    let mut death_reasons = HashMap::new();
    RoomState::detect_snake_head_body_collisions(&[a, b], &mut dead, &mut death_reasons);
    assert!(dead.contains("a"));
    assert_eq!(death_reasons.get("a"), Some(&"snake_collision"));
    assert!(!dead.contains("b"));
}

#[test]
fn boost_start_requires_next_whole_score_above_floor() {
    let mut player = make_player(
        "boost-start-threshold",
        make_snake(STARTING_LENGTH + 1, 0.0),
    );
    player.boost_floor_len = STARTING_LENGTH;
    player.score = STARTING_LENGTH as i64;
    player.pellet_growth_fraction = 0.8;
    assert!(!RoomState::can_player_boost(&player));

    player.score = STARTING_LENGTH as i64 + 1;
    assert!(RoomState::can_player_boost(&player));
}

#[test]
fn active_boost_can_continue_below_start_threshold_until_floor() {
    let mut player = make_player(
        "boost-continue-threshold",
        make_snake(STARTING_LENGTH + 1, 0.0),
    );
    player.boost_floor_len = STARTING_LENGTH;
    player.score = STARTING_LENGTH as i64;
    player.is_boosting = true;
    assert!(RoomState::can_player_boost(&player));

    player.is_boosting = false;
    assert!(!RoomState::can_player_boost(&player));
}

#[test]
fn boost_can_start_at_floor_when_pending_growth_exists() {
    let mut player = make_player("boost-start-pending", make_snake(STARTING_LENGTH, 0.0));
    player.boost_floor_len = STARTING_LENGTH;
    player.score = STARTING_LENGTH as i64 + 1;
    player.tail_extension = 0.0;
    player.digestions.push(Digestion {
        id: 1,
        remaining: 12,
        total: 12,
        settle_steps: 4,
        growth_amount: 0.10,
        applied_growth: 0.0,
        strength: 1.0,
    });

    assert!(RoomState::can_player_boost(&player));
}

fn insert_session_with_view(
    state: &mut RoomState,
    session_id: &str,
    player_id: &str,
    view_center: Option<Point>,
    view_radius: Option<f64>,
) {
    let outbound_state = Arc::new(LatestFrame::new());
    let (outbound_hi, _outbound_hi_rx) = mpsc::channel::<Vec<u8>>(1);
    let (outbound_lo, _outbound_lo_rx) = mpsc::channel::<Vec<u8>>(1);
    let inbound = Arc::new(SessionInbound::new());
    state.sessions.insert(
        session_id.to_string(),
        SessionEntry {
            outbound_state,
            outbound_hi,
            outbound_lo,
            inbound,
            player_id: Some(player_id.to_string()),
            view_center,
            view_radius,
            camera_distance: None,
            pellet_view_ids: HashSet::new(),
            pellet_view_initialized: false,
            pellet_reset_retry_at: 0,
            delta_player_cache: HashMap::new(),
            force_next_keyframe: true,
        },
    );
}

#[test]
fn spawn_rejects_heads_within_min_distance() {
    let mut state = make_state();
    state.players.insert(
        "other".to_string(),
        make_player("other", snake_from_xs(&[0.0, 0.4, 0.8])),
    );

    let candidate = snake_from_xs(&[SPAWN_PLAYER_MIN_DISTANCE * 0.75]);
    assert!(state.is_snake_too_close(&candidate, None));
}

#[test]
fn spawn_allows_heads_outside_min_distance() {
    let mut state = make_state();
    state.players.insert(
        "other".to_string(),
        make_player("other", snake_from_xs(&[0.0, 0.4, 0.8])),
    );

    let candidate = snake_from_xs(&[SPAWN_PLAYER_MIN_DISTANCE + 0.05]);
    assert!(!state.is_snake_too_close(&candidate, None));
}

#[test]
fn spawn_check_ignores_excluded_player_id() {
    let mut state = make_state();
    let player_id = "respawn-player".to_string();
    state.players.insert(
        player_id.clone(),
        make_player(&player_id, snake_from_xs(&[0.0, 0.4, 0.8])),
    );

    let candidate = snake_from_xs(&[SPAWN_PLAYER_MIN_DISTANCE * 0.75]);
    assert!(state.is_snake_too_close(&candidate, None));
    assert!(!state.is_snake_too_close(&candidate, Some(&player_id)));
}

#[test]
fn death_drops_pellets_for_each_body_node() {
    let mut state = make_state();
    state.environment.lakes.clear();
    state.environment.trees.clear();
    state.environment.mountains.clear();
    let snake = make_snake(6, 0.0);
    let player_id = "player-1".to_string();
    let player = make_player(&player_id, snake.clone());
    state.players.insert(player_id.clone(), player);

    state.handle_death(&player_id);

    assert_eq!(state.pellets.len(), snake.len() - 1);
    for (pellet, node) in state.pellets.iter().zip(snake.iter().skip(1)) {
        assert_eq!(pellet.normal.x, node.x);
        assert_eq!(pellet.normal.y, node.y);
        assert_eq!(pellet.normal.z, node.z);
        assert!(pellet.base_size >= DEATH_PELLET_SIZE_MIN);
        assert!(pellet.base_size <= DEATH_PELLET_SIZE_MAX);
    }
}

#[test]
fn death_pellets_clamp_to_u16_max() {
    let mut state = make_state();
    state.environment.lakes.clear();
    state.environment.trees.clear();
    state.environment.mountains.clear();
    let base_len = u16::MAX as usize - 2;
    state.pellets = (0..base_len)
        .map(|index| Pellet {
            id: index as u32,
            normal: Point {
                x: 0.0,
                y: 0.0,
                z: 0.0,
            },
            color_index: 0,
            base_size: SMALL_PELLET_SIZE_MIN,
            current_size: SMALL_PELLET_SIZE_MIN,
            growth_fraction: SMALL_PELLET_GROWTH_FRACTION,
            state: PelletState::Idle,
        })
        .collect();

    let snake = make_snake(5, 100.0);
    let player_id = "player-2".to_string();
    let player = make_player(&player_id, snake.clone());
    state.players.insert(player_id.clone(), player);

    state.handle_death(&player_id);

    assert_eq!(state.pellets.len(), u16::MAX as usize);
    let tail = &state.pellets[state.pellets.len() - 4..];
    for (pellet, node) in tail.iter().zip(snake.iter().skip(1)) {
        assert_eq!(pellet.normal.x, node.x);
        assert_eq!(pellet.normal.y, node.y);
        assert_eq!(pellet.normal.z, node.z);
        assert!(pellet.base_size > SMALL_PELLET_SIZE_MAX);
    }
}

#[test]
fn spawn_small_pellet_rejects_lake_zone() {
    let mut state = make_full_lake_state();
    let mut rng = rand::thread_rng();
    assert!(state.spawn_small_pellet_with_rng(&mut rng).is_none());
}

#[test]
fn pellet_spawn_invalid_inside_tree_or_cactus_collider() {
    use crate::game::environment::TreeInstance;
    let mut state = make_state();
    state.environment.lakes.clear();
    state.environment.mountains.clear();
    state.environment.trees = vec![
        TreeInstance {
            normal: Point {
                x: 1.0,
                y: 0.0,
                z: 0.0,
            },
            width_scale: 1.0,
            height_scale: 1.0,
            twist: 0.0,
        },
        TreeInstance {
            normal: Point {
                x: -1.0,
                y: 0.0,
                z: 0.0,
            },
            width_scale: -1.0,
            height_scale: 1.0,
            twist: 0.0,
        },
    ];

    assert!(state.is_invalid_pellet_spawn(Point {
        x: 1.0,
        y: 0.0,
        z: 0.0,
    }));
    assert!(state.is_invalid_pellet_spawn(Point {
        x: -1.0,
        y: 0.0,
        z: 0.0,
    }));
    assert!(!state.is_invalid_pellet_spawn(Point {
        x: 0.0,
        y: 1.0,
        z: 0.0,
    }));
}

#[test]
fn pellet_spawn_invalid_inside_mountain_collider() {
    use crate::game::environment::MountainInstance;
    let mut state = make_state();
    state.environment.lakes.clear();
    state.environment.trees.clear();
    state.environment.mountains = vec![MountainInstance {
        normal: Point {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        },
        radius: 0.5,
        height: 0.2,
        variant: 0,
        twist: 0.0,
        outline: vec![0.28; 64],
    }];

    assert!(state.is_invalid_pellet_spawn(Point {
        x: 1.0,
        y: 0.0,
        z: 0.0,
    }));
    assert!(!state.is_invalid_pellet_spawn(Point {
        x: 0.0,
        y: 1.0,
        z: 0.0,
    }));
}

#[test]
fn death_drop_repositions_invalid_points_to_valid_spawn() {
    use crate::game::environment::TreeInstance;
    let mut state = make_state();
    state.environment.lakes.clear();
    state.environment.mountains.clear();
    state.environment.trees = vec![TreeInstance {
        normal: Point {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        },
        width_scale: 1.0,
        height_scale: 1.0,
        twist: 0.0,
    }];
    let player_id = "death-spawn-adjust".to_string();
    let snake = vec![
        SnakeNode {
            x: 0.0,
            y: 1.0,
            z: 0.0,
            pos_queue: VecDeque::new(),
        },
        SnakeNode {
            x: 1.0,
            y: 0.0,
            z: 0.0,
            pos_queue: VecDeque::new(),
        },
        SnakeNode {
            x: 0.0,
            y: 0.0,
            z: 1.0,
            pos_queue: VecDeque::new(),
        },
    ];
    state
        .players
        .insert(player_id.clone(), make_player(&player_id, snake));

    state.handle_death(&player_id);

    assert_eq!(state.pellets.len(), 2);
    assert!(!state
        .pellets
        .iter()
        .any(|pellet| (pellet.normal.x - 1.0).abs() < 1e-6
            && pellet.normal.y.abs() < 1e-6
            && pellet.normal.z.abs() < 1e-6));
    for pellet in &state.pellets {
        assert!(!state.is_invalid_pellet_spawn(pellet.normal));
    }
}

#[test]
fn write_player_state_encodes_digestion_id_and_progress() {
    let state = make_state();
    let mut player = make_player("player-3", make_snake(2, 0.0));
    player.pellet_growth_fraction = 0.375;
    player.digestions.push(Digestion {
        id: 42,
        remaining: 2,
        total: 4,
        settle_steps: 1,
        growth_amount: 0.75,
        applied_growth: 0.0,
        strength: 0.35,
    });

    let mut encoder = protocol::Encoder::with_capacity(256);
    state.write_player_state_with_window(&mut encoder, &player, SnakeWindow::full(player.snake.len()));
    let payload = encoder.into_vec();

    let mut offset = 0usize;
    let encoded_net_id = u16::from_le_bytes(payload[offset..offset + 2].try_into().unwrap());
    assert_eq!(encoded_net_id, player.net_id);
    offset += 2;

    let flags = payload[offset];
    assert_eq!(flags & 0x01, 0x01); // alive
    assert_eq!(flags & 0x02, 0x00); // not boosting
    offset += 1;

    offset += 4; // score

    let encoded_score_fraction =
        u16::from_le_bytes(payload[offset..offset + 2].try_into().unwrap());
    let expected_score_fraction = (0.375 * u16::MAX as f64).round() as u16;
    assert_eq!(encoded_score_fraction, expected_score_fraction);
    offset += 2;

    let encoded_oxygen = u16::from_le_bytes(payload[offset..offset + 2].try_into().unwrap());
    assert_eq!(encoded_oxygen, u16::MAX);
    offset += 2;

    let encoded_girth_q = payload[offset];
    assert_eq!(encoded_girth_q, 0);
    offset += 1;
    let encoded_tail_ext_q = payload[offset];
    assert_eq!(encoded_tail_ext_q, 0);
    offset += 1;

    let detail = payload[offset];
    assert_eq!(detail, protocol::SNAKE_DETAIL_FULL);
    offset += 1;

    let encoded_total_len = u16::from_le_bytes(payload[offset..offset + 2].try_into().unwrap());
    assert_eq!(encoded_total_len as usize, player.snake.len());
    offset += 2;

    let encoded_window_len = u16::from_le_bytes(payload[offset..offset + 2].try_into().unwrap());
    assert_eq!(encoded_window_len as usize, player.snake.len());
    offset += 2;
    offset += player.snake.len() * 4; // oct-encoded points

    assert_eq!(payload[offset], 1); // digestion len
    offset += 1;

    let encoded_id = u32::from_le_bytes(payload[offset..offset + 4].try_into().unwrap());
    assert_eq!(encoded_id, 42);
    offset += 4;

    let encoded_progress = f32::from_le_bytes(payload[offset..offset + 4].try_into().unwrap());
    let expected_progress = get_digestion_progress(&player.digestions[0]) as f32;
    assert!((encoded_progress - expected_progress).abs() < 1e-6);
    offset += 4;

    let encoded_strength = f32::from_le_bytes(payload[offset..offset + 4].try_into().unwrap());
    let expected_strength = get_digestion_visual_strength(&player.digestions[0]);
    assert!((encoded_strength - expected_strength).abs() < 1e-6);
}

#[test]
fn write_player_state_encodes_authoritative_is_boosting_flag() {
    let state = make_state();
    let mut player = make_player("player-boosting", make_snake(3, 0.0));
    player.boost = true;
    player.is_boosting = true;

    let mut encoder = protocol::Encoder::with_capacity(256);
    state.write_player_state_with_window(&mut encoder, &player, SnakeWindow::full(player.snake.len()));
    let payload = encoder.into_vec();

    let flags = payload[2];
    assert_eq!(flags & 0x01, 0x01); // alive
    assert_eq!(flags & 0x02, 0x02); // boosting
}

#[test]
fn write_player_state_encodes_most_recent_digestions_when_capped() {
    let state = make_state();
    let mut player = make_player("player-recent-digest", make_snake(2, 0.0));
    for id in 0..300u32 {
        player.digestions.push(Digestion {
            id,
            remaining: 2,
            total: 4,
            settle_steps: 1,
            growth_amount: 0.4,
            applied_growth: 0.0,
            strength: 0.4,
        });
    }

    let mut encoder = protocol::Encoder::with_capacity(8192);
    state.write_player_state_with_window(&mut encoder, &player, SnakeWindow::full(player.snake.len()));
    let payload = encoder.into_vec();

    let mut offset = 0usize;
    offset += 2; // net id
    offset += 1; // flags
    offset += 4; // score
    offset += 2; // score fraction
    offset += 2; // oxygen
    offset += 1; // girth
    offset += 1; // tail extension

    let detail = payload[offset];
    assert_eq!(detail, protocol::SNAKE_DETAIL_FULL);
    offset += 1;

    offset += 2; // total len
    let encoded_window_len = u16::from_le_bytes(payload[offset..offset + 2].try_into().unwrap());
    offset += 2;
    offset += encoded_window_len as usize * 4;

    let digestion_len = payload[offset] as usize;
    assert_eq!(digestion_len, u8::MAX as usize);
    offset += 1;

    let first_id = u32::from_le_bytes(payload[offset..offset + 4].try_into().unwrap());
    let last_offset = offset + (digestion_len - 1) * 12;
    let last_id = u32::from_le_bytes(payload[last_offset..last_offset + 4].try_into().unwrap());
    assert_eq!(first_id, 45);
    assert_eq!(last_id, 299);
}

#[test]
fn small_pellet_targets_and_shrinks_toward_target_head() {
    let mut state = make_state();
    let player_id = "pellet-lock-player".to_string();
    let snake = vec![
        SnakeNode {
            x: 1.0,
            y: 0.0,
            z: 0.0,
            pos_queue: VecDeque::new(),
        },
        SnakeNode {
            x: 0.9805806756909201,
            y: -0.19611613513818402,
            z: 0.0,
            pos_queue: VecDeque::new(),
        },
    ];
    state
        .players
        .insert(player_id.clone(), make_player(&player_id, snake));
    state.pellets.push(make_pellet(
        7,
        normalize(Point {
            x: 1.0,
            y: 0.03,
            z: 0.0,
        }),
    ));

    state.update_small_pellets(0.005);

    assert_eq!(state.pellets.len(), 1);
    let pellet = &state.pellets[0];
    match &pellet.state {
        PelletState::Attracting { target_player_id } => {
            assert_eq!(target_player_id, &player_id);
        }
        PelletState::Idle => panic!("pellet should target a nearby head"),
        PelletState::Evasive { .. } => panic!("pellet should not become evasive"),
    }
    assert!(pellet.current_size < pellet.base_size);
}

#[test]
fn small_pellet_near_attract_edge_moves_and_shrinks_before_consume() {
    let mut state = make_state();
    let player_id = "pellet-edge-player".to_string();
    let snake = vec![
        SnakeNode {
            x: 1.0,
            y: 0.0,
            z: 0.0,
            pos_queue: VecDeque::new(),
        },
        SnakeNode {
            x: 0.9805806756909201,
            y: -0.19611613513818402,
            z: 0.0,
            pos_queue: VecDeque::new(),
        },
    ];
    state
        .players
        .insert(player_id.clone(), make_player(&player_id, snake));

    let pellet_start = normalize(Point {
        x: 1.0,
        y: SMALL_PELLET_ATTRACT_RADIUS * 0.95,
        z: 0.0,
    });
    let mouth = normalize(Point {
        x: 1.0,
        y: SMALL_PELLET_MOUTH_FORWARD,
        z: 0.0,
    });
    let before_dot = dot(pellet_start, mouth);
    state.pellets.push(make_pellet(17, pellet_start));

    state.update_small_pellets(TICK_MS as f64 / 1000.0);

    assert_eq!(state.pellets.len(), 1);
    let pellet = &state.pellets[0];
    let after_dot = dot(pellet.normal, mouth);
    assert!(after_dot > before_dot);
    match &pellet.state {
        PelletState::Attracting { target_player_id } => {
            assert_eq!(target_player_id, &player_id);
        }
        PelletState::Idle => panic!("pellet should remain targeted while approaching"),
        PelletState::Evasive { .. } => panic!("pellet should not become evasive"),
    }
    assert!(pellet.current_size < pellet.base_size);
}

#[test]
fn small_pellet_targeting_prefers_nearest_mouth() {
    let mut state = make_state();
    let player_a_id = "pellet-target-a".to_string();
    let player_b_id = "pellet-target-b".to_string();

    let head_a = normalize(Point {
        x: 1.0,
        y: 0.0,
        z: 0.0,
    });
    let trailing_a = normalize(Point {
        x: 1.0,
        y: -0.05,
        z: 0.0,
    });
    state.players.insert(
        player_a_id.clone(),
        make_player(&player_a_id, make_snake_with_head(head_a, trailing_a, 2)),
    );

    let head_b = normalize(Point {
        x: 1.0,
        y: 0.03,
        z: 0.0,
    });
    let trailing_b = normalize(Point {
        x: 1.0,
        y: -0.02,
        z: 0.0,
    });
    state.players.insert(
        player_b_id.clone(),
        make_player(&player_b_id, make_snake_with_head(head_b, trailing_b, 2)),
    );

    let pellet_start = normalize(Point {
        x: 1.0,
        y: 0.04,
        z: 0.0,
    });
    state.pellets.push(make_pellet(901, pellet_start));

    state.update_small_pellets(0.0001);

    assert_eq!(state.pellets.len(), 1);
    match &state.pellets[0].state {
        PelletState::Attracting { target_player_id } => {
            assert_eq!(target_player_id, &player_b_id);
        }
        PelletState::Idle => panic!("pellet should target the nearest mouth"),
        PelletState::Evasive { .. } => panic!("pellet should not become evasive"),
    }
    assert!(state.pending_pellet_consumes.is_empty());
}

#[test]
fn small_pellet_targeting_ignores_pellets_outside_head_cone() {
    let mut state = make_state();
    let player_id = "pellet-cone-player".to_string();
    let toward_up = Point {
        x: 0.0,
        y: 1.0,
        z: 0.0,
    };
    let head = Point {
        x: 1.0,
        y: 0.0,
        z: 0.0,
    };
    // Trailing toward +Y makes the forward direction point toward -Y (away from pellet).
    let trailing = rotate_toward(head, toward_up, 0.05);
    state.players.insert(
        player_id.clone(),
        make_player(&player_id, make_snake_with_head(head, trailing, 2)),
    );

    let pellet_start = rotate_toward(head, toward_up, SMALL_PELLET_ATTRACT_RADIUS * 0.8);
    state.pellets.push(make_pellet(904, pellet_start));

    state.update_small_pellets(0.0001);

    assert_eq!(state.pellets.len(), 1);
    match &state.pellets[0].state {
        PelletState::Idle => {}
        PelletState::Attracting { .. } => {
            panic!("pellet outside the 90-degree head cone should not lock")
        }
        PelletState::Evasive { .. } => panic!("pellet should not become evasive"),
    }
    assert!(state.pending_pellet_consumes.is_empty());
}

#[test]
fn small_pellet_target_persists_for_boosting_target_while_valid() {
    let mut state = make_state();
    let player_a_id = "pellet-lock-boost-a".to_string();
    let player_b_id = "pellet-lock-boost-b".to_string();
    let toward_up = Point {
        x: 0.0,
        y: 1.0,
        z: 0.0,
    };
    let toward_down = Point {
        x: 0.0,
        y: -1.0,
        z: 0.0,
    };

    let head_a = Point {
        x: 1.0,
        y: 0.0,
        z: 0.0,
    };
    let trailing_a = rotate_toward(head_a, toward_down, 0.05);
    state.players.insert(
        player_a_id.clone(),
        make_player(&player_a_id, make_snake_with_head(head_a, trailing_a, 2)),
    );
    {
        let player_a = state
            .players
            .get_mut(&player_a_id)
            .expect("boosting target exists");
        player_a.boost = true;
        player_a.is_boosting = true;
    }

    let head_b = rotate_toward(head_a, toward_up, SMALL_PELLET_ATTRACT_RADIUS * 0.7);
    let trailing_b = rotate_toward(head_b, toward_up, 0.05);
    state.players.insert(
        player_b_id.clone(),
        make_player(&player_b_id, make_snake_with_head(head_b, trailing_b, 2)),
    );

    let pellet_start = rotate_toward(head_a, toward_up, SMALL_PELLET_ATTRACT_RADIUS * 0.2);
    state.pellets.push(make_pellet(902, pellet_start));

    state.update_small_pellets(0.0001);
    assert_eq!(state.pellets.len(), 1);
    match &state.pellets[0].state {
        PelletState::Attracting { target_player_id } => {
            assert_eq!(target_player_id, &player_a_id);
        }
        PelletState::Idle => panic!("pellet should target player A first"),
        PelletState::Evasive { .. } => panic!("pellet should not become evasive"),
    }

    // Move the pellet very close to player B's mouth; target should remain on player A because
    // the existing target is still valid/alive.
    state.pellets[0].normal = rotate_toward(head_b, toward_up, SMALL_PELLET_ATTRACT_RADIUS * 0.01);
    state.update_small_pellets(0.0001);

    assert_eq!(state.pellets.len(), 1);
    match &state.pellets[0].state {
        PelletState::Attracting { target_player_id } => {
            assert_eq!(target_player_id, &player_a_id);
        }
        PelletState::Idle => panic!("pellet target should persist on player A"),
        PelletState::Evasive { .. } => panic!("pellet should not become evasive"),
    }
    assert!(state.pending_pellet_consumes.is_empty());
}

#[test]
fn small_pellet_target_retargets_when_target_becomes_invalid() {
    let mut state = make_state();
    let player_a_id = "pellet-lock-retarget-a".to_string();
    let player_b_id = "pellet-lock-retarget-b".to_string();
    let toward_up = Point {
        x: 0.0,
        y: 1.0,
        z: 0.0,
    };
    let toward_down = Point {
        x: 0.0,
        y: -1.0,
        z: 0.0,
    };

    let head_a = Point {
        x: 1.0,
        y: 0.0,
        z: 0.0,
    };
    let trailing_a = rotate_toward(head_a, toward_down, 0.05);
    state.players.insert(
        player_a_id.clone(),
        make_player(&player_a_id, make_snake_with_head(head_a, trailing_a, 2)),
    );

    let head_b = rotate_toward(head_a, toward_up, SMALL_PELLET_ATTRACT_RADIUS * 0.7);
    let trailing_b = rotate_toward(head_b, toward_up, 0.05);
    state.players.insert(
        player_b_id.clone(),
        make_player(&player_b_id, make_snake_with_head(head_b, trailing_b, 2)),
    );

    let pellet_start = rotate_toward(head_a, toward_up, SMALL_PELLET_ATTRACT_RADIUS * 0.2);
    state.pellets.push(make_pellet(903, pellet_start));

    state.update_small_pellets(0.0001);
    assert_eq!(state.pellets.len(), 1);
    match &state.pellets[0].state {
        PelletState::Attracting { target_player_id } => {
            assert_eq!(target_player_id, &player_a_id);
        }
        PelletState::Idle => panic!("pellet should target player A first"),
        PelletState::Evasive { .. } => panic!("pellet should not become evasive"),
    }

    state
        .players
        .get_mut(&player_a_id)
        .expect("player A exists")
        .alive = false;
    state.pellets[0].normal = rotate_toward(head_b, toward_down, SMALL_PELLET_ATTRACT_RADIUS * 0.3);
    state.update_small_pellets(0.0001);

    assert_eq!(state.pellets.len(), 1);
    match &state.pellets[0].state {
        PelletState::Attracting { target_player_id } => {
            assert_eq!(target_player_id, &player_b_id);
        }
        PelletState::Idle => panic!("pellet should retarget to player B"),
        PelletState::Evasive { .. } => panic!("pellet should not become evasive"),
    }
    assert!(state.pending_pellet_consumes.is_empty());
}

#[test]
fn small_pellet_growth_is_fractional_before_full_score_tick() {
    let mut state = make_state();
    let player_id = "pellet-growth-player".to_string();
    let snake = vec![
        SnakeNode {
            x: 1.0,
            y: 0.0,
            z: 0.0,
            pos_queue: VecDeque::new(),
        },
        SnakeNode {
            x: 0.9805806756909201,
            y: -0.19611613513818402,
            z: 0.0,
            pos_queue: VecDeque::new(),
        },
    ];
    state
        .players
        .insert(player_id.clone(), make_player(&player_id, snake));
    let mouth = normalize(Point {
        x: 1.0,
        y: SMALL_PELLET_MOUTH_FORWARD,
        z: 0.0,
    });
    for i in 0..7u32 {
        state.pellets.push(make_pellet(i, mouth));
    }

    state.update_small_pellets(TICK_MS as f64 / 1000.0);
    assert_eq!(state.pending_pellet_consumes.len(), 7);
    assert!(state
        .pending_pellet_consumes
        .iter()
        .all(|(_, target)| target == &player_id));
    let player_after_partial = state.players.get(&player_id).expect("player");
    assert_eq!(player_after_partial.score, 0);
    assert_eq!(player_after_partial.digestions.len(), 1);
    assert!(player_after_partial.digestions[0].growth_amount > 0.034);
    assert!(player_after_partial.digestions[0].growth_amount < 0.036);
    assert!(player_after_partial.pellet_growth_fraction > 0.34);
    assert!(player_after_partial.pellet_growth_fraction < 0.36);

    for i in 0..193u32 {
        state.pellets.push(make_pellet(100 + i, mouth));
    }
    state.update_small_pellets(TICK_MS as f64 / 1000.0);
    let player_after_full = state.players.get(&player_id).expect("player");
    assert!(player_after_full.score >= 1);
    assert_eq!(player_after_full.digestions.len(), 2);
    assert!(player_after_full.pellet_growth_fraction < 1.0);
    assert!(player_after_full
        .digestions
        .iter()
        .all(|digestion| digestion.growth_amount > 0.0));
    assert!(player_after_full
        .digestions
        .iter()
        .all(|digestion| digestion.strength <= 1.0));
}

#[test]
fn death_pellet_grants_big_pellet_growth_fraction() {
    let mut state = make_state();
    let player_id = "death-pellet-growth-player".to_string();
    let snake = vec![
        SnakeNode {
            x: 1.0,
            y: 0.0,
            z: 0.0,
            pos_queue: VecDeque::new(),
        },
        SnakeNode {
            x: 0.9805806756909201,
            y: -0.19611613513818402,
            z: 0.0,
            pos_queue: VecDeque::new(),
        },
    ];
    state
        .players
        .insert(player_id.clone(), make_player(&player_id, snake));
    let mouth = normalize(Point {
        x: 1.0,
        y: SMALL_PELLET_MOUTH_FORWARD,
        z: 0.0,
    });
    state.pellets.push(Pellet {
        id: 700,
        normal: mouth,
        color_index: 0,
        base_size: DEATH_PELLET_SIZE_MIN,
        current_size: DEATH_PELLET_SIZE_MIN,
        growth_fraction: BIG_PELLET_GROWTH_FRACTION,
        state: PelletState::Idle,
    });

    state.update_small_pellets(TICK_MS as f64 / 1000.0);

    let player_after = state.players.get(&player_id).expect("player");
    assert_eq!(player_after.score, 1);
    assert!(player_after.pellet_growth_fraction.abs() < 0.01);
    assert!(player_after.digestions.iter().any(|digestion| {
        digestion.growth_amount >= BIG_PELLET_GROWTH_FRACTION - 1e-6
            && digestion.growth_amount <= BIG_PELLET_GROWTH_FRACTION + 1e-6
    }));
}

#[test]
fn evasive_spawn_targets_only_eligible_humans() {
    let mut state = make_state();
    state.environment.lakes.clear();
    state.environment.trees.clear();
    state.environment.mountains.clear();

    let eligible_id = "eligible-human".to_string();
    let eligible_snake = make_snake_with_head(
        Point {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        },
        Point {
            x: 0.9805806756909201,
            y: -0.19611613513818402,
            z: 0.0,
        },
        EVASIVE_PELLET_MIN_LEN,
    );
    state.players.insert(
        eligible_id.clone(),
        make_player(&eligible_id, eligible_snake),
    );

    let ineligible_id = "ineligible-human".to_string();
    let ineligible_snake = make_snake_with_head(
        Point {
            x: 0.0,
            y: 1.0,
            z: 0.0,
        },
        Point {
            x: 0.0,
            y: 0.98,
            z: -0.2,
        },
        EVASIVE_PELLET_MAX_LEN + 1,
    );
    state.players.insert(
        ineligible_id.clone(),
        make_player(&ineligible_id, ineligible_snake),
    );

    let bot_id = "eligible-bot".to_string();
    let bot_snake = make_snake_with_head(
        Point {
            x: 0.0,
            y: 0.0,
            z: 1.0,
        },
        Point {
            x: 0.0,
            y: -0.2,
            z: 0.98,
        },
        EVASIVE_PELLET_MIN_LEN,
    );
    let mut bot_player = make_player(&bot_id, bot_snake);
    bot_player.is_bot = true;
    state.players.insert(bot_id.clone(), bot_player);

    state.next_evasive_spawn_at.insert(eligible_id.clone(), 0);
    state.next_evasive_spawn_at.insert(ineligible_id, 0);
    state.next_evasive_spawn_at.insert(bot_id, 0);

    state.spawn_evasive_pellets(1);

    assert_eq!(state.pellets.len(), 1);
    let pellet = &state.pellets[0];
    assert!((pellet.growth_fraction - BIG_PELLET_GROWTH_FRACTION).abs() < 1e-9);
    match &pellet.state {
        PelletState::Evasive {
            owner_player_id, ..
        } => assert_eq!(owner_player_id, &eligible_id),
        _ => panic!("expected evasive pellet"),
    }
}

#[test]
fn evasive_spawn_respects_cooldown_and_active_cap() {
    let mut state = make_state();
    state.environment.lakes.clear();
    state.environment.trees.clear();
    state.environment.mountains.clear();

    let owner_id = "cooldown-owner".to_string();
    let snake = make_snake_with_head(
        Point {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        },
        Point {
            x: 0.9805806756909201,
            y: -0.19611613513818402,
            z: 0.0,
        },
        EVASIVE_PELLET_MIN_LEN,
    );
    state
        .players
        .insert(owner_id.clone(), make_player(&owner_id, snake));
    state.next_evasive_spawn_at.insert(owner_id.clone(), 0);

    state.spawn_evasive_pellets(1);
    assert_eq!(state.pellets.len(), 1);

    state.spawn_evasive_pellets(2);
    assert_eq!(state.pellets.len(), 1);

    let next_spawn_at = *state
        .next_evasive_spawn_at
        .get(&owner_id)
        .expect("cooldown exists");
    state.pellets.clear();
    state.spawn_evasive_pellets(next_spawn_at - 1);
    assert!(state.pellets.is_empty());

    state.spawn_evasive_pellets(next_spawn_at);
    assert_eq!(state.pellets.len(), 1);
}

#[test]
fn evasive_spawn_retries_when_no_safe_area_near_owner() {
    let mut state = make_state();
    state.environment.lakes.clear();
    state.environment.trees.clear();
    state.environment.mountains.clear();

    let owner_id = "crowded-owner".to_string();
    let owner_snake = make_snake_with_head(
        Point {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        },
        Point {
            x: 0.9805806756909201,
            y: -0.19611613513818402,
            z: 0.0,
        },
        EVASIVE_PELLET_MIN_LEN,
    );
    state
        .players
        .insert(owner_id.clone(), make_player(&owner_id, owner_snake));

    let blocker_id = "crowded-blocker".to_string();
    let blocker_snake = make_snake_with_head(
        Point {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        },
        Point {
            x: 0.9805806756909201,
            y: -0.19611613513818402,
            z: 0.0,
        },
        EVASIVE_PELLET_MIN_LEN,
    );
    state
        .players
        .insert(blocker_id.clone(), make_player(&blocker_id, blocker_snake));

    state.next_evasive_spawn_at.insert(owner_id.clone(), 0);
    state.next_evasive_spawn_at.insert(blocker_id.clone(), 0);

    state.spawn_evasive_pellets(1234);

    assert!(state.pellets.is_empty());
    assert_eq!(
        *state
            .next_evasive_spawn_at
            .get(&owner_id)
            .expect("owner timer"),
        1234 + EVASIVE_PELLET_RETRY_DELAY_MS
    );
}

#[test]
fn evasive_pellet_moves_away_from_owner() {
    let mut state = make_state();
    let owner_id = "evasive-owner".to_string();
    let snake = make_snake_with_head(
        Point {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        },
        Point {
            x: 0.9805806756909201,
            y: -0.19611613513818402,
            z: 0.0,
        },
        EVASIVE_PELLET_MIN_LEN,
    );
    state
        .players
        .insert(owner_id.clone(), make_player(&owner_id, snake));

    let start = normalize(Point {
        x: 1.0,
        y: 0.16,
        z: 0.0,
    });
    state.pellets.push(Pellet {
        id: 880,
        normal: start,
        color_index: 0,
        base_size: EVASIVE_PELLET_SIZE_MIN,
        current_size: EVASIVE_PELLET_SIZE_MIN,
        growth_fraction: BIG_PELLET_GROWTH_FRACTION,
        state: PelletState::Evasive {
            owner_player_id: owner_id,
            expires_at_ms: i64::MAX,
        },
    });

    let before_dot = dot(
        start,
        Point {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        },
    );
    state.update_small_pellets(TICK_MS as f64 / 1000.0);
    assert_eq!(state.pellets.len(), 1);
    let after_dot = dot(
        state.pellets[0].normal,
        Point {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        },
    );
    assert!(after_dot < before_dot);
}

#[test]
fn evasive_pellet_motion_step_is_capped_for_smoothness() {
    let mut state = make_state();
    let owner_id = "evasive-owner-smooth".to_string();
    let snake = make_snake_with_head(
        Point {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        },
        Point {
            x: 0.9805806756909201,
            y: -0.19611613513818402,
            z: 0.0,
        },
        EVASIVE_PELLET_MIN_LEN,
    );
    state
        .players
        .insert(owner_id.clone(), make_player(&owner_id, snake));
    state.pellets.push(Pellet {
        id: 883,
        normal: normalize(Point {
            x: 1.0,
            y: 0.2,
            z: 0.0,
        }),
        color_index: 0,
        base_size: EVASIVE_PELLET_SIZE_MIN,
        current_size: EVASIVE_PELLET_SIZE_MIN,
        growth_fraction: BIG_PELLET_GROWTH_FRACTION,
        state: PelletState::Evasive {
            owner_player_id: owner_id,
            expires_at_ms: i64::MAX,
        },
    });

    let dt = TICK_MS as f64 / 1000.0;
    let mut max_step = 0.0f64;
    for _ in 0..24 {
        let before = state.pellets[0].normal;
        state.update_small_pellets(dt);
        let after = state.pellets[0].normal;
        let step = clamp(dot(before, after), -1.0, 1.0).acos();
        assert!(step <= EVASIVE_PELLET_MAX_STEP_PER_TICK + 1e-6);
        max_step = max_step.max(step);
    }
    assert!(max_step > 1e-5);
}

#[test]
fn evasive_pellet_stays_put_when_owner_is_not_chasing() {
    let mut state = make_state();
    let owner_id = "evasive-owner-not-chasing".to_string();
    let snake = make_snake_with_head(
        Point {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        },
        Point {
            x: 0.9805806756909201,
            y: -0.19611613513818402,
            z: 0.0,
        },
        EVASIVE_PELLET_MIN_LEN,
    );
    state
        .players
        .insert(owner_id.clone(), make_player(&owner_id, snake));

    let behind_owner = normalize(Point {
        x: 1.0,
        y: -0.2,
        z: 0.0,
    });
    state.pellets.push(Pellet {
        id: 884,
        normal: behind_owner,
        color_index: 0,
        base_size: EVASIVE_PELLET_SIZE_MIN,
        current_size: EVASIVE_PELLET_SIZE_MIN,
        growth_fraction: BIG_PELLET_GROWTH_FRACTION,
        state: PelletState::Evasive {
            owner_player_id: owner_id,
            expires_at_ms: i64::MAX,
        },
    });

    let before = state.pellets[0].normal;
    state.update_small_pellets(TICK_MS as f64 / 1000.0);
    assert_eq!(state.pellets.len(), 1);
    let after = state.pellets[0].normal;
    let step = clamp(dot(before, after), -1.0, 1.0).acos();
    assert!(step <= 1e-6);
}

#[test]
fn evasive_pellet_suction_allows_non_owner_capture() {
    let mut state = make_state();
    let owner_id = "evasive-owner-suction".to_string();
    let owner_snake = make_snake_with_head(
        Point {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        },
        Point {
            x: 0.9805806756909201,
            y: -0.19611613513818402,
            z: 0.0,
        },
        EVASIVE_PELLET_MIN_LEN,
    );
    state
        .players
        .insert(owner_id.clone(), make_player(&owner_id, owner_snake));

    let rival_id = "evasive-rival-suction".to_string();
    let rival_head = Point {
        x: 0.0,
        y: 1.0,
        z: 0.0,
    };
    let rival_snake = make_snake_with_head(
        rival_head,
        Point {
            x: -0.2,
            y: 0.98,
            z: 0.0,
        },
        EVASIVE_PELLET_MIN_LEN,
    );
    state
        .players
        .insert(rival_id.clone(), make_player(&rival_id, rival_snake));

    let start = rotate_toward(
        rival_head,
        Point {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        },
        EVASIVE_PELLET_SUCTION_RADIUS * 0.6,
    );
    state.pellets.push(Pellet {
        id: 885,
        normal: start,
        color_index: 0,
        base_size: EVASIVE_PELLET_SIZE_MIN,
        current_size: EVASIVE_PELLET_SIZE_MIN,
        growth_fraction: BIG_PELLET_GROWTH_FRACTION,
        state: PelletState::Evasive {
            owner_player_id: owner_id,
            expires_at_ms: i64::MAX,
        },
    });

    for _ in 0..16 {
        state.update_small_pellets(TICK_MS as f64 / 1000.0);
        if state.pellets.is_empty() {
            break;
        }
    }
    assert!(state.pellets.is_empty());
    let rival_after = state.players.get(&rival_id).expect("rival");
    assert_eq!(rival_after.score, 1);
}

#[test]
fn evasive_pellet_expires_and_is_consumable_by_non_owner() {
    let mut state = make_state();
    let owner_id = "evasive-owner".to_string();
    let owner_snake = make_snake_with_head(
        Point {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        },
        Point {
            x: 0.9805806756909201,
            y: -0.19611613513818402,
            z: 0.0,
        },
        EVASIVE_PELLET_MIN_LEN,
    );
    state
        .players
        .insert(owner_id.clone(), make_player(&owner_id, owner_snake));

    state.pellets.push(Pellet {
        id: 881,
        normal: Point {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        },
        color_index: 0,
        base_size: EVASIVE_PELLET_SIZE_MIN,
        current_size: EVASIVE_PELLET_SIZE_MIN,
        growth_fraction: BIG_PELLET_GROWTH_FRACTION,
        state: PelletState::Evasive {
            owner_player_id: owner_id.clone(),
            expires_at_ms: 0,
        },
    });
    state.update_small_pellets(TICK_MS as f64 / 1000.0);
    assert!(state.pellets.is_empty());

    let rival_id = "evasive-rival".to_string();
    let rival_head = Point {
        x: 0.0,
        y: 1.0,
        z: 0.0,
    };
    let rival_snake = make_snake_with_head(
        rival_head,
        Point {
            x: -0.2,
            y: 0.98,
            z: 0.0,
        },
        EVASIVE_PELLET_MIN_LEN,
    );
    state
        .players
        .insert(rival_id.clone(), make_player(&rival_id, rival_snake));

    state.pellets.push(Pellet {
        id: 882,
        normal: rival_head,
        color_index: 0,
        base_size: EVASIVE_PELLET_SIZE_MIN,
        current_size: EVASIVE_PELLET_SIZE_MIN,
        growth_fraction: BIG_PELLET_GROWTH_FRACTION,
        state: PelletState::Evasive {
            owner_player_id: owner_id,
            expires_at_ms: i64::MAX,
        },
    });

    state.update_small_pellets(TICK_MS as f64 / 1000.0);
    assert!(state.pellets.is_empty());
    let rival_after = state.players.get(&rival_id).expect("rival");
    assert_eq!(rival_after.score, 1);
}

#[test]
fn small_pellet_consumes_when_head_moves_more_than_consume_angle_between_ticks() {
    let mut state = make_state();
    let player_id = "pellet-moving-mouth-player".to_string();
    let head = Point {
        x: 1.0,
        y: 0.0,
        z: 0.0,
    };
    let trailing = normalize(Point {
        x: 1.0,
        y: -0.05,
        z: 0.0,
    });
    state.players.insert(
        player_id.clone(),
        make_player(
            &player_id,
            vec![
                SnakeNode {
                    x: head.x,
                    y: head.y,
                    z: head.z,
                    pos_queue: VecDeque::new(),
                },
                SnakeNode {
                    x: trailing.x,
                    y: trailing.y,
                    z: trailing.z,
                    pos_queue: VecDeque::new(),
                },
            ],
        ),
    );
    let travel_target = Point {
        x: 0.0,
        y: 1.0,
        z: 0.0,
    };
    let pellet_start = rotate_toward(head, travel_target, SMALL_PELLET_CONSUME_ANGLE * 8.0);
    state.pellets.push(make_pellet(701, pellet_start));

    let dt_seconds = TICK_MS as f64 / 1000.0;
    let head_step = SMALL_PELLET_CONSUME_ANGLE * 1.25;
    for _ in 0..12 {
        state.update_small_pellets(dt_seconds);
        if state.pellets.is_empty() {
            break;
        }
        let player = state.players.get_mut(&player_id).expect("player");
        let old_head = Point {
            x: player.snake[0].x,
            y: player.snake[0].y,
            z: player.snake[0].z,
        };
        let next_head = rotate_toward(old_head, travel_target, head_step);
        player.snake[1] = SnakeNode {
            x: old_head.x,
            y: old_head.y,
            z: old_head.z,
            pos_queue: VecDeque::new(),
        };
        player.snake[0] = SnakeNode {
            x: next_head.x,
            y: next_head.y,
            z: next_head.z,
            pos_queue: VecDeque::new(),
        };
    }

    assert!(state.pellets.is_empty());
    let player_after = state.players.get(&player_id).expect("player");
    assert_eq!(player_after.digestions.len(), 1);
}

#[test]
fn snake_window_uses_partial_window_for_remote_players() {
    let state = make_state();
    let player = make_player(
        "player-window",
        snake_from_xs(&[
            -0.9, -0.8, -0.7, -0.6, -0.5, -0.2, 0.92, 0.9, -0.1, -0.2, -0.3, -0.4, -0.5, -0.6,
        ]),
    );

    let view_cos = (0.6f64 + VIEW_RADIUS_MARGIN).cos();
    let window = state.snake_window_for_player(
        &player,
        false,
        Some((
            Point {
                x: 1.0,
                y: 0.0,
                z: 0.0,
            },
            view_cos,
        )),
    );

    assert_eq!(window.detail, SnakeDetail::Window);
    assert_eq!(window.total_len, 14);
    assert_eq!(window.start, 3);
    assert_eq!(window.len, 8);
}

#[test]
fn snake_window_returns_stub_when_remote_snake_is_out_of_view() {
    let state = make_state();
    let player = make_player(
        "player-stub",
        snake_from_xs(&[-0.95, -0.9, -0.88, -0.85, -0.82]),
    );
    let view_cos = (0.45f64 + VIEW_RADIUS_MARGIN).cos();
    let window = state.snake_window_for_player(
        &player,
        false,
        Some((
            Point {
                x: 1.0,
                y: 0.0,
                z: 0.0,
            },
            view_cos,
        )),
    );
    assert_eq!(window.detail, SnakeDetail::Stub);
    assert_eq!(window.total_len, 5);
}

#[test]
fn build_state_delta_payload_for_session_excludes_stub_remote_players() {
    let mut state = make_state();
    let local_id = "local-player".to_string();
    let visible_remote_id = "visible-remote".to_string();
    let hidden_remote_id = "hidden-remote".to_string();

    state.players.insert(
        local_id.clone(),
        make_player(&local_id, snake_from_xs(&[0.2, 0.1, 0.0, -0.1])),
    );
    state.players.insert(
        visible_remote_id,
        make_player("visible-remote", snake_from_xs(&[0.96, 0.94, 0.9, 0.86])),
    );
    state.players.insert(
        hidden_remote_id,
        make_player("hidden-remote", snake_from_xs(&[-0.95, -0.92, -0.9, -0.88])),
    );
    insert_session_with_view(
        &mut state,
        "session-1",
        &local_id,
        Some(Point {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        }),
        Some(0.45),
    );

    let payload = state
        .build_state_delta_payload_for_session(1234, 77, "session-1")
        .expect("state delta payload");
    let (state_seq, total_players, visible_players) = decode_state_counts(&payload);
    assert_eq!(state_seq, 77);
    assert_eq!(total_players, 3);
    assert_eq!(visible_players, 2);
}

#[test]
fn build_init_payload_for_session_uses_view_scoped_player_count() {
    let mut state = make_state();
    let local_id = "local-player".to_string();
    state.players.insert(
        local_id.clone(),
        make_player(&local_id, snake_from_xs(&[0.2, 0.1, 0.0, -0.1])),
    );
    state.players.insert(
        "visible-remote".to_string(),
        make_player("visible-remote", snake_from_xs(&[0.96, 0.94, 0.9, 0.86])),
    );
    state.players.insert(
        "hidden-remote".to_string(),
        make_player("hidden-remote", snake_from_xs(&[-0.95, -0.92, -0.9, -0.88])),
    );
    insert_session_with_view(
        &mut state,
        "session-2",
        &local_id,
        Some(Point {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        }),
        Some(0.45),
    );

    let payload = state.build_init_payload_for_session("session-2", &local_id);
    let (state_seq, total_players, visible_players) = decode_init_counts(&payload);
    assert_eq!(state_seq, state.next_state_seq.wrapping_sub(1));
    assert_eq!(total_players, 3);
    assert_eq!(visible_players, 2);
}

#[test]
fn build_state_delta_payload_includes_local_player_when_local_snake_is_empty() {
    let mut state = make_state();
    let local_id = "local-empty".to_string();
    let mut local_player = make_player(&local_id, Vec::new());
    local_player.alive = false;
    state.players.insert(local_id.clone(), local_player);
    state.players.insert(
        "hidden-remote".to_string(),
        make_player("hidden-remote", snake_from_xs(&[-0.95, -0.92, -0.9, -0.88])),
    );
    insert_session_with_view(
        &mut state,
        "session-3",
        &local_id,
        Some(Point {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        }),
        Some(0.45),
    );

    let payload = state
        .build_state_delta_payload_for_session(1234, 91, "session-3")
        .expect("state delta payload");
    let (state_seq, total_players, visible_players) = decode_state_counts(&payload);
    assert_eq!(state_seq, 91);
    assert_eq!(total_players, 2);
    assert_eq!(visible_players, 1);
}

#[test]
fn broadcast_state_delta_increments_state_sequence_once_per_tick() {
    let mut state = make_state();
    let outbound_state = Arc::new(LatestFrame::new());
    let (outbound_hi, _outbound_hi_rx) = mpsc::channel::<Vec<u8>>(1);
    let (outbound_lo, _outbound_lo_rx) = mpsc::channel::<Vec<u8>>(1);
    let inbound = Arc::new(SessionInbound::new());
    state.sessions.insert(
        "session-seq".to_string(),
        SessionEntry {
            outbound_state: Arc::clone(&outbound_state),
            outbound_hi,
            outbound_lo,
            inbound,
            player_id: None,
            view_center: None,
            view_radius: None,
            camera_distance: None,
            pellet_view_ids: HashSet::new(),
            pellet_view_initialized: false,
            pellet_reset_retry_at: 0,
            delta_player_cache: HashMap::new(),
            force_next_keyframe: true,
        },
    );

    state.broadcast_state_delta(1234, state.next_state_seq);
    let first_payload = outbound_state.take_latest().expect("first payload");
    state.next_state_seq = state.next_state_seq.wrapping_add(1);
    state.broadcast_state_delta(1234, state.next_state_seq);
    let second_payload = outbound_state.take_latest().expect("second payload");
    state.next_state_seq = state.next_state_seq.wrapping_add(1);

    let (first_seq, _, _) = decode_state_counts(&first_payload);
    let (second_seq, _, _) = decode_state_counts(&second_payload);
    assert_eq!(second_seq, first_seq.wrapping_add(1));
}

fn make_full_lake_state() -> RoomState {
    use crate::game::environment::Lake;
    let mut state = make_state();
    state.environment.trees.clear();
    state.environment.mountains.clear();
    state.environment.lakes = vec![Lake {
        center: Point {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        },
        radius: std::f64::consts::PI,
        depth: 0.2,
        shelf_depth: 0.1,
        edge_falloff: 0.05,
        noise_amplitude: 0.0,
        noise_frequency: 1.0,
        noise_frequency_b: 1.0,
        noise_frequency_c: 1.0,
        noise_phase: 0.0,
        noise_phase_b: 0.0,
        noise_phase_c: 0.0,
        warp_amplitude: 0.0,
        surface_inset: 0.08,
        tangent: Point {
            x: 0.0,
            y: 1.0,
            z: 0.0,
        },
        bitangent: Point {
            x: 0.0,
            y: 0.0,
            z: 1.0,
        },
    }];
    state
}

fn make_cactus_collision_state(cactus_normal: Point, cactus_width_scale: f64) -> RoomState {
    use crate::game::environment::TreeInstance;
    let mut state = make_state();
    state.environment.lakes.clear();
    state.environment.mountains.clear();
    state.environment.trees = vec![TreeInstance {
        normal: cactus_normal,
        width_scale: -cactus_width_scale.abs(),
        height_scale: 1.0,
        twist: 0.0,
    }];
    state
}

#[test]
fn cactus_collision_kills_on_head_contact() {
    let mut state = make_cactus_collision_state(
        Point {
            x: 0.0,
            y: 0.0,
            z: -1.0,
        },
        1.0,
    );
    let player_id = "player-cactus-hit".to_string();
    let mut snake = create_snake(Point {
        x: 1.0,
        y: 0.0,
        z: 0.0,
    });
    snake.truncate(2);
    let mut player = make_player(&player_id, snake);
    player.axis = Point {
        x: 0.0,
        y: 0.0,
        z: -1.0,
    };
    player.target_axis = player.axis;
    state.players.insert(player_id.clone(), player);

    state.tick();

    let player = state.players.get(&player_id).expect("player");
    assert!(!player.alive);
}

#[test]
fn cactus_collision_does_not_kill_without_contact() {
    let mut state = make_cactus_collision_state(
        Point {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        },
        1.0,
    );
    let player_id = "player-cactus-safe".to_string();
    let mut snake = create_snake(Point {
        x: 1.0,
        y: 0.0,
        z: 0.0,
    });
    snake.truncate(2);
    let mut player = make_player(&player_id, snake);
    player.axis = Point {
        x: 0.0,
        y: 0.0,
        z: -1.0,
    };
    player.target_axis = player.axis;
    state.players.insert(player_id.clone(), player);

    state.tick();

    let player = state.players.get(&player_id).expect("player");
    assert!(player.alive);
}

#[test]
fn forest_tree_collision_is_not_instant_death() {
    use crate::game::environment::TreeInstance;
    let mut state = make_state();
    state.environment.lakes.clear();
    state.environment.mountains.clear();
    state.environment.trees = vec![TreeInstance {
        normal: Point {
            x: 0.0,
            y: 0.0,
            z: -1.0,
        },
        width_scale: 1.0,
        height_scale: 1.0,
        twist: 0.0,
    }];
    let player_id = "player-forest-tree".to_string();
    let mut snake = create_snake(Point {
        x: 1.0,
        y: 0.0,
        z: 0.0,
    });
    snake.truncate(2);
    let mut player = make_player(&player_id, snake);
    player.axis = Point {
        x: 0.0,
        y: 0.0,
        z: -1.0,
    };
    player.target_axis = player.axis;
    state.players.insert(player_id.clone(), player);

    state.tick();

    let player = state.players.get(&player_id).expect("player");
    assert!(player.alive);
}

#[test]
fn oxygen_depletion_kills_immediately_when_empty() {
    let mut state = make_full_lake_state();
    let player_id = "player-oxygen-immediate".to_string();
    let mut player = make_player(
        &player_id,
        create_snake(Point {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        }),
    );
    player.oxygen = 0.0;
    state.players.insert(player_id.clone(), player);

    state.tick();

    let player = state.players.get(&player_id).expect("player");
    assert!(!player.alive);
    assert_eq!(player.score, 0);
}

#[test]
fn oxygen_depletion_kills_at_min_survival_length() {
    let mut state = make_full_lake_state();
    let player_id = "player-oxygen-min".to_string();
    let mut snake = create_snake(Point {
        x: 1.0,
        y: 0.0,
        z: 0.0,
    });
    snake.truncate(MIN_SURVIVAL_LENGTH);
    let mut player = make_player(&player_id, snake);
    player.oxygen = 0.0;
    state.players.insert(player_id.clone(), player);

    state.tick();

    let player = state.players.get(&player_id).expect("player");
    assert!(!player.alive);
    assert_eq!(player.score, 0);
}

#[test]
fn oxygen_replenishes_when_not_underwater() {
    let mut state = make_full_lake_state();
    let player_id = "player-oxygen-reset".to_string();
    let mut player = make_player(
        &player_id,
        create_snake(Point {
            x: 1.0,
            y: 0.0,
            z: 0.0,
        }),
    );
    player.oxygen = 0.5;
    player.connected = false;
    player.last_seen = RoomState::now_millis();
    state.players.insert(player_id.clone(), player);

    state.tick();
    let oxygen_underwater = state.players.get(&player_id).expect("player").oxygen;
    assert!(oxygen_underwater < 0.5);
    assert!(oxygen_underwater > 0.0);

    state.environment.lakes.clear();
    state.tick();

    let player = state.players.get(&player_id).expect("player");
    assert!(player.alive);
    assert_eq!(player.oxygen, OXYGEN_MAX);
    assert_eq!(player.oxygen_damage_accumulator, 0.0);
    assert_eq!(player.snake.len(), 8);
}
