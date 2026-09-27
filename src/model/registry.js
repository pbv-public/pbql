// The PBQL property surface: every queryable property, with type/unit/doc
// (which generate docs/data-dictionary.md — run `yarn docs`) and an
// extract() that reads it from insights JSON (latest major, augmented
// names). extract() returns undefined when the underlying data is missing;
// the engine maps that to `unknown`.
//
// extract(ctx) receives { game, rally, rallyIdx, shot, shotIdx } (a Game
// instance plus the shot being evaluated); player properties additionally
// receive the player index.
import {
  feetToNet, feetToNearestBaseline, feetToNearestSideline,
  feetToKitchen, isOnFarSide, toPlayerFrame
} from './geometry.js'

// a game is singles when only two player slots are occupied
function isSingles (game) {
  return game.insights.session?.num_players === 2
}

// this team's partner: 0↔1, 2↔3
const partnerOf = idx => idx ^ 1

// "near the kitchen" = within this many feet of one's own kitchen line;
// matches the analysis pipeline's kitchen-arrival threshold (CV positions
// carry enough uncertainty that a tight cutoff would miss real arrivals)
const NEAR_KITCHEN_FT = 4

// the opposing pair, in player-id order, for a player on either team
const opponentsOf = idx => idx < 2 ? [2, 3] : [0, 1]

// LHS/RHS resolution: the opponent playing the left/right side of their
// own court at the moment of `ctx`'s shot — left of their partner in the
// opponents' own facing, i.e. the smaller x in each opponent's own frame.
// In singles the lone opponent answers both sides; unknown when their
// positions are missing.
function opponentBySide (ctx, from, wantLHS) {
  const opponents = opponentsOf(from)
  if (isSingles(ctx.game)) {
    return opponents[0]
  }
  const positions = opponents.map(idx => ctx.game.playerPosAtShot(ctx.shot, idx))
  if (positions.some(p => p === undefined)) {
    return undefined
  }
  const [a, b] = positions.map(p => toPlayerFrame(p, isOnFarSide(p)).x)
  const [lhs, rhs] = a <= b ? opponents : [opponents[1], opponents[0]]
  return wantLHS ? lhs : rhs
}

function ballMovement (ctx) {
  return ctx.shot.resulting_ball_movement
}

function trajectory (ctx) {
  return ballMovement(ctx)?.trajectory
}

// The shared shape of a position (shot.from / shot.to / shot.peak):
// hitter-relative x/y/z, raw absX/absY/absZ, and derived distances.
// Exported so the generated docs describe the position type once instead
// of repeating nine rows per position. extractWith builds the extractor
// from the position's raw accessor and its hitter-frame view; z and absZ
// share one accessor because height has no mirrored frame.
export const POSITION_SUBPROPS = [
  {
    path: 'x',
    unit: 'feet',
    doc: 'hitter-frame x (0-20, grows to the hitter\'s right)',
    extractWith: (getPos, framed) => ctx => framed(ctx)?.x
  },
  {
    path: 'y',
    unit: 'feet',
    doc: 'hitter-frame y (own baseline 0, net 22)',
    extractWith: (getPos, framed) => ctx => framed(ctx)?.y
  },
  {
    path: 'z',
    unit: 'feet',
    doc: 'height above the ground',
    extractWith: getPos => ctx => getPos(ctx)?.z
  },
  {
    path: 'absX',
    unit: 'feet',
    doc: 'raw court x (far-left corner origin)',
    extractWith: getPos => ctx => getPos(ctx)?.x
  },
  {
    path: 'absY',
    unit: 'feet',
    doc: 'raw court y (far-left corner origin)',
    extractWith: getPos => ctx => getPos(ctx)?.y
  },
  {
    path: 'absZ',
    unit: 'feet',
    doc: 'height above the ground',
    extractWith: getPos => ctx => getPos(ctx)?.z
  },
  {
    path: 'feetToNearestSideline',
    unit: 'feet',
    doc: 'distance to the nearest sideline',
    extractWith: getPos => ctx => mapPos(getPos(ctx), feetToNearestSideline)
  },
  {
    path: 'feetToNearestBaseline',
    unit: 'feet',
    doc: 'distance to the nearest baseline',
    extractWith: getPos => ctx => mapPos(getPos(ctx), feetToNearestBaseline)
  },
  {
    path: 'feetToNet',
    unit: 'feet',
    doc: 'distance to the plane of the net',
    extractWith: getPos => ctx => mapPos(getPos(ctx), feetToNet)
  }
]

// the one-line meaning of each position root, shared with the docs
export const POSITION_ROOT_DOCS = {
  from: 'where the ball was struck',
  to: 'where the ball\'s flight ended',
  peak: 'the highest point of the ball\'s flight'
}

