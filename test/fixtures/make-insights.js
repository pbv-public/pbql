// Deterministic hand-checkable insights fixtures in the production (4.x,
// augmented-names) shape. The numbers below are referenced by exact value
// in the engine/model tests — change them and the hand-computed
// expectations change too.

function traj ({ from, to, peak, startMs, endMs, fromZone = 'deep', toZone = 'deep' }) {
  return {
    confidence: 0.95,
    start: { zone: fromZone, location: from, ms: startMs },
    peak,
    end: { zone: toZone, location: to, ms: endMs }
  }
}

export function makeShot ({
  playerId, startMs, endMs, from, to, peak = { x: 10, y: 22, z: 8 },
  fromZone, toZone, speed = 30, type = 'drive', isFinal = false,
  quality = { overall: 0.8, execution: 0.7 },
  playerPositions, extra = {}
}) {
  return {
    player_id: playerId,
    start_ms: startMs - 100, // trajectory timing is 100ms inside start/end_ms
    end_ms: endMs + 100,
    is_final: isFinal,
    quality,
    shot_type: type,
    player_positions: playerPositions,
    resulting_ball_movement: {
      speed,
      distance: 40,
      crossed_net: true,
      is_volleyed: false,
      angles: { yaw: 88, pitch: 20, direction: 'DownTheMiddle' },
      trajectory: traj({ from, to, peak, startMs, endMs, fromZone, toZone })
    },
    ...extra
  }
}

