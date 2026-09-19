use spacetimedb::{spacetimedb, Identity, Timestamp, ReducerContext};

#[spacetimedb(table, public)]
pub struct PlayerState {
    #[primarykey]
    pub player_id: String,
    pub position_x: f32,
    pub position_y: f32,
    pub position_z: f32,
    pub pitch: f32,
    pub roll: f32,
    pub yaw: f32,
    pub suit_health: f32,
    pub mode: String,       // "GLOVE" | "PHONE" | "KEYBOARD"
    pub is_connected: bool,
    pub updated_at: Timestamp,
}

#[spacetimedb(table, public)]
pub struct SentinelState {
    #[primarykey]
    pub sentinel_id: u32,
    pub position_x: f32,
    pub position_y: f32,
    pub position_z: f32,
    pub health: f32,
    pub target_player_id: String,
    pub patrol_index: u32,
}

#[spacetimedb(table, public)]
pub struct GameEvent {
    pub event_id: u64,
    pub event_type: String,   // "DAMAGE" | "KILL" | "CRASH" | "THREAT"
    pub player_id: String,
    pub detail: String,
    pub timestamp: Timestamp,
}

#[spacetimedb(reducer)]
pub fn join_game(ctx: ReducerContext, player_id: String, mode: String) {
    PlayerState::insert(PlayerState {
        player_id,
        position_x: -76.6205,
        position_y: 150.0,
        position_z: 39.3299,
        pitch: 0.0,
        roll: 0.0,
        yaw: 0.0,
        suit_health: 100.0,
        mode,
        is_connected: true,
        updated_at: ctx.timestamp,
    }).expect("join_game: insert failed");
}

#[spacetimedb(reducer)]
pub fn update_orientation(
    ctx: ReducerContext,
    player_id: String,
    pitch: f32,
    roll: f32,
    yaw: f32,
    mode: String,
) {
    if let Some(mut state) = PlayerState::filter_by_player_id(&player_id) {
        state.pitch = pitch;
        state.roll = roll;
        state.yaw = yaw;
        state.mode = mode;
        state.updated_at = ctx.timestamp;

        let speed: f32 = 12.0;
        state.position_x += yaw.sin() * speed * 0.016;
        state.position_z += yaw.cos() * speed * 0.016;

        PlayerState::update_by_player_id(&player_id, state);
    }
}

#[spacetimedb(reducer)]
pub fn apply_damage(ctx: ReducerContext, target_id: String, amount: f32) {
    if let Some(mut state) = PlayerState::filter_by_player_id(&target_id) {
        state.suit_health = (state.suit_health - amount).max(0.0);
        let crashed = state.suit_health <= 0.0;
        PlayerState::update_by_player_id(&target_id, state);

        if crashed {
            GameEvent::insert(GameEvent {
                event_id: ctx.timestamp.micros_since_epoch as u64,
                event_type: "CRASH".to_string(),
                player_id: target_id,
                detail: "Suit destroyed".to_string(),
                timestamp: ctx.timestamp,
            }).ok();
        }
    }
}

#[spacetimedb(reducer, repeat = 100ms)]
pub fn tick_sentinels(ctx: ReducerContext) {
    let waypoints: &[(f32, f32, f32)] = &[
        (-76.6218, 150.0, 39.3302),
        (-76.6205, 150.0, 39.3299),
        (-76.6201, 150.0, 39.3308),
        (-76.6189, 150.0, 39.3290),
        (-76.6225, 150.0, 39.3315),
    ];

    for mut sentinel in SentinelState::iter() {
        let wp = waypoints[sentinel.patrol_index as usize % waypoints.len()];
        let dx = wp.0 - sentinel.position_x;
        let dz = wp.2 - sentinel.position_z;
        let dist = (dx * dx + dz * dz).sqrt();

        if dist < 0.001 {
            sentinel.patrol_index = (sentinel.patrol_index + 1) % waypoints.len() as u32;
        } else {
            let speed = 0.00005_f32;
            sentinel.position_x += dx / dist * speed;
            sentinel.position_z += dz / dist * speed;
        }

        SentinelState::update_by_sentinel_id(&sentinel.sentinel_id, sentinel);
    }
}