// Builds a position's property entries. The hitter's side (which decides
// the mirror) comes from where the ball was struck; either position may be
// missing.
function positionProps (prefix, getPos, extras = []) {
  function framed (ctx) {
    const struckAt = trajectory(ctx)?.start?.location
    return mapPos(struckAt, at =>
      mapPos(getPos(ctx), pos => toPlayerFrame(pos, isOnFarSide(at))))
  }
  const doc = POSITION_ROOT_DOCS[prefix]
  return [
    ...POSITION_SUBPROPS.map(sub => ({
      path: `${prefix}.${sub.path}`,
      type: 'number',
      unit: sub.unit,
      doc: `${doc} — ${sub.doc}`,
      extract: sub.extractWith(getPos, framed)
    })),
    ...extras
  ]
}

// Insights JSON spells a missing value as either an absent key or an
// explicit null; both mean "no data" here, and neither may become a value
// (the engine maps undefined to unknown).
function isPresent (value) {
  return value !== undefined && value !== null
}

function mapPos (pos, fn) {
  return isPresent(pos) ? fn(pos) : undefined
}

const SHOT_PROPS = [
  {
    path: 'num',
    type: 'number',
    unit: '1-based',
    doc: 'which shot of the rally this is (the serve is 1)',
    extract: ctx => ctx.shotIdx + 1
  },
  {
    path: 'isFinal',
    type: 'boolean',
    doc: 'whether this is the rally\'s last shot',
    extract: ctx => ctx.shot.is_final
  },
  {
    path: 'isVolley',
    type: 'boolean',
    doc: 'whether the ball was hit before bouncing',
    extract: ctx => ctx.shot.is_volley
  },
  {
    path: 'isSpeedup',
    type: 'boolean',
    doc: 'whether the shot added significant pace near the kitchen',
    extract: ctx => ctx.shot.is_speedup
  },
  {
    path: 'isReset',
    type: 'boolean',
    doc: 'whether the shot was a volley that took significant pace off a ' +
      'hard incoming ball; only volleys are assessed',
    extract: ctx => ctx.shot.is_reset
  },
  {
    path: 'isPoach',
    type: 'boolean',
    doc: 'whether the hitter cut across in front of their partner to ' +
      'volley a ball that was headed to the partner',
    extract: ctx => ctx.shot.is_poach
  },
  {
    path: 'isPassing',
    type: 'boolean',
    doc: 'whether the shot was a rally-ending drive or smash that got past ' +
      'the nearest opponent untouched; unknown in singles',
    extract: ctx => ctx.shot.is_passing
  },
  {
    path: 'isPutaway',
    type: 'boolean',
    doc: 'whether the shot functioned as a putaway or rally finisher — a clean winner or a decisive attack that directly created the rally\'s end (can be a well-placed dink or drop, not only a hard hit)',
    extract: ctx => ctx.shot.is_putaway
  },
  {
    path: 'type',
    type: 'string',
    unit: '"smash"|"lob"|"dink"|"drop"|"drive"|"atp"|"erne"',
    doc: 'the shot classification; never set on serves and returns (shot.num 1 and 2)',
    extract: ctx => ctx.shot.shot_type
  },
  {
    path: 'verticalType',
    type: 'string',
    unit: '"dig"|"neutral"|"overhead"',
    doc: 'the vertical character of the stroke, from strike height (dig ≤ 2.5ft, overhead ≥ 6ft)',
    extract: ctx => ctx.shot.vertical_type
  },
  {
    path: 'strokeSide',
    type: 'string',
    unit: '"left"|"right"',
    doc: 'which side of the body the stroke was made on',
    extract: ctx => ctx.shot.stroke_side
  },
  {
    path: 'strokeType',
    type: 'string',
    unit: '"forehand"|"backhand"',
    doc: 'forehand or backhand, from strokeSide and the hitter\'s handedness; ' +
      'needs augmented insights carrying handedness (strokeSide always works)',
    extract: ctx => {
      const handedness = ctx.game.playerHandedness(ctx.shot.player_id)
      const side = ctx.shot.stroke_side
      if (handedness === undefined || (side !== 'left' && side !== 'right')) {
        return undefined
      }
      // a stroke on the paddle-hand side is a forehand; the mirror image
      // holds for left-handers
      return side === handedness ? 'forehand' : 'backhand'
    }
  },
  {
    path: 'winnerType',
    type: 'string',
    unit: '"clean"|"forced_fault"',
    // "forced_fault" here and errors.unforced below use the same
    // forced/unforced vocabulary for OPPOSITE players, and readers walk
    // into it: a coaching model asked whether a player lost more points
    // to his own errors or to opponent pressure grouped by this field,
    // read the forced_fault rows as faults he committed, and reported
    // the reverse of the truth. Say whose shot this is, in the doc the
    // reader actually sees.
    doc: 'set only on a shot that WON the rally, and never on a fault: ' +
      '"clean" = the winning shot was fault-free, "forced_fault" = the ' +
      'OPPONENTS faulted replying to it. Both values mean the hitter won ' +
      'the rally. For faults the hitter committed use hasFault and ' +
      'errors.unforced instead; "forced_fault" here is not the opposite ' +
      'of errors.unforced, which describes the player who missed',
    extract: ctx => ctx.shot.winner_type
  },
  {
    path: 'quality.overall',
    type: 'number',
    unit: '0-1',
    doc: 'the overall quality of the shot, derived from the execution quality (1 is best)',
    extract: ctx => ctx.shot.quality?.overall
  },
  {
    path: 'quality.execution',
    type: 'number',
    unit: '0-1',
    doc: 'how well the shot was executed',
    extract: ctx => ctx.shot.quality?.execution
  },
  {
    path: 'quality.pressure',
    type: 'number',
    unit: '0-1',
    doc: 'positional pressure faced and imposed by this shot (1 = most pressure); unknown for singles, serves, and returns',
    extract: ctx => ctx.shot.quality?.pressure
  },
  {
    path: 'positioningScore',
    type: 'number',
    unit: '0-1',
    doc: 'how well the hitter was positioned at this shot, against a strong-team baseline (1 is best); unknown for singles, serves, and returns',
    extract: ctx => ctx.shot.shooter_positioning_score
  },
  {
    path: 'partnerPositioningScore',
    type: 'number',
    unit: '0-1',
    doc: 'how well the hitter\'s partner was positioned at this shot, against a strong-team baseline (1 is best); unknown for singles, serves, and returns',
    extract: ctx => ctx.shot.partner_positioning_score
  },
  {
    path: 'speed',
    type: 'number',
    unit: 'mph',
    doc: 'ball speed after the hit',
    extract: ctx => ballMovement(ctx)?.speed
  },
  {
    path: 'direction',
    type: 'string',
    unit: '"DownTheMiddle"|"DownTheLineLeft"|"DownTheLineRight"|"MidCrossLeft"|"MidCrossRight"|"LeftToMiddle"|"RightToMiddle"|"LeftCrossRight"|"RightCrossLeft"',
    doc: 'named direction the ball traveled, from the hitter\'s perspective ' +
      '(left/middle/right thirds of the court)',
    extract: ctx => ballMovement(ctx)?.angles?.direction
  },
  {
    path: 'yaw',
    type: 'number',
    unit: 'degrees',
    doc: 'horizontal launch angle (0 = toward the hitter\'s left sideline, 90 = straight at the net)',
    extract: ctx => ballMovement(ctx)?.angles?.yaw
  },
  {
    path: 'pitch',
    type: 'number',
    unit: 'degrees',
    doc: 'vertical angle from the strike point up to the flight\'s peak ' +
      '(0 = flat or downward, 90 = straight up)',
    extract: ctx => ballMovement(ctx)?.angles?.pitch
  },
  {
    path: 'distance',
    type: 'number',
    unit: 'feet',
    doc: 'straight-line distance from where the ball was struck to where its flight ended',
    extract: ctx => ballMovement(ctx)?.distance
  },
  {
    path: 'distanceFromBaseline',
    type: 'number',
    unit: 'feet',
    doc: 'how far in front of the opponent\'s baseline the ball\'s flight ' +
      'ended (negative = past it)',
    extract: ctx => ballMovement(ctx)?.distance_from_baseline
  },
  {
    path: 'heightOverNet',
    type: 'number',
    unit: 'feet',
    doc: 'ball height when crossing the net plane',
    extract: ctx => ballMovement(ctx)?.height_over_net
  },
  {
    path: 'crossedNet',
    type: 'boolean',
    doc: 'whether the ball crossed the plane of the net',
    extract: ctx => ballMovement(ctx)?.crossed_net
  },
  {
    path: 'confidence',
    type: 'number',
    unit: '0-1',
    doc: 'confidence in the reconstructed trajectory',
    extract: ctx => trajectory(ctx)?.confidence
  },
  {
    path: 'hitTime',
    type: 'number',
    unit: 'seconds',
    doc: 'when in the video the ball was struck',
    extract: ctx => msToSecs(ctx.game.hitMs(ctx.shot))
  },
  {
    path: 'endTime',
    type: 'number',
    unit: 'seconds',
    doc: 'when in the video the shot\'s flight ended',
    extract: ctx => msToSecs(ctx.game.endMs(ctx.shot))
  },
  {
    path: 'hasError',
    type: 'boolean',
    doc: 'whether any error was detected on this shot',
    extract: ctx => isPresent(ctx.shot.errors)
  },
  {
    path: 'errors.unforced',
    type: 'boolean',
    // Three-valued, and the unknowns are not a rounding error: on a
    // sample game, 29 faults split 10 true / 9 false / 10 unknown. A
    // reader who counts forced faults as (all faults - unforced) gets 19
    // instead of 9, which is the mistake a coaching model made after the
    // previous wording sent it to the right field without saying the
    // field is often absent.
    doc: 'whether the fault on this shot was an unforced error, i.e. the ' +
      'hitter MISSED without being put under pressure; only assessed on ' +
      'actual faults with a confidently-known rally winner, so it is ' +
      'often unknown even on a real fault. Count forced faults as ' +
      'errors.unforced = false; do NOT subtract the unforced count from ' +
      'the fault count, which counts every unknown as forced. avg() of it ' +
      'is a share of assessed faults, not of shots: a per-shot rate is ' +
      'sum(shot.errors.unforced) / count(). Not related to winnerType ' +
      '"forced_fault", which is set on a shot that WON',
    extract: ctx => ctx.shot.errors?.unforced
  },
  {
    path: 'errors.popup',
    type: 'string',
    unit: '"exploited"|"potential"',
    doc: 'whether a dink or drop popped the ball up ("exploited" = the ' +
      'opponents attacked it out of the air, "potential" = they did not)',
    extract: ctx => ctx.shot.errors?.popup
  },
  {
    path: 'hasFault',
    type: 'boolean',
    doc: 'whether this shot committed a rule fault, actual or potential — ' +
      'e.g. a ball headed out that an opponent played anyway',
    extract: ctx => isPresent(ctx.shot.errors?.faults)
  },
  // fault flags are recorded only when the fault happened, so absence means
  // false, never unknown (the `=== true` guard also shrugs off malformed data)
  {
    path: 'errors.faults.net',
    type: 'boolean',
    doc: 'whether the net stopped the ball',
    extract: ctx => ctx.shot.errors?.faults?.net === true
  },
  {
    path: 'errors.faults.short',
    type: 'boolean',
    doc: 'whether the shot landed on the hitter\'s own side short of the net',
    extract: ctx => ctx.shot.errors?.faults?.short === true
  },
  {
    path: 'errors.faults.out.outcome',
    type: 'string',
    unit: '"landed"|"intercepted"',
    doc: 'whether the out ball landed or was played anyway',
    extract: ctx => ctx.shot.errors?.faults?.out?.outcome
  },
  {
    path: 'errors.faults.out.direction',
    type: 'string',
    unit: '"left"|"right"|"long"',
    doc: 'which way the ball went (or was headed) out — "long" past the ' +
      'baseline, "left"/"right" wide of a sideline from the hitter\'s ' +
      'perspective',
    extract: ctx => ctx.shot.errors?.faults?.out?.direction
  },
  ...positionProps('from', ctx => trajectory(ctx)?.start?.location,
    [{
      path: 'from.zone',
      type: 'string',
      // strike zones never include "net"/"out": production derives the
      // start zone from a shot event, and only net events map to "net" and
      // out-of-bounds bounces to "out"
      unit: '"deep"|"mid"|"short"|"kitchen"',
      doc: 'depth zone the ball was struck from',
      extract: ctx => trajectory(ctx)?.start?.zone
    }]),
  ...positionProps('to', ctx => trajectory(ctx)?.end?.location,
    [{
      path: 'to.zone',
      type: 'string',
      unit: '"deep"|"mid"|"short"|"kitchen"|"net"|"out"',
      doc: 'depth zone where the ball\'s flight ended',
      extract: ctx => trajectory(ctx)?.end?.zone
    }]),
  ...positionProps('peak', ctx => trajectory(ctx)?.peak)
]