export function makeDoublesInsights () {
  return {
    version: '4.11.0',
    session: { vid: 'testvid00001', session_index: 0, num_players: 4, session_type: 'game' },
    camera: { fps: 30 },
    game_data: {
      game_outcome: [11, 9],
      scoring: 'side_out',
      min_points: 11,
      avg_shots: 3,
      longest_rally: { rally_idx: 2, num_shots: 4 },
      kitchen_rallies: 1
    },
    player_data: [
      // handedness is host-augmented data (absent in bucket insights): p0
      // right, p1 left, p2 untagged, p3 "both" (unusable for strokeType).
      // positional_performance is team-level: teammates share the value and
      // team 1's is the complement of team 0's.
      // trends.ratings is the single-game rating: p0 rated on every area,
      // p1 on one only, p2 rated nothing at all, p3 carries no trends -- so
      // every way a rating can go unknown is represented.
      {
        team: 0,
        name: 'Player 1',
        avatar_id: 0,
        handedness: 'right',
        positional_performance: { forward_pressure: 0.6, finishing_ability: 0.4 },
        trends: {
          ratings: {
            overall: 3.75,
            kitchen_game: 3.5,
            ball_control: 3.25,
            defense: 3,
            offense: 4,
            court_iq: 3.6,
            targeting: 3.9
          }
        }
      },
      {
        team: 0,
        name: 'Player 2',
        avatar_id: 1,
        handedness: 'left',
        positional_performance: { forward_pressure: 0.6, finishing_ability: 0.4 },
        trends: { ratings: { overall: 2.5 } }
      },
      {
        team: 1,
        name: 'Player 3',
        avatar_id: 2,
        positional_performance: { forward_pressure: 0.4, finishing_ability: 0.6 },
        trends: { ratings: {} }
      },
      {
        team: 1,
        name: 'Player 4',
        avatar_id: 3,
        handedness: 'both',
        positional_performance: { forward_pressure: 0.4, finishing_ability: 0.6 }
      }
    ],
    highlights: [
      { kind: 'atp', s: 17500, e: 19500, score: 0.9, rally_idx: 0, shot_idx: 2 }
    ],
    rallies: [
      { // rally 0: serve, drop return, smash winner — team 0 wins
        start_ms: 10000,
        end_ms: 24000,
        winning_team: 0,
        players: [
          { started_on_left_side: true, kitchen_arrivals: [{ since_ms: 13000, ft_moved: { x: 1, y: 10 } }] },
          { started_on_left_side: false },
          { started_on_left_side: true, kitchen_arrivals: [{ since_ms: 14000, ft_moved: { x: 1, y: 10 } }] },
          { started_on_left_side: false, kitchen_arrivals: [] }
        ],
        shots: [
          makeShot({ // p0 serves from the near side
            playerId: 0,
            startMs: 12000,
            endMs: 13000,
            from: { x: 5, y: 2, z: 2.5 },
            to: { x: 15, y: 40, z: 1 },
            speed: 35,
            playerPositions: [{ x: 5, y: 2 }, { x: 15, y: 3 }, { x: 4, y: 41 }, { x: 16, y: 42 }],
            extra: {
              stroke_side: 'right', // p0 is right-handed: a forehand
              vertical_type: 'neutral',
              is_volley: false
            }
          }),
          makeShot({ // p1... no: p2 returns a drop from the far side
            playerId: 2,
            startMs: 15000,
            endMs: 16000,
            from: { x: 15, y: 40, z: 3 }, // hitter-frame x'=15, y'=4
            to: { x: 6, y: 8, z: 0.5 },
            toZone: 'short',
            speed: 20,
            type: 'drop',
            quality: { overall: 0.9, execution: 0.9 },
            playerPositions: [{ x: 5, y: 10 }, { x: 15, y: 8 }, { x: 15, y: 40 }, { x: 16, y: 41 }],
            // p2's handedness is untagged, so this stroke has no strokeType
            extra: { is_volley: false, stroke_side: 'left', errors: { popup: 'potential' } }
          }),
          makeShot({ // p1 smashes a volley winner
            playerId: 1,
            startMs: 18000,
            endMs: 19000,
            from: { x: 14, y: 12, z: 4 },
            to: { x: 16, y: 38, z: 0 },
            speed: 45,
            type: 'smash',
            isFinal: true,
            // pressure is omitted for serves/returns, so it starts on shot 3
            quality: { overall: 0.95, execution: 0.95, pressure: 0.85 },
            // p1's opponents hold the far half; in their own frame x' = raw
            // x, so p2 (abs x=6) plays their left side, p3 (x=15) their right
            playerPositions: [{ x: 5, y: 14 }, { x: 14, y: 12 }, { x: 6, y: 26 }, { x: 15, y: 28 }],
            extra: {
              is_volley: true,
              stroke_side: 'right', // p1 is left-handed: a backhand
              winner_type: 'clean',
              shooter_movement_from_last_shot: { x: 1, y: 2 },
              shooter_positioning_score: 0.9,
              partner_positioning_score: 0.75
            }
          })
        ]
      },
      { // rally 1: serve + botched return into the net — team 1 wins
        start_ms: 30000,
        end_ms: 40000,
        winning_team: 1,
        players: [
          { started_on_left_side: true },
          { started_on_left_side: false },
          { started_on_left_side: false },
          { started_on_left_side: true }
        ],
        shots: [
          makeShot({ // p2 serves from the far side
            playerId: 2,
            startMs: 32000,
            endMs: 33200,
            from: { x: 14, y: 42, z: 2 },
            to: { x: 5, y: 5, z: 0.8 },
            speed: 38,
            quality: { overall: 0.6 },
            playerPositions: [{ x: 6, y: 1 }, { x: 15, y: 2 }, { x: 14, y: 42 }, { x: 5, y: 43 }]
          }),
          { // p0's return dies in the net: sparse shot (no trajectory at all)
            player_id: 0,
            start_ms: 35000,
            end_ms: 35600,
            is_final: true,
            quality: { overall: 0.2 },
            // fault flags are present only when true (4.11)
            errors: { unforced: true, faults: { net: true } }
          }
        ]
      },
      { // rally 2: four timed shots for context-window tests — team 0 wins
        start_ms: 50000,
        end_ms: 64000,
        winning_team: 0,
        players: [
          { started_on_left_side: true, kitchen_arrivals: [{ since_ms: 53000, ft_moved: { x: 0, y: 8 } }] },
          { started_on_left_side: false, kitchen_arrivals: [{ since_ms: 54000, ft_moved: { x: 0, y: 9 } }] },
          { started_on_left_side: true, kitchen_arrivals: [{ since_ms: 53500, ft_moved: { x: 1, y: 8 } }] },
          { started_on_left_side: false, kitchen_arrivals: [{ since_ms: 56000, ft_moved: { x: 1, y: 7 } }] }
        ],
        shots: [
          makeShot({
            playerId: 0,
            startMs: 52000,
            endMs: 53000,
            from: { x: 5, y: 2, z: 2 },
            to: { x: 12, y: 39, z: 1 },
            playerPositions: [{ x: 5, y: 2 }, { x: 15, y: 3 }, { x: 5, y: 42 }, { x: 15, y: 41 }]
          }),
          makeShot({
            playerId: 2,
            startMs: 55000,
            endMs: 56000,
            from: { x: 10, y: 38, z: 1.5 },
            to: { x: 8, y: 10, z: 0.7 },
            playerPositions: [{ x: 5, y: 8 }, { x: 15, y: 9 }, { x: 10, y: 38 }, { x: 15, y: 39 }]
          }),
          makeShot({ // the game's fastest shot; hit by p1 at the kitchen line
            // (a speedup is the is_speedup flag on a drive, never a type)
            playerId: 1,
            startMs: 58000,
            endMs: 59000,
            from: { x: 14, y: 15, z: 3.5 },
            to: { x: 4, y: 30, z: 0.4 },
            speed: 50,
            quality: { overall: 0.85, pressure: 0.6 },
            playerPositions: [{ x: 5, y: 15 }, { x: 14, y: 15 }, { x: 7, y: 27 }, { x: 15, y: 29 }],
            // p1 is left-handed, so a left-side stroke is a forehand
            extra: {
              is_volley: true,
              is_speedup: true,
              stroke_side: 'left',
              shooter_positioning_score: 0.45,
              partner_positioning_score: 0.5
            }
          }),
          makeShot({ // p3 sails it long
            playerId: 3,
            startMs: 61000,
            endMs: 62000,
            from: { x: 15, y: 30, z: 2 },
            to: { x: 10, y: -1, z: 0 },
            toZone: 'out',
            isFinal: true,
            quality: { overall: 0.3 },
            playerPositions: [{ x: 6, y: 16 }, { x: 14, y: 16 }, { x: 8, y: 28 }, { x: 15, y: 30 }],
            extra: {
              stroke_side: 'right', // p3's handedness is "both": no strokeType
              // no net/short flags: absent fault flags mean false (4.11)
              errors: {
                unforced: true,
                faults: { out: { outcome: 'landed', direction: 'long' } }
              }
            }
          })
        ]
      }
    ]
  }
}