function msToSecs (ms) {
  return typeof ms === 'number' ? ms / 1000 : undefined
}

// seconds between two insights timestamps; unknown unless both are really
// there (a null endpoint would otherwise arithmetic into a plausible 0)
function msSpanSecs (fromMs, toMs) {
  return typeof fromMs === 'number' && typeof toMs === 'number'
    ? (toMs - fromMs) / 1000
    : undefined
}

const RALLY_PROPS = [
  {
    path: 'num',
    type: 'number',
    unit: '1-based',
    doc: 'which rally of the game this is',
    extract: ctx => ctx.rallyIdx + 1
  },
  {
    path: 'numShots',
    type: 'number',
    doc: 'how many shots the rally contains',
    extract: ctx => ctx.rally.shots?.length ?? 0
  },
  {
    path: 'startTime',
    type: 'number',
    unit: 'seconds',
    doc: 'when in the video the rally starts',
    extract: ctx => msToSecs(ctx.rally.start_ms)
  },
  {
    path: 'endTime',
    type: 'number',
    unit: 'seconds',
    doc: 'when in the video the rally ends',
    extract: ctx => msToSecs(ctx.rally.end_ms)
  },
  {
    path: 'duration',
    type: 'number',
    unit: 'seconds',
    doc: 'how long the rally lasted',
    extract: ctx => msSpanSecs(ctx.rally.start_ms, ctx.rally.end_ms)
  },
  {
    path: 'winner',
    type: 'number',
    unit: '0|1',
    doc: 'which team won the rally',
    extract: ctx => ctx.rally.winning_team
  },
  {
    path: 'allPlayersReachedKitchen',
    type: 'boolean',
    doc: 'whether every player reached the kitchen line this rally',
    extract: ctx => {
      const players = ctx.rally.players
      if (!Array.isArray(players)) {
        return undefined
      }
      return players
        .filter(isPresent)
        .every(p => (p.kitchen_arrivals?.length ?? 0) > 0)
    }
  }
]

const GAME_PROPS = [
  {
    path: 'vid',
    type: 'string',
    doc: 'the video ID this game is from',
    extract: ctx => ctx.game.vid
  },
  {
    path: 'sessionNum',
    type: 'number',
    unit: '1-based',
    doc: 'which game of the video this is',
    extract: ctx => ctx.game.sessionIdx + 1
  },
  {
    path: 'name',
    type: 'string',
    doc: 'the video/session name, if any',
    extract: ctx => ctx.game.meta.videoName ?? undefined
  },
  {
    path: 'epoch',
    type: 'number',
    unit: 'epoch seconds',
    doc: 'when the game was played, in seconds since 1970 (host-supplied, like the name); sort or filter games chronologically with it, and format it with date()',
    extract: ctx => ctx.game.meta.gameEpoch ?? undefined
  },
  {
    path: 'numRallies',
    type: 'number',
    doc: 'how many rallies the game contains',
    extract: ctx => ctx.game.rallies.length
  },
  {
    path: 'startTime',
    type: 'number',
    unit: 'seconds',
    doc: 'when in the video the game starts (its first rally\'s start)',
    extract: ctx => msToSecs(ctx.game.rallies[0].start_ms)
  },
  {
    path: 'endTime',
    type: 'number',
    unit: 'seconds',
    doc: 'when in the video the game ends (its last rally\'s end)',
    extract: ctx => msToSecs(ctx.game.rallies[ctx.game.rallies.length - 1].end_ms)
  },
  {
    path: 'duration',
    type: 'number',
    unit: 'seconds',
    doc: 'first rally start to last rally end (game.startTime + game.duration = game.endTime)',
    extract: ctx => {
      const { rallies } = ctx.game
      return msSpanSecs(rallies[0].start_ms, rallies[rallies.length - 1].end_ms)
    }
  },
  {
    path: 'videoDuration',
    type: 'number',
    unit: 'seconds',
    doc: 'the whole video\'s duration; only present in augmented insights',
    extract: ctx => msToSecs(ctx.game.videoDurationMs)
  },
  {
    path: 'avgShots',
    type: 'number',
    doc: 'average shots per rally',
    extract: ctx => ctx.game.insights.game_data?.avg_shots
  },
  {
    path: 'winner',
    type: 'number',
    unit: '0|1',
    doc: 'which team won the game (from the recorded outcome)',
    extract: ctx => {
      const outcome = ctx.game.insights.game_data?.game_outcome
      if (!Array.isArray(outcome)) {
        return undefined
      }
      const [a, b] = outcome
      if (a === 'won' || b === 'lost') {
        return 0
      }
      if (b === 'won' || a === 'lost') {
        return 1
      }
      if (typeof a === 'number' && typeof b === 'number' && a !== b) {
        return a > b ? 0 : 1
      }
      return undefined
    }
  }
]