export function makeSinglesInsights () {
  return {
    version: '4.11.0',
    session: { vid: 'testvid00002', session_index: 0, num_players: 2, session_type: 'game' },
    camera: { fps: 30 },
    game_data: {
      game_outcome: ['lost', 'won'],
      scoring: 'side_out',
      min_points: 11,
      avg_shots: 2,
      longest_rally: { rally_idx: 0, num_shots: 2 },
      kitchen_rallies: 0
    },
    player_data: [
      { team: 0, name: 'Player 1', avatar_id: 0 },
      null,
      { team: 1, name: 'Player 3', avatar_id: 1 },
      null
    ],
    highlights: [],
    rallies: [{
      start_ms: 5000,
      end_ms: 12000,
      winning_team: 1,
      players: [
        { started_on_left_side: true },
        null,
        { started_on_left_side: false },
        null
      ],
      shots: [
        makeShot({
          playerId: 0,
          startMs: 6000,
          endMs: 7000,
          from: { x: 5, y: 2, z: 2 },
          to: { x: 12, y: 40, z: 1 },
          playerPositions: [{ x: 5, y: 2 }, null, { x: 12, y: 41 }, null]
        }),
        makeShot({
          playerId: 2,
          startMs: 9000,
          endMs: 10000,
          from: { x: 12, y: 40, z: 2 },
          to: { x: 4, y: 8, z: 0.3 },
          isFinal: true,
          playerPositions: [{ x: 6, y: 6 }, null, { x: 12, y: 40 }, null],
          extra: { winner_type: 'clean' }
        })
      ]
    }]
  }
}

export const TEST_META = {
  myPlayerIdx: 0,
  videoName: 'Test Game',
  gameEpoch: 1735732800, // 2025-01-01T12:00:00Z

  players: [
    { name: 'Alice', addr: 'alice@example.com' },
    { name: 'Bob' },
    { name: 'Carol' },
    { name: 'Dan' }
  ]
}

export function makeDoublesGame () {
  return {
    vid: 'testvid00001',
    sessionIdx: 0,
    insights: makeDoublesInsights(),
    meta: TEST_META
  }
}

export function makeSinglesGame () {
  return {
    vid: 'testvid00002',
    sessionIdx: 0,
    insights: makeSinglesInsights(),
    meta: { myPlayerIdx: 0, players: [{ name: 'Alice' }, null, { name: 'Carol' }, null] }
  }
}