// The skill areas the engine rates a player on for a single game: its
// current (version 2) rating categories, keyed as the insights key them and
// described the way the app describes them, so a chart's labels match what
// the app already calls them. They are the whole point of "which part of my
// game should I work on": a question that can only be answered by naming
// an area. Games rated before these areas existed carry the old set, of
// which only overall, offense and defense are still read.
//
// Each is constant across the game's shots, so avg() over a game returns
// the rating itself and `GROUP BY game.vid, game.sessionNum, game.name`
// gives one point per game -- a rating chart in one line of PBQL.
const RATING_AREAS = [
  { path: 'overall', key: 'overall', area: 'overall' },
  {
    path: 'kitchenGame',
    key: 'kitchen_game',
    area: 'Kitchen Game (play at the non-volley zone)'
  },
  {
    path: 'ballControl',
    key: 'ball_control',
    area: 'Ball Control (how well they control the ball)'
  },
  { path: 'defense', key: 'defense', area: 'Defense (neutralizing attacks)' },
  { path: 'offense', key: 'offense', area: 'Offense (applying pressure)' },
  {
    path: 'courtIQ',
    key: 'court_iq',
    area: 'Court IQ (court awareness and decision-making)'
  },
  {
    path: 'targeting',
    key: 'targeting',
    area: 'Targeting (how well they place their shots)'
  }
]

const RATING_PROPS = RATING_AREAS.map(({ path, key, area }) => ({
  path: `rating.${path}`,
  type: 'number',
  unit: 'DUPR',
  doc: `the player's ${area} rating for THIS game (not their career ` +
    'rating); one value per game, so it repeats on every shot of it and ' +
    'is unknown for a player the game did not rate',
  extract: (ctx, playerIdx) => ctx.game.playerRating(playerIdx, key)
}))

// Player properties receive the player's index as well. Position-derived
// properties are measured at the moment of the shot the player was reached
// through (shot[k] for a `shot[k].hitter…` path, else the current shot), in
// the player's own frame (their baseline is y=0).
const PLAYER_PROPS = [
  {
    path: 'id',
    type: 'number',
    unit: '0-3',
    doc: 'the player\'s index within this game',
    extract: (ctx, playerIdx) => playerIdx
  },
  {
    path: 'team',
    type: 'number',
    unit: '0|1',
    doc: 'the player\'s team',
    extract: (ctx, playerIdx) => ctx.game.playerTeam(playerIdx)
  },
  {
    path: 'name',
    type: 'string',
    doc: 'the player\'s tagged name; untagged players keep their default name ("Player 1"…"Player 4")',
    extract: (ctx, playerIdx) => ctx.game.playerName(playerIdx)
  },
  {
    path: 'startedOnLeftSide',
    type: 'boolean',
    doc: 'whether the player began the rally on the left of their partner, ' +
      'facing the net; not meaningful in singles',
    extract: (ctx, playerIdx) =>
      playerInRally(ctx, playerIdx)?.started_on_left_side
  },
  {
    path: 'reachedKitchen',
    type: 'boolean',
    doc: 'whether the player reached the kitchen line this rally',
    extract: (ctx, playerIdx) => {
      const p = playerInRally(ctx, playerIdx)
      if (p === undefined) {
        return undefined
      }
      return (p.kitchen_arrivals?.length ?? 0) > 0
    }
  },
  {
    path: 'pos.x',
    type: 'number',
    unit: 'feet',
    doc: 'court x at the current shot, in the player\'s own frame',
    extract: (ctx, playerIdx) => framedPlayerPos(ctx, playerIdx)?.x
  },
  {
    path: 'pos.y',
    type: 'number',
    unit: 'feet',
    doc: 'court y at the current shot, in the player\'s own frame (own baseline 0)',
    extract: (ctx, playerIdx) => framedPlayerPos(ctx, playerIdx)?.y
  },
  {
    path: 'pos.absX',
    type: 'number',
    unit: 'feet',
    doc: 'raw court x at the current shot',
    extract: (ctx, playerIdx) => rawPlayerPos(ctx, playerIdx)?.x
  },
  {
    path: 'pos.absY',
    type: 'number',
    unit: 'feet',
    doc: 'raw court y at the current shot',
    extract: (ctx, playerIdx) => rawPlayerPos(ctx, playerIdx)?.y
  },
  {
    path: 'feetToKitchen',
    type: 'number',
    unit: 'feet',
    doc: 'distance still to cover to reach their kitchen line (0 at/inside it)',
    extract: (ctx, playerIdx) => mapPos(rawPlayerPos(ctx, playerIdx), feetToKitchen)
  },
  {
    path: 'isNearKitchen',
    type: 'boolean',
    doc: 'whether they are within 4 feet of their kitchen line',
    extract: (ctx, playerIdx) => mapPos(
      rawPlayerPos(ctx, playerIdx), pos => feetToKitchen(pos) <= NEAR_KITCHEN_FT)
  },
  {
    path: 'isRightOfTeammate',
    type: 'boolean',
    doc: 'whether they are playing the right side of their court (right of their teammate, in their own facing) at the current shot; unknown in singles and when either position is missing',
    extract: (ctx, playerIdx) => {
      if (isSingles(ctx.game)) {
        return undefined
      }
      const pos = rawPlayerPos(ctx, playerIdx)
      const partnerPos = rawPlayerPos(ctx, partnerOf(playerIdx))
      if (pos === undefined || partnerPos === undefined) {
        return undefined
      }
      return toPlayerFrame(pos, isOnFarSide(pos)).x >
        toPlayerFrame(partnerPos, isOnFarSide(partnerPos)).x
    }
  },
  {
    path: 'feetToNearestSideline',
    type: 'number',
    unit: 'feet',
    doc: 'distance to the nearest sideline at the current shot',
    extract: (ctx, playerIdx) =>
      mapPos(rawPlayerPos(ctx, playerIdx), feetToNearestSideline)
  },
  {
    path: 'feetToNearestBaseline',
    type: 'number',
    unit: 'feet',
    doc: 'distance to the nearest baseline at the current shot',
    extract: (ctx, playerIdx) =>
      mapPos(rawPlayerPos(ctx, playerIdx), feetToNearestBaseline)
  },
  {
    path: 'feetToNet',
    type: 'number',
    unit: 'feet',
    doc: 'distance to the net plane at the current shot',
    extract: (ctx, playerIdx) => mapPos(rawPlayerPos(ctx, playerIdx), feetToNet)
  },
  // whole-game team-level positional performance (both teammates share the
  // value, and team 1's is the complement of team 0's); unknown in singles
  {
    path: 'forwardPressure',
    type: 'number',
    unit: '0-1',
    doc: 'how actively the player\'s team pushed shots toward positional advantage over the whole game (team-level: teammates share it); unknown in singles',
    extract: (ctx, playerIdx) => positionalPerformance(ctx, playerIdx)?.forward_pressure
  },
  {
    path: 'finishingAbility',
    type: 'number',
    unit: '0-1',
    doc: 'how efficiently the player\'s team converted positional advantage into ending rallies over the whole game (team-level: teammates share it); unknown in singles',
    extract: (ctx, playerIdx) => positionalPerformance(ctx, playerIdx)?.finishing_ability
  },
  ...RATING_PROPS
]

function positionalPerformance (ctx, playerIdx) {
  return ctx.game.insights.player_data?.[playerIdx]?.positional_performance
}

function playerInRally (ctx, playerIdx) {
  return ctx.rally.players?.[playerIdx] ?? undefined
}

function rawPlayerPos (ctx, playerIdx) {
  return ctx.game.playerPosAtShot(ctx.shot, playerIdx) ?? undefined
}

function framedPlayerPos (ctx, playerIdx) {
  const pos = rawPlayerPos(ctx, playerIdx)
  return pos === undefined ? undefined : toPlayerFrame(pos, isOnFarSide(pos))
}

// Methods (subject predicates with arguments). apply() receives the
// evaluation ctx, the resolved subject (a player index for player subjects,
// undefined for shot subjects), and the literal arguments.
const SHOT_METHODS = [
  {
    name: 'isHitOnSide',
    args: [{ name: 'side', type: 'string', unit: '"left"|"right"' }],
    doc: 'whether the ball was struck on the given half ("left"|"right") of the court in the hitter\'s frame (right = x >= 10)',
    apply: (ctx, subject, [side]) => {
      const struck = trajectory(ctx)?.start?.location
      if (struck === undefined || (side !== 'left' && side !== 'right')) {
        return undefined
      }
      const { x } = toPlayerFrame(struck, isOnFarSide(struck))
      return side === 'right' ? x >= 10 : x < 10
    }
  },
  {
    name: 'taggedWith',
    args: [{ name: 'pattern', type: 'string' }],
    doc: 'whether the hitter matches this name pattern (case-insensitive, * wildcard; untagged players match their default "Player N" name) or exact email',
    apply: (ctx, subject, [pattern]) =>
      playerMatchesTag(ctx, ctx.shot.player_id, pattern)
  },
  {
    name: 'inHighlight',
    args: [{
      name: 'kind',
      type: 'string',
      unit: '"atp"|"erne"|"hands_battle"|"long_rally"|"poach"|"sequence"'
    }],
    doc: 'whether the shot falls inside a highlight of the given kind ' +
      '("atp", "erne", "hands_battle" = a rapid volley exchange, ' +
      '"long_rally", "poach", "sequence" = a notable stretch of shots)',
    apply: (ctx, subject, [kind]) => {
      const highlights = ctx.game.insights.highlights
      const hitMs = ctx.game.hitMs(ctx.shot)
      if (!Array.isArray(highlights) || hitMs === undefined) {
        return undefined
      }
      return highlights.some(h => isPresent(h) && h.kind === kind &&
        (h.rally_idx === undefined || h.rally_idx === ctx.rallyIdx) &&
        h.s <= hitMs && hitMs <= h.e)
    }
  }
]

const PLAYER_METHODS = [
  {
    name: 'taggedWith',
    args: [{ name: 'pattern', type: 'string' }],
    doc: 'whether this player matches this name pattern (case-insensitive, * wildcard; untagged players match their default "Player N" name) or exact email',
    apply: (ctx, playerIdx, [pattern]) => playerMatchesTag(ctx, playerIdx, pattern)
  }
]

// Relations navigate to another player. A relation's resolve(ctx, fromIdx)
// returns the target player index (or undefined → unknown), where ctx pins
// the shot moment that side-based relations (LHS/RHS) and player positions
// are measured at. The engine walks a path's leading relation segments to
// advance the player cursor before reading a scalar prop/method (see
// evaluate.js and docs §5.4).
const SHOT_RELATIONS = [
  {
    name: 'hitter',
    doc: 'the player who hit this shot',
    resolve: ctx => ctx.shot.player_id
  }
]

const PLAYER_RELATIONS = [
  {
    name: 'teammate',
    doc: 'this player\'s partner (unknown in singles)',
    resolve: (ctx, from) => isSingles(ctx.game) ? undefined : partnerOf(from)
  },
  {
    name: 'opponent1',
    doc: 'the first opposing player, in player-id order (the lone opponent in singles)',
    resolve: (ctx, from) => opponentsOf(from)[0]
  },
  {
    name: 'opponent2',
    doc: 'the second opposing player, in player-id order (unknown in singles)',
    resolve: (ctx, from) => isSingles(ctx.game) ? undefined : opponentsOf(from)[1]
  },
  {
    name: 'opponentLHS',
    doc: 'the opponent playing the left side of their court (left of their ' +
      'partner) at the shot\'s moment (unknown if positions are missing)',
    resolve: (ctx, from) => opponentBySide(ctx, from, true)
  },
  {
    name: 'opponentRHS',
    doc: 'the opponent playing the right side of their court (right of their ' +
      'partner) at the shot\'s moment (unknown if positions are missing)',
    resolve: (ctx, from) => opponentBySide(ctx, from, false)
  }
]

export function playerMatchesTag (ctx, playerIdx, pattern) {
  // the analyzer rejects non-string patterns it can type, but an untyped
  // expression can still deliver one at runtime: no match, no crash. A
  // hitter without a player_id is nobody, not "Player NaN".
  if (!Number.isInteger(playerIdx) || typeof pattern !== 'string') {
    return undefined
  }
  if (pattern.includes('@')) {
    // email: exact match, case-insensitive; addresses are host-supplied
    const addr = ctx.game.meta.players?.[playerIdx]?.addr
    return typeof addr === 'string'
      ? addr.toLowerCase() === pattern.toLowerCase()
      : undefined
  }
  const name = ctx.game.playerName(playerIdx)
  if (name === undefined) {
    return undefined
  }
  // name glob: case-insensitive, * matches any run of characters
  return globMatch(pattern.toLowerCase(), name.toLowerCase())
}

// Iterative two-pointer wildcard match (* = any run of characters). Linear
// scanning with single-star backtracking — unlike a backtracking regex, a
// pathological pattern (many stars) cannot blow up combinatorially.
function globMatch (pattern, text) {
  pattern = pattern.replace(/\*+/g, '*') // consecutive stars act as one
  let p = 0 // position in pattern
  let t = 0 // position in text
  let starP = -1 // pattern position after the most recent *
  let starT = 0 // text position that * was last stretched to
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === '*') {
      starP = ++p
      starT = t
    } else if (p < pattern.length && pattern[p] === text[t]) {
      p++
      t++
    } else if (starP !== -1) {
      // stretch the last * one character further and retry after it
      p = starP
      t = ++starT
    } else {
      return false
    }
  }
  // trailing * matches the empty run
  if (p < pattern.length && pattern[p] === '*') {
    p++
  }
  return p === pattern.length
}

function toMaps (props, methods = [], relations = []) {
  return {
    props: new Map(props.map(p => [p.path, p])),
    methods: new Map(methods.map(m => [m.name, m])),
    relations: new Map(relations.map(r => [r.name, r])),
    propList: props,
    methodList: methods,
    relationList: relations
  }
}

// Rally methods are evaluated by the engine directly: the condition
// argument is an expression evaluated once per shot of the rally (with
// `shot` re-rooted to each in turn), not a value -- so there is no apply()
// here, unlike shot/player methods.
const RALLY_METHODS = [
  {
    name: 'count',
    args: [{ name: 'condition', type: 'condition' }],
    type: 'number',
    doc: 'how many of the rally\'s shots satisfy the condition; inside it, shot (and every player position) refers to each shot of the rally in turn, and shots where the condition is unknown are not counted'
  }
]

export const REGISTRY = {
  shot: toMaps(SHOT_PROPS, SHOT_METHODS, SHOT_RELATIONS),
  rally: toMaps(RALLY_PROPS, RALLY_METHODS),
  game: toMaps(GAME_PROPS),
  player: toMaps(PLAYER_PROPS, PLAYER_METHODS, PLAYER_RELATIONS)
}

// Walks the leading relation segments of a prop path, advancing the object
// type across each player-transition (shot→hitter, player→teammate/…).
// Returns the terminal object type and the remaining (scalar/method) path.
// Shared with the analyzer; the engine performs the same walk
// while also resolving each relation to a concrete player (evaluate.js).
export function walkRelations (base, path) {
  let typeName = base.object
  let i = 0
  while (i < path.length && REGISTRY[typeName].relations.has(path[i])) {
    typeName = 'player'
    i++
  }
  return { typeName, rest: path.slice(i) }
}
