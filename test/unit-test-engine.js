import { UNKNOWN, evalExpr } from '../src/engine/evaluate.js'
import { computeWindow } from '../src/engine/window.js'
import { Game, parse, runQuery, shotsToCSV } from '../src/index.js'

import { makeDoublesGame, makeSinglesGame } from './fixtures/make-insights.js'

// runs `WHERE expr` over the doubles fixture, returning [rallyIdx, shotIdx]
function shotsWhere (expr, rest = '') {
  const result = runQuery({
    text: `FROM "testvid00001" WHERE ${expr} ${rest}`,
    games: [makeDoublesGame()]
  })
  expect(result.errors).toBeUndefined()
  return result.shots.map(s => [s.rallyIdx, s.shotIdx])
}

function windowFor (contextClauses) {
  const result = runQuery({
    text: `FROM "x" WHERE shot.speed = 50 ${contextClauses}`,
    games: [makeDoublesGame()]
  })
  expect(result.shots).toHaveLength(1)
  return result.shots[0]
}

describe('runQuery: filtering', () => {
  test('property equality and ranges', () => {
    expect(shotsWhere('shot.type = "drop"')).toEqual([[0, 1]])
    expect(shotsWhere('shot.quality.overall >= 0.9')).toEqual([[0, 1], [0, 2]])
    expect(shotsWhere('shot.num IN (1)')).toEqual([[0, 0], [1, 0], [2, 0]])
  })

  test('shot.hitter = me resolves through host metadata', () => {
    expect(shotsWhere('shot.hitter = me')).toEqual([[0, 0], [1, 1], [2, 0]])
    // without a "me" mapping the predicate is unknown, never true
    const game = makeDoublesGame()
    game.meta = {}
    const result = runQuery({ text: 'FROM "x" WHERE shot.hitter = me', games: [game] })
    expect(result.shots).toEqual([])
  })

  test('unknown semantics: NOT never matches unknowns; exists() does', () => {
    // is_volley is only present on rally 0 (false, false, true) and (2,2)
    expect(shotsWhere('NOT shot.isVolley')).toEqual([[0, 0], [0, 1]])
    expect(shotsWhere('NOT exists(shot.isVolley) OR NOT shot.isVolley'))
      .toEqual([[0, 0], [0, 1], [1, 0], [1, 1], [2, 0], [2, 1], [2, 3]])
    expect(shotsWhere('exists(shot.winnerType)')).toEqual([[0, 2]])
  })

  test('strokeType: strokeSide oriented by host-augmented handedness', () => {
    // by hand: (0,0) right-handed p0 strikes right-side → forehand; (2,2)
    // LEFT-handed p1 strikes left-side → forehand (the mirror image)
    expect(shotsWhere('shot.strokeType = "forehand"')).toEqual([[0, 0], [2, 2]])
    // (0,2) left-handed p1 strikes right-side → backhand (the inversion)
    expect(shotsWhere('shot.strokeType = "backhand"')).toEqual([[0, 2]])
    // every other stroke is unknown: p2's handedness is untagged ((0,1)
    // has a known strokeSide), p3's is "both" ((2,3) likewise), and the
    // rest have no strokeSide at all
    expect(shotsWhere('exists(shot.strokeType)'))
      .toEqual([[0, 0], [0, 2], [2, 2]])
  })

  test('methods: taggedWith by name glob and by email; inHighlight', () => {
    expect(shotsWhere('shot.taggedWith("bob")')).toEqual([[0, 2], [2, 2]])
    expect(shotsWhere('shot.taggedWith("ALICE@EXAMPLE.COM")'))
      .toEqual([[0, 0], [1, 1], [2, 0]])
    expect(shotsWhere('shot.inHighlight("atp")')).toEqual([[0, 2]])
  })

  test('player navigation, including LHS/RHS by position', () => {
    // p1's opponents hold the far half; in their own frame x' = raw x, so
    // p2 (abs x=6 → x'=6) plays their side's left and p3 (x=15) its right
    expect(shotsWhere('rally.num = 1 AND shot.num = 3 AND shot.hitter.opponentLHS.name = "Carol"'))
      .toEqual([[0, 2]])
    expect(shotsWhere('rally.num = 1 AND shot.num = 3 AND shot.hitter.opponentRHS.name = "Dan"'))
      .toEqual([[0, 2]])
    // p2's opponents hold the near half; their frame reflects x, so p1
    // (abs x=15 → x'=5) plays their side's left, p0 (x=6 → x'=14) its right
    expect(shotsWhere('rally.num = 2 AND shot.num = 1 AND shot.hitter.opponentLHS.name = "Bob"'))
      .toEqual([[1, 0]])
    expect(shotsWhere('me.teammate.name = "Bob"')).toHaveLength(9) // true for every shot
    expect(shotsWhere('shot.hitter.opponent1.name = "Carol"'))
      .toEqual([[0, 0], [0, 2], [1, 1], [2, 0], [2, 2]]) // shots by team 0
    // LHS/RHS are unknown when positions are missing (the sparse shot)
    expect(shotsWhere('rally.num = 2 AND shot.num = 2 AND shot.hitter.opponentLHS.name = "Carol"'))
      .toEqual([])
    // multi-hop: the hitter's teammate, targeting the next shot's hitter
    expect(shotsWhere('shot.hitter.teammate = shot[1].hitter'))
      .toEqual([]) // partners never hit consecutive shots in the fixtures
    // forward targeting: the shot right before Bob's winner
    expect(shotsWhere('exists(shot[1].winnerType) AND shot[1].hitter.taggedWith("Bob*")'))
      .toEqual([[0, 1]]) // shot (0,1)'s successor (0,2) is Bob's winner
  })

  test('relative shots and rallies; out-of-range is unknown', () => {
    expect(shotsWhere('shot[-1].type = "drop"')).toEqual([[0, 2]])
    expect(shotsWhere('rally[1].winner = 1')).toEqual([[0, 0], [0, 1], [0, 2]])
    // rally 1's previous rally was won by team 0; rally 2's by team 1
    expect(shotsWhere('rally[-1].winner = 0')).toEqual([[1, 0], [1, 1]])
    expect(shotsWhere('rally[-1].winner = 1')).toEqual([[2, 0], [2, 1], [2, 2], [2, 3]])
  })

  test('arithmetic, division by zero, min/max functions', () => {
    expect(shotsWhere('shot.to.absX - shot.from.absX = 10')).toEqual([[0, 0]])
    expect(shotsWhere('shot.speed / (shot.num - 1) > 0'))
      .toEqual([[0, 1], [0, 2], [2, 1], [2, 2], [2, 3]])
    expect(shotsWhere('min(shot.from.absX, shot.to.absX) <= 5'))
      .toEqual([[0, 0], [1, 0], [2, 0], [2, 2]])
    expect(shotsWhere('max(shot.from.absX, 18) = 18')).toHaveLength(8) // sparse shot unknown
    expect(shotsWhere('-shot.pitch < 0')).toHaveLength(8)
  })

  test('runtime type guards make mismatches unknown, not crashes', () => {
    // these dodge the static checks (function results have unknown type)
    expect(shotsWhere('exists(true) < exists(true)')).toEqual([]) // ordering booleans
    expect(shotsWhere('min(2, 3) IN ("x", 2)')).toHaveLength(9) // skips the string
    expect(shotsWhere('abs(shot.type) = 1')).toEqual([]) // abs of a string
    expect(shotsWhere('min(1, shot.type) = 1')).toEqual([]) // min of a string
    // a string-typed argument whose data is not a string: unknown, no crash
    const game = makeDoublesGame()
    game.insights.rallies[0].shots[0].shot_type = 5
    expect(runQuery({
      text: 'FROM "x" WHERE shot.taggedWith(shot.type)',
      games: [game]
    }).shots).toEqual([])
  })

  test('game.epoch and date(): when the game was played', () => {
    // the fixture's meta.gameEpoch is 2025-01-01T12:00:00Z; it is a plain
    // number, so it filters and orders like any other
    expect(shotsWhere('game.epoch = 1735732800')).toHaveLength(9)
    expect(shotsWhere('game.epoch > 1735732800')).toEqual([])
    // date() renders the calendar date in the game's host-supplied
    // timezone; pinning zones via meta keeps these deterministic on any
    // machine
    const inZone = (expr, tz) => runQuery({
      text: `FROM "x" WHERE ${expr}`,
      games: [(game => ({ ...game, meta: { ...game.meta, tz } }))(
        makeDoublesGame())]
    }).shots.length
    expect(inZone('date(game.epoch) = "2025-01-01"', 'UTC')).toBe(9)
    // midnight UTC is still the prior evening in New York...
    expect(inZone('date(1735689600) = "2024-12-31"', 'America/New_York'))
      .toBe(9)
    // ...month and day both 2-pad, and an unrecognized zone renders no
    // date at all (never a date in silently the wrong place)
    expect(inZone('date(1757410000) = "2025-09-09"', 'UTC')).toBe(9)
    expect(inZone('exists(date(game.epoch))', 'Mars/Olympus')).toBe(0)
    // without meta.tz the process's own local zone applies, whatever
    // this machine's is (cross-checked against Intl's local rendering)
    const localDay = new Date(1735732800 * 1000).toLocaleDateString('en-CA')
    expect(shotsWhere(`date(game.epoch) = "${localDay}"`)).toHaveLength(9)
    // unknown in, unknown out; epochs beyond what a date can represent
    // are unknown too, never garbage strings
    expect(shotsWhere('exists(date(shot.speed))')).toEqual(
      shotsWhere('exists(shot.speed)'))
    expect(shotsWhere('exists(date(99999999999999))')).toEqual([])
    // a game whose host supplied no gameEpoch has an unknown epoch
    const result = runQuery({
      text: 'FROM "x" WHERE exists(game.epoch)',
      games: [{ ...makeDoublesGame(), meta: {} }]
    })
    expect(result.shots).toEqual([])
  })

  test('timecode formats video positions: floored m:ss, optional frames', () => {
    // fixture hit times: (0,2) at 18s, (1,1) at 35s, (2,3) at 61s
    expect(shotsWhere('timecode(shot.hitTime) = "0:18"')).toEqual([[0, 2]])
    expect(shotsWhere('timecode(shot.hitTime) = "1:01"')).toEqual([[2, 3]]) // 2-pads
    expect(shotsWhere('timecode(shot.hitTime + 0.9) = "1:01"')).toEqual([[2, 3]]) // floors
    expect(shotsWhere('timecode(222.9) = "3:42"')).toHaveLength(9)
    expect(shotsWhere('timecode(1025) = "17:05"')).toHaveLength(9)
    // frames are 0-based, 2-padded, and floored at the game's own fps
    // (the fixture's camera.fps is 30); false means no frames at all
    expect(shotsWhere('timecode(0, true) = "0:00:00"')).toHaveLength(9)
    expect(shotsWhere('timecode(1025, true) = "17:05:00"')).toHaveLength(9)
    expect(shotsWhere('timecode(1025, false) = "17:05"')).toHaveLength(9)
    expect(shotsWhere('timecode(shot.hitTime + 0.5, true) = "0:18:15"'))
      .toEqual([[0, 2]])
  })

  test('timecode unknowns: bad seconds, flags, and fps per Kleene', () => {
    // unknown or negative seconds are unknown
    expect(shotsWhere('NOT exists(timecode(shot.speed))')).toEqual([[1, 1]])
    expect(shotsWhere('exists(timecode(0 - 1))')).toEqual([])
    // a non-boolean withFrames is unknown (min() is untyped, so only the
    // engine sees that it is a number)
    expect(shotsWhere('exists(timecode(1, min(1, 2)))')).toEqual([])
    // an unknown flag is unknown; known flags pick the format per shot
    // (is_volley is only present on rally 0 and (2,2))
    expect(shotsWhere('timecode(61.5, shot.isVolley) IN ("1:01", "1:01:15")'))
      .toEqual([[0, 0], [0, 1], [0, 2], [2, 2]])
    // frames need a usable fps from the game; m:ss never does
    const game = makeDoublesGame()
    delete game.insights.camera
    const matches = expr => runQuery({
      text: `FROM "x" WHERE ${expr}`, games: [game]
    }).shots.length
    expect(matches('timecode(shot.hitTime) = "0:18"')).toBe(1)
    expect(matches('exists(timecode(61, true))')).toBe(0) // no camera data
    game.insights.camera = { fps: 0 }
    expect(matches('exists(timecode(61, true))')).toBe(0) // non-positive fps
  })
})

describe('runQuery: ordering and limits', () => {
  test('ORDER BY with DESC, ties broken by later keys, unknowns last', () => {
    const rows = shotsWhere('true', 'ORDER BY shot.speed DESC, shot.hitTime')
    expect(rows[0]).toEqual([2, 2]) // 50 mph
    expect(rows[1]).toEqual([0, 2]) // 45
    expect(rows[rows.length - 1]).toEqual([1, 1]) // sparse: speed unknown
    // the three 30mph shots stay in hitTime order
    expect(rows.slice(4, 7)).toEqual([[2, 0], [2, 1], [2, 3]])
  })

  test('ORDER BY strings and booleans', () => {
    const byType = shotsWhere('true', 'ORDER BY shot.type')
    expect(byType[0]).toEqual([0, 0]) // "drive" sorts before "drop"/"smash"
    expect(byType[byType.length - 1]).toEqual([1, 1]) // unknown type last
    const finalsFirst = shotsWhere('true', 'ORDER BY shot.isFinal DESC, shot.hitTime')
    expect(finalsFirst.slice(0, 3)).toEqual([[0, 2], [1, 1], [2, 3]])
  })

  test('LIMIT applies after ordering', () => {
    expect(shotsWhere('true', 'ORDER BY shot.speed DESC LIMIT 2'))
      .toEqual([[2, 2], [0, 2]])
  })
})

describe('runQuery: context windows', () => {
  test('the default window is a one-shot lead-in and lead-out', () => {
    // a bare shot-list query (no CONTEXT clause) frames each clip with ±1 shot
    expect(windowFor('')).toMatchObject({
      rallyIdx: 2,
      shotIdx: 2,
      hitMs: 58000,
      window: { sMs: 55000, eMs: 62000 },
      contextShots: [{ rallyIdx: 2, shotIdx: 1 }, { rallyIdx: 2, shotIdx: 3 }]
    })
  })

  test('an explicit zero context is the bare shot flight', () => {
    // writing any CONTEXT clause opts out of the ±1 default; 0secs keeps just
    // the flight (the unwritten AFTER side is zero too)
    expect(windowFor('CONTEXT BEFORE 0secs')).toMatchObject({
      rallyIdx: 2,
      shotIdx: 2,
      hitMs: 58000,
      window: { sMs: 58000, eMs: 59000 },
      contextShots: []
    })
  })

  test('secs stretch exactly, crossing rally bounds freely', () => {
    expect(windowFor('CONTEXT BEFORE 2secs CONTEXT AFTER 1secs').window)
      .toEqual({ sMs: 56000, eMs: 60000 })
    expect(windowFor('CONTEXT BEFORE 12secs CONTEXT AFTER 12secs').window)
      .toEqual({ sMs: 46000, eMs: 71000 }) // rally bounds don't cap secs
    // the video's start is the only hard floor
    expect(windowFor('CONTEXT BEFORE 999secs').window.sMs).toBe(0)
  })

  test('shots units include neighbors as context, clamped to the rally', () => {
    const one = windowFor('CONTEXT BEFORE 1 shots CONTEXT AFTER 1 shots')
    expect(one.window).toEqual({ sMs: 55000, eMs: 62000 })
    expect(one.contextShots).toEqual([
      { rallyIdx: 2, shotIdx: 1 }, { rallyIdx: 2, shotIdx: 3 }])
    const many = windowFor('CONTEXT BEFORE 5 shots')
    expect(many.window.sMs).toBe(52000)
    expect(many.contextShots).toEqual([
      { rallyIdx: 2, shotIdx: 0 }, { rallyIdx: 2, shotIdx: 1 }])
  })

  test('rally duration goes to the boundary', () => {
    const whole = windowFor('CONTEXT BEFORE rally CONTEXT AFTER rally')
    expect(whole.window).toEqual({ sMs: 50000, eMs: 64000 })
    expect(whole.contextShots).toHaveLength(3)
  })

  test('min caps, max floors, ties prefer context shots', () => {
    expect(windowFor('CONTEXT BEFORE min(1 shots, 2secs)')).toMatchObject({
      window: { sMs: 56000 }, contextShots: []
    })
    expect(windowFor('CONTEXT BEFORE max(1 shots, 2secs)')).toMatchObject({
      window: { sMs: 55000 },
      contextShots: [{ rallyIdx: 2, shotIdx: 1 }]
    })
    // 3secs resolves to exactly the previous shot's start: a tie
    expect(windowFor('CONTEXT BEFORE min(1 shots, 3secs)').contextShots)
      .toEqual([{ rallyIdx: 2, shotIdx: 1 }])
    expect(windowFor('CONTEXT AFTER max(1 shots, 1secs)')).toMatchObject({
      window: { eMs: 62000 },
      contextShots: [{ rallyIdx: 2, shotIdx: 3 }]
    })
    expect(windowFor('CONTEXT AFTER min(1 shots, 1secs)')).toMatchObject({
      window: { eMs: 60000 }, contextShots: []
    })
  })

  test('secs windows clamp at the video\'s end when its duration is known', () => {
    const game = makeDoublesGame()
    game.insights.session.videoDurationMs = 65500 // just past rally 3's end
    const windowOf = text => runQuery({ text, games: [game] }).shots[0].window
    const query = 'FROM "x" WHERE shot.speed = 50 ' +
      'CONTEXT BEFORE 12secs CONTEXT AFTER 12secs'
    // absent the duration this window would be 46000..71000 (exact ±12s)
    expect(windowOf(query)).toEqual({ sMs: 46000, eMs: 65500 })
    // windows that never reach the video's end are untouched
    expect(windowOf('FROM "x" WHERE shot.speed = 50 CONTEXT AFTER 1secs').eMs)
      .toBe(60000)
    // a duration no video can have (zero, negative, non-numeric, infinite)
    // reads as absent: no end clamp applies
    for (const bogus of [0, -1, '65500', JSON.parse('1e400')]) {
      game.insights.session.videoDurationMs = bogus
      expect(windowOf(query).eMs).toBe(71000)
    }
  })

  test('a rally-opening shot has nothing before it', () => {
    const result = runQuery({
      text: 'FROM "x" WHERE rally.num = 3 AND shot.num = 1 CONTEXT BEFORE 2 shots',
      games: [makeDoublesGame()]
    })
    expect(result.shots[0].window.sMs).toBe(52000)
    expect(result.shots[0].contextShots).toEqual([])
  })
})

describe('coverage edges', () => {
  test('doubles opponent2 and player-subject methods', () => {
    expect(shotsWhere('me.opponent2.name = "Dan"')).toHaveLength(9)
    expect(shotsWhere('me.teammate.taggedWith("b*")')).toHaveLength(9)
  })

  test('method args that are unknown make the call unknown', () => {
    expect(shotsWhere('shot.inHighlight(shot.winnerType)')).toEqual([])
  })

  test('abs of real numbers; IN with an unknown lhs', () => {
    expect(shotsWhere('abs(0 - shot.speed) = 50')).toEqual([[2, 2]])
    // (0,2) is "clean"; "forced_fault" is valid but matches nothing
    expect(shotsWhere('shot.winnerType IN ("clean", "forced_fault")')).toEqual([[0, 2]])
  })

  test('IN is an OR chain: unknown comparisons propagate per Kleene', () => {
    // 2 = "x" is unknown at runtime (types differ), so the whole IN is
    // unknown — not false — and NOT of it must not match anything
    expect(shotsWhere('NOT (min(2, 3) IN ("x", "y"))')).toEqual([])
    // ...but one true element decides the chain regardless of unknowns
    expect(shotsWhere('min(2, 3) IN ("x", 2)')).toHaveLength(9)
    // signed numeric literals evaluate end-to-end
    expect(shotsWhere('shot.num IN (-1, 1)')).toEqual([[0, 0], [1, 0], [2, 0]])
  })

  test('remaining runtime operators: !=, +, *', () => {
    expect(shotsWhere('shot.type != "drive"'))
      .toEqual([[0, 1], [0, 2]])
    expect(shotsWhere('shot.num + 1 = 2')).toHaveLength(3)
    expect(shotsWhere('shot.num * 2 = 4')).toHaveLength(3)
  })

  test('OR of only unknowns and falses is unknown', () => {
    expect(shotsWhere('rally.num = 2 AND (shot.isVolley OR false)')).toEqual([])
  })

  test('ORDER BY skips a key when both sides are unknown', () => {
    expect(shotsWhere('rally.num = 2', 'ORDER BY shot.isVolley, shot.hitTime DESC'))
      .toEqual([[1, 1], [1, 0]])
  })

  test('durfn arg order and all-secs ties', () => {
    expect(windowFor('CONTEXT BEFORE min(2secs, 1 shots)').window.sMs).toBe(56000)
    expect(windowFor('CONTEXT AFTER max(2secs, 1 shots)').window.eMs).toBe(62000)
    const tie = windowFor('CONTEXT BEFORE min(3secs, 3secs)')
    expect(tie.window.sMs).toBe(55000)
    expect(tie.contextShots).toEqual([])
  })

  test('computeWindow stretches secs exactly', () => {
    const game = new Game(makeDoublesGame())
    const ctx = game.shotRefs[7] // rally 2, shot 2
    const zero = { kind: 'dur', unit: 'secs', value: 0 }
    expect(computeWindow(ctx, { before: { kind: 'dur', unit: 'secs', value: 12 }, after: zero }))
      .toMatchObject({ sMs: 46000 })
  })

  test('evalExpr tolerates unanalyzed ASTs (unknown names are unknown)', () => {
    const game = new Game(makeDoublesGame())
    const ctx = game.shotRefs[0]
    const where = text => parse(`FROM "f" WHERE ${text}`).ast.where
    expect(evalExpr(where('shot.nope'), ctx)).toBe(UNKNOWN)
    expect(evalExpr(where('shot.nope(1)'), ctx)).toBe(UNKNOWN)
    // an enum-invalid method argument only reaches the engine unanalyzed;
    // the runtime guard still answers unknown
    expect(evalExpr(where('shot.isHitOnSide("up")'), ctx)).toBe(UNKNOWN)
    // a method whose remaining path isn't a single terminal segment
    expect(evalExpr(where('shot.quality.taggedWith("x")'), ctx)).toBe(UNKNOWN)
    expect(evalExpr(where('foo(1)'), ctx)).toBe(UNKNOWN)
    expect(evalExpr(where('shot'), ctx)).toBe(UNKNOWN) // bare non-player object
    const bareCtx = { game, rally: {}, rallyIdx: 0, shot: {}, shotIdx: 0 }
    expect(evalExpr(where('shot[-1].num'), bareCtx)).toBe(UNKNOWN)
  })

  test('kitchen and teammate-side sugars', () => {
    // near-kitchen: within 4ft of one's own kitchen line (the pipeline's
    // kitchen-arrival threshold)
    expect(shotsWhere('me.isNearKitchen')).toEqual([[0, 2], [2, 2], [2, 3]])
    // 9 shots: 3 near, 1 with no position data (unknown, so neither side)
    expect(shotsWhere('NOT me.isNearKitchen')).toHaveLength(5)
    // p0 holds her court's right side all fixture long, so her partner
    // never does; the position-less shot stays unknown
    expect(shotsWhere('me.isRightOfTeammate')).toHaveLength(8)
    expect(shotsWhere(
      'shot.hitter = me.teammate AND shot.hitter.isRightOfTeammate'))
      .toEqual([])
    expect(shotsWhere(
      'shot.hitter = me.teammate AND NOT shot.hitter.isRightOfTeammate'))
      .toEqual([[0, 2], [2, 2]])
    // singles: there is no teammate to be right of
    const singles = runQuery({
      text: 'FROM "testvid00002" WHERE me.isRightOfTeammate',
      games: [makeSinglesGame()]
    })
    expect(singles.errors).toBeUndefined()
    expect(singles.shots).toEqual([])
  })

  test('rally.count() counts condition-satisfying shots per rally', () => {
    // rally 2 is the only rally where p0 stood near the kitchen twice
    expect(shotsWhere('rally.count(me.isNearKitchen) >= 2'))
      .toEqual([[2, 0], [2, 1], [2, 2], [2, 3]])
    // exactly one drop: rally 0
    expect(shotsWhere('rally.count(shot.type = "drop") = 1'))
      .toEqual([[0, 0], [0, 1], [0, 2]])
    // unknown never counts: rally 1's second shot has no position data, so
    // its near-kitchen count is 0, not unknown
    expect(shotsWhere('rally.count(me.isNearKitchen) = 0 AND rally.num = 2'))
      .toHaveLength(2)
    // relative rally offsets resolve before counting; out-of-range is
    // unknown (rally 0 has no predecessor)
    expect(shotsWhere('rally[-1].count(shot.num = 1) = 1'))
      .toEqual([[1, 0], [1, 1], [2, 0], [2, 1], [2, 2], [2, 3]])
    // usable as a SELECT column and GROUP BY-free projection input
    const rows = runQuery({
      text: 'SELECT rally.num, rally.count(shot.hitter = me) AS "mine" ' +
        'FROM "testvid00001" WHERE shot.num = 1',
      games: [makeDoublesGame()]
    })
    expect(rows.errors).toBeUndefined()
    expect(rows.rows).toEqual([[1, 1], [2, 1], [3, 1]])
    // a bare context with no rally shots counts zero
    expect(evalExpr(
      parse('FROM "x" WHERE rally.count(shot.num = 1) = 0').ast.where,
      { game: { rallies: [{}] }, rally: {}, rallyIdx: 0, shot: {}, shotIdx: 0 }))
      .toBe(true)
  })

  test('SELECT * lists every scalar column of shot, rally, and game', () => {
    const r = runQuery({
      text: 'SELECT * FROM "testvid00001" WHERE shot.num = 1 LIMIT 1',
      games: [makeDoublesGame()]
    })
    expect(r.errors).toBeUndefined()
    // the whole dictionary, prefixed and in dictionary order
    expect(r.columns[0]).toBe('shot.num')
    expect(r.columns).toContain('shot.quality.overall')
    expect(r.columns).toContain('rally.numShots')
    expect(r.columns.at(-1)).toBe('game.winner')
    expect(new Set(r.columns).size).toBe(r.columns.length)
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]).toHaveLength(r.columns.length)
    // spot values: the serve is shot 1 of rally 1
    expect(r.rows[0][r.columns.indexOf('shot.num')]).toBe(1)
    expect(r.rows[0][r.columns.indexOf('rally.num')]).toBe(1)
  })

  test('HAVING filters grouped rows before ORDER BY and LIMIT', () => {
    const grouped = rest => runQuery({
      text: 'SELECT rally.num, count() FROM "x" WHERE shot.num >= 1 ' +
        'GROUP BY rally.num ' + rest,
      games: [makeDoublesGame()]
    })
    expect(grouped('HAVING count() >= 3').rows).toEqual([[1, 3], [3, 4]])
    // keys and aggregates combine freely, at any depth
    expect(grouped('HAVING rally.num >= 2 AND count() * 2 >= 4').rows)
      .toEqual([[2, 2], [3, 4]])
    // the filter runs before ORDER BY/LIMIT
    expect(grouped('HAVING count() >= 3 ORDER BY count() DESC LIMIT 1').rows)
      .toEqual([[3, 4]])
    // a group whose condition is unknown is dropped (pressure is unknown
    // on every shot of rally 2)
    expect(grouped('HAVING avg(shot.quality.pressure) >= 0').rows)
      .toEqual([[1, 3], [3, 4]])
  })

  test('game-object properties evaluate in queries', () => {
    expect(shotsWhere('game.numRallies = 3')).toHaveLength(9)
    expect(shotsWhere('game.winner = me.team')).toHaveLength(9)
    // the game clock: start 10s, end 64s, and the invariant tying them
    expect(shotsWhere('game.startTime = 10 AND game.endTime = 64')).toHaveLength(9)
    expect(shotsWhere('game.startTime + game.duration = game.endTime'))
      .toHaveLength(9)
  })
})

describe('runQuery: SELECT', () => {
  test('projects one row per shot with labeled columns', () => {
    const result = runQuery({
      text: 'SELECT shot.num, shot.speed AS "mph" FROM "x" WHERE rally.num = 3 ORDER BY shot.num',
      games: [makeDoublesGame()]
    })
    expect(result.columns).toEqual(['shot.num', 'mph'])
    expect(result.rows).toEqual([[1, 30], [2, 30], [3, 50], [4, 30]])
  })

  test('unknown values project as null', () => {
    const result = runQuery({
      text: 'SELECT shot.isVolley FROM "x" WHERE rally.num = 2',
      games: [makeDoublesGame()]
    })
    expect(result.rows).toEqual([[null], [null]])
  })

  test('a rating breakdown is one row of areas, ready to chart', () => {
    // the shape make_chart needs for "which part of my game should I work
    // on": a column per skill area, so x is the area and y the rating
    const result = runQuery({
      text: 'SELECT avg(shot.hitter.rating.offense) AS "offense", ' +
        'avg(shot.hitter.rating.defense) AS "defense", ' +
        'avg(shot.hitter.rating.courtIQ) AS "court IQ" ' +
        'FROM "x" WHERE shot.hitter.id = 0',
      games: [makeDoublesGame()]
    })
    expect(result.columns).toEqual(['offense', 'defense', 'court IQ'])
    // a rating repeats on every shot of the game, so its average IS the
    // rating -- which is what makes this a one-line query
    expect(result.rows).toEqual([[4, 3, 3.6]])
  })

  test('an unrated area averages to unknown, never to zero', () => {
    // p2 is rated on nothing; folding that to 0 would tell the player their
    // game collapsed when it was simply never scored
    const result = runQuery({
      text: 'SELECT avg(shot.hitter.rating.overall) AS "r" ' +
        'FROM "x" WHERE shot.hitter.id = 2',
      games: [makeDoublesGame()]
    })
    expect(result.rows).toEqual([[null]])
  })

  test('aggregates collapse to one row and skip unknowns', () => {
    const result = runQuery({
      text: 'SELECT count(), avg(shot.speed), min(shot.speed), max(shot.speed), sum(shot.num) ' +
        'FROM "x" WHERE rally.num = 3',
      games: [makeDoublesGame()]
    })
    expect(result.rows).toEqual([[4, 35, 30, 50, 10]])
    const sparse = runQuery({
      text: 'SELECT avg(shot.speed) FROM "x" WHERE rally.num = 2',
      games: [makeDoublesGame()]
    })
    expect(sparse.rows).toEqual([[38]]) // the trajectory-less shot is skipped
    const empty = runQuery({
      text: 'SELECT count(), avg(shot.speed) FROM "x" WHERE false',
      games: [makeDoublesGame()]
    })
    expect(empty.rows).toEqual([[0, null]])
  })

  test('aggregates coerce inputs like scalar functions: non-numbers skip', () => {
    // sum over a string property must yield null, never string concatenation
    const result = runQuery({
      text: 'SELECT sum(shot.type), avg(shot.type), min(shot.type), max(shot.type) FROM "x" WHERE true',
      games: [makeDoublesGame()]
    })
    expect(result.rows).toEqual([[null, null, null, null]])
  })

  test('boolean aggregates: sum counts trues, avg is a rate', () => {
    // is_volley is present on (0,0)=false, (0,1)=false, (0,2)=true, (2,2)=true
    const result = runQuery({
      text: 'SELECT sum(shot.isVolley) AS "volleys", avg(shot.isVolley) AS "rate" ' +
        'FROM "x" WHERE exists(shot.isVolley)',
      games: [makeDoublesGame()]
    })
    expect(result.rows).toEqual([[2, 0.5]]) // 2 of 4 known volleys
    // a comparison as an aggregate argument: my team's rally-win rate over
    // the first shot of each rally (rallies 0 and 2 won by team 0, 1 by team 1)
    const rate = runQuery({
      text: 'SELECT avg(rally.winner = me.team) AS "win rate", sum(rally.winner = me.team) ' +
        'FROM "x" WHERE shot.num = 1',
      games: [makeDoublesGame()]
    })
    expect(rate.rows).toEqual([[2 / 3, 2]])
    // strings still skip: min/max over a boolean fold to 0/1
    const mm = runQuery({
      text: 'SELECT min(shot.isVolley), max(shot.isVolley) FROM "x" WHERE exists(shot.isVolley)',
      games: [makeDoublesGame()]
    })
    expect(mm.rows).toEqual([[0, 1]])
  })

  test('mixing aggregates with per-shot expressions is an error', () => {
    const result = runQuery({
      text: 'SELECT count(), shot.num FROM "x" WHERE true',
      games: [makeDoublesGame()]
    })
    expect(result.errors[0].code).toBe('PBQL_MIXED_AGGREGATES')
  })

  test('aggregates are operands: arithmetic on them projects one row', () => {
    const project = text => runQuery({ text, games: [makeDoublesGame()] })
    // 9 shots; speeds 35, 20, 45, 38, 30, 30, 50, 30 (the sparse shot has none)
    const result = project('SELECT count() / 2, ' +
      'max(shot.speed) - min(shot.speed) AS "spread", ' +
      'kph(max(shot.speed)) FROM "x" WHERE true')
    expect(result.columns).toEqual(['count() / 2', 'spread', 'kph(max(shot.speed))'])
    expect(result.rows).toEqual([[4.5, 30, 50 * 1.609344]])
    // unknown propagates through the arithmetic: it never becomes 0
    expect(project('SELECT avg(shot.type) * 100 FROM "x" WHERE true').rows)
      .toEqual([[null]])
    // an empty selection still projects its one row (and 100/0 is unknown)
    expect(project('SELECT count(), 100 / count() FROM "x" WHERE false').rows)
      .toEqual([[0, null]])
  })

  test('an aggregate row over no shots has no game context', () => {
    // nothing was selected, so there is no shot to read the game off: the
    // frame rate is unknown and date() falls back to the local zone
    const result = runQuery({
      text: 'SELECT timecode(count(), true), date(count()) FROM "x" WHERE false',
      games: [makeDoublesGame()]
    })
    expect(result.rows).toEqual([[null, new Date(0).toLocaleDateString('en-CA')]])
  })
})

describe('runQuery: GROUP BY', () => {
  const group = text => runQuery({ text, games: [makeDoublesGame()] })

  test('one row per key, default order ascending with the null key last', () => {
    // types: drive ×6, drop, smash, and the sparse shot (unknown)
    const result = group('SELECT shot.type, count() FROM "x" WHERE true GROUP BY shot.type')
    expect(result.columns).toEqual(['shot.type', 'count()'])
    expect(result.rows).toEqual([
      ['drive', 6], ['drop', 1], ['smash', 1], [null, 1]])
    // the shot list itself is unaffected by grouping (video order)
    expect(result.shots).toHaveLength(9)
  })

  test('multi-key tuples: nulls group per component and sort last', () => {
    // isVolley is known on (0,0)=F, (0,1)=F, (0,2)=T, (2,2)=T; unknown else
    const result = group('SELECT shot.isVolley, shot.type, count() FROM "x" ' +
      'WHERE true GROUP BY shot.isVolley, shot.type')
    expect(result.rows).toEqual([
      [false, 'drive', 1],
      [false, 'drop', 1],
      [true, 'drive', 1],
      [true, 'smash', 1],
      [null, 'drive', 4], // (1,0), (2,0), (2,1), (2,3)
      [null, null, 1] // the sparse shot: both keys unknown
    ])
  })

  test('a null key sorts last even when its group forms first', () => {
    // winnerType is unknown on (0,0) — the first group created — and
    // known ("clean") only on (0,2)
    const result = group(
      'SELECT shot.winnerType, count() FROM "x" WHERE true GROUP BY shot.winnerType')
    expect(result.rows).toEqual([['clean', 1], [null, 8]])
  })

  test('boolean aggregates are per-group rates', () => {
    // team 0 hit 5 shots in rallies won 0,0,1,0,0 → 4/5; team 1 hit 4 in
    // rallies won 0,1,0,0 → 1/4
    const result = group('SELECT shot.hitter.team, ' +
      'avg(rally.winner = shot.hitter.team) AS "win rate", ' +
      'sum(rally.winner = shot.hitter.team) FROM "x" WHERE true ' +
      'GROUP BY shot.hitter.team')
    expect(result.rows).toEqual([[0, 0.8, 4], [1, 0.25, 1]])
  })

  test('scaled aggregates: a rate as a percentage, per group', () => {
    // the charting case: my rallies by shot type — rallies 0 and 2 (both my
    // drives) went to my team, rally 1 (my sparse, type-less shot) did not
    const result = group('SELECT shot.type, ' +
      'avg(rally.winner = me.team) * 100 AS "win %" FROM "x" ' +
      'WHERE shot.hitter = me GROUP BY shot.type')
    expect(result.columns).toEqual(['shot.type', 'win %'])
    expect(result.rows).toEqual([['drive', 100], [null, 0]])
  })

  test('HAVING and ORDER BY take scaled aggregates too', () => {
    // avg speeds are drive 35.5, drop 20, smash 45 (the null-type group has
    // no speeds at all): only the groups past 50 km/h survive
    expect(group('SELECT shot.type, avg(shot.speed) AS "mph" FROM "x" ' +
      'WHERE true GROUP BY shot.type HAVING avg(shot.speed) * 1.609 > 50').rows)
      .toEqual([['drive', 35.5], ['smash', 45]])
    // avg overall quality: smash 0.95, drop 0.9, drive ~0.692, null-type 0.2
    expect(group('SELECT shot.type FROM "x" WHERE true GROUP BY shot.type ' +
      'ORDER BY avg(shot.quality.overall) * 100 DESC').rows)
      .toEqual([['smash'], ['drop'], ['drive'], [null]])
  })

  test('ORDER BY an aggregate DESC with LIMIT keeps the top rows', () => {
    const result = group('SELECT shot.type, count() FROM "x" WHERE true ' +
      'GROUP BY shot.type ORDER BY count() DESC LIMIT 2')
    // stable: the three 1-count groups keep video order, drop first
    expect(result.rows).toEqual([['drive', 6], ['drop', 1]])
    // LIMIT applies to rows, never to the selected shots
    expect(result.shots).toHaveLength(9)
  })

  test('ORDER BY aggregates need not be selected; null aggregates sort last', () => {
    // the sparse shot's null-type group has no speeds → avg null → last
    const result = group('SELECT shot.type FROM "x" WHERE true ' +
      'GROUP BY shot.type ORDER BY avg(shot.speed) DESC')
    // avg speeds: smash 45, drive (35+38+30+30+50+30)/6 = 35.5, drop 20
    expect(result.rows).toEqual(
      [['smash'], ['drive'], ['drop'], [null]])
  })

  test('ORDER BY a key DESC still sorts the null key last', () => {
    const result = group('SELECT shot.type, avg(shot.speed) AS "mph" FROM "x" ' +
      'WHERE true GROUP BY shot.type ORDER BY shot.type DESC')
    expect(result.rows).toEqual([
      ['smash', 45], ['drop', 20], ['drive', 35.5], [null, null]])
  })

  test('an unknown key everywhere makes one null-key group (and warns for me)', () => {
    const game = makeDoublesGame()
    game.meta = {} // me is not tagged: me.team is unknown for every shot
    const result = runQuery({
      text: 'SELECT me.team AS "team", count() FROM "x" WHERE true GROUP BY me.team',
      games: [game]
    })
    expect(result.rows).toEqual([[null, 9]])
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'PBQL_ME_NOT_TAGGED' })])
  })

  test('grouped analyzer errors surface through runQuery', () => {
    expect(group('SELECT shot.speed FROM "x" WHERE true GROUP BY shot.type')
      .errors[0].code).toBe('PBQL_NOT_GROUPED')
    expect(group('FROM "x" WHERE true GROUP BY shot.type').errors[0].code)
      .toBe('PBQL_GROUP_BY_NO_SELECT')
    expect(group('SELECT count() FROM "x" WHERE true GROUP BY shot.type ' +
      'CONTEXT BEFORE 1 shot').errors[0].code).toBe('PBQL_GROUP_BY_CONTEXT')
  })
})

describe('runQuery: inputs and errors', () => {
  test('singles: teammate/opponent2 unknown, lone opponent answers LHS', () => {
    const games = [makeSinglesGame()]
    const run = text => runQuery({ text, games }).shots.map(s => [s.rallyIdx, s.shotIdx])
    expect(run('FROM "x" WHERE me.opponent1.name = "Carol"')).toHaveLength(2)
    expect(run('FROM "x" WHERE me.teammate.name = "Carol"')).toEqual([])
    expect(run('FROM "x" WHERE shot.hitter.opponent2.name = "Carol"')).toEqual([])
    expect(run('FROM "x" WHERE shot.hitter.opponentLHS.name = "Carol"'))
      .toEqual([[0, 0]])
  })

  test('skips-and-reports games with unsupported insights versions', () => {
    const old = { vid: 'oldvideo0001', sessionIdx: 0, insights: { version: '2.9.0', rallies: [] } }
    const result = runQuery({
      text: 'FROM "x" WHERE true',
      games: [makeDoublesGame(), old]
    })
    expect(result.shots).toHaveLength(9)
    expect(result.warnings).toEqual([{
      vid: 'oldvideo0001',
      sessionIdx: 0,
      code: 'PBQL_UNSUPPORTED_VERSION',
      message: expect.stringContaining('unsupported insights version "2.9.0"')
    }])
  })

  test('skips-and-reports games with malformed insights', () => {
    const bad = {
      vid: 'badvideo0001',
      sessionIdx: 0,
      insights: { version: '4.2.0', rallies: 'nope' }
    }
    const result = runQuery({
      text: 'FROM "x" WHERE true',
      games: [makeDoublesGame(), bad]
    })
    expect(result.shots).toHaveLength(9)
    expect(result.warnings).toEqual([{
      vid: 'badvideo0001',
      sessionIdx: 0,
      code: 'PBQL_INVALID_INSIGHTS',
      message: expect.stringContaining('malformed insights JSON')
    }])
  })

  test('non-finite numbers in the data are unknown, never Infinity', () => {
    const game = makeDoublesGame()
    // JSON has no Infinity, but 1e400 parses to it and could otherwise
    // leak through properties into comparisons and outputs
    game.insights.rallies[0].shots[0].resulting_ball_movement.speed =
      JSON.parse('1e400')
    const result = runQuery({
      text: 'SELECT shot.speed FROM "x" WHERE rally.num = 1 AND shot.num = 1',
      games: [game]
    })
    expect(result.rows).toEqual([[null]])
    expect(shotsToCSV(result)).toBe('shot.speed\r\n\r\n') // empty, not Infinity
    // comparisons with the smuggled value are unknown, so WHERE drops it
    const filtered = runQuery({
      text: 'FROM "x" WHERE rally.num = 1 AND shot.speed > 0',
      games: [game]
    })
    expect(filtered.shots.map(s => s.shotIdx)).toEqual([1, 2])
    // asNumber guards call/arith/neg inputs against non-finite values too
    expect(evalExpr({ kind: 'neg', arg: { kind: 'lit', value: Infinity } }, {}))
      .toBe(UNKNOWN)
  })

  test('durations with a missing end_ms are unknown, never NaN', () => {
    const game = makeDoublesGame()
    delete game.insights.rallies[1].end_ms // rally.duration → NaN pre-mapping
    delete game.insights.rallies[2].end_ms // game.duration uses the last rally
    // the selected shot is in rally 0, whose own timing stays intact
    const rows = runQuery({
      text: 'SELECT rally[1].duration, game.duration, game.endTime FROM "x" ' +
        'WHERE rally.num = 1 AND shot.num = 1',
      games: [game]
    })
    expect(rows.rows).toEqual([[null, null, null]])
    // exists() sees the same unknowns (NaN never leaks out as a value)
    const missing = runQuery({
      text: 'FROM "x" WHERE rally.num = 1 AND shot.num = 1 AND ' +
        'NOT exists(rally[1].duration) AND NOT exists(game.duration)',
      games: [game]
    })
    expect(missing.shots.map(s => [s.rallyIdx, s.shotIdx])).toEqual([[0, 0]])
  })

  test('warns when "me" is referenced but not tagged in a game', () => {
    const game = makeDoublesGame()
    game.meta = {}
    const result = runQuery({ text: 'FROM "x" WHERE shot.hitter = me', games: [game] })
    expect(result.shots).toEqual([]) // unknown semantics are unchanged
    expect(result.warnings).toEqual([{
      vid: 'testvid00001',
      sessionIdx: 0,
      code: 'PBQL_ME_NOT_TAGGED',
      message: expect.stringContaining('"me" is not tagged in this game')
    }])
  })

  test('me references in SELECT/ORDER BY warn once; hitter refs never do', () => {
    const game = makeDoublesGame()
    game.meta = {}
    const my = runQuery({
      text: 'SELECT me.teammate.name FROM "x" WHERE true ORDER BY me.team',
      games: [game]
    })
    expect(my.warnings).toEqual([
      expect.objectContaining({ code: 'PBQL_ME_NOT_TAGGED' })])
    const hitters = runQuery({
      text: 'FROM "x" WHERE shot.hitter.opponent1.name = "Carol"',
      games: [makeDoublesGame(), game]
    })
    expect(hitters.warnings).toEqual([])
  })

  test('no me warning when the game has a myPlayerIdx', () => {
    const result = runQuery({
      text: 'FROM "x" WHERE shot.hitter = me',
      games: [makeDoublesGame()]
    })
    expect(result.warnings).toEqual([])
  })

  test('warns per unmatched taggedWith pattern, naming the pattern', () => {
    const result = runQuery({
      text: 'FROM "x" WHERE shot.taggedWith("zed*") OR ' +
        'shot.taggedWith("nobody@example.com") OR me.teammate.taggedWith("bob")',
      games: [makeDoublesGame()]
    })
    expect(result.warnings).toEqual([ // "bob" matches, so no third warning
      {
        vid: 'testvid00001',
        sessionIdx: 0,
        code: 'PBQL_TAG_NOT_FOUND',
        message: expect.stringContaining('taggedWith("zed*")')
      },
      {
        vid: 'testvid00001',
        sessionIdx: 0,
        code: 'PBQL_TAG_NOT_FOUND',
        message: expect.stringContaining('taggedWith("nobody@example.com")')
      }
    ])
  })

  test('taggedWith warnings skip null player slots in singles games', () => {
    const games = [makeSinglesGame()] // players: Alice, null, Carol, null
    const carol = runQuery({
      text: 'FROM "x" WHERE shot.taggedWith("carol")', games
    })
    expect(carol.warnings).toEqual([])
    const bob = runQuery({
      text: 'FROM "x" WHERE shot.taggedWith("bob")', games
    })
    expect(bob.warnings).toEqual([
      expect.objectContaining({ code: 'PBQL_TAG_NOT_FOUND' })])
  })

  test('only literal taggedWith patterns are checked', () => {
    const result = runQuery({
      text: 'FROM "x" WHERE false AND shot.taggedWith(shot.winnerType)',
      games: [makeDoublesGame()]
    })
    expect(result.warnings).toEqual([])
    expect(result.shots).toEqual([])
  })

  test('multiple games get their own warnings', () => {
    const untagged = makeSinglesGame()
    untagged.meta = { players: untagged.meta.players } // drop myPlayerIdx
    const result = runQuery({
      text: 'FROM "x" WHERE shot.hitter = me AND shot.taggedWith("bob")',
      games: [makeDoublesGame(), untagged] // doubles resolves both
    })
    expect(result.warnings).toEqual([
      expect.objectContaining({ vid: 'testvid00002', code: 'PBQL_ME_NOT_TAGGED' }),
      expect.objectContaining({ vid: 'testvid00002', code: 'PBQL_TAG_NOT_FOUND' })
    ])
  })

  test('player("Name") is that player, whichever side they played', () => {
    // Alice and Bob are team 0, Carol and Dan team 1; team 0 won rallies 1
    // and 3, team 1 rally 2
    const games = [makeDoublesGame()]
    const winsFor = name => runQuery({
      text: 'SELECT count() FROM "x" WHERE shot.num = 1 AND ' +
        `rally.winner = player("${name}").team`,
      games
    })
    expect(winsFor('Carol').rows).toEqual([[1]])
    expect(winsFor('Bob').rows).toEqual([[2]])
    expect(winsFor('Carol').warnings).toEqual([])
    // ...and it compares as an identity, like me
    const dans = runQuery({
      text: 'SELECT count() FROM "x" WHERE shot.hitter = player("Dan")', games
    })
    const byId = runQuery({
      text: 'SELECT count() FROM "x" WHERE shot.hitter.id = 3', games
    })
    expect(dans.rows).toEqual(byId.rows)
    // an untagged slot answers to the name the app shows for it
    const untagged = makeDoublesGame()
    untagged.meta = { players: [null, null, null, null] }
    expect(runQuery({
      text: 'SELECT count() FROM "x" WHERE shot.num = 1 AND ' +
        'rally.winner = player("Player 3").team',
      games: [untagged]
    }).rows).toEqual([[1]])
  })

  test('player("Name") warns when the game has no one, or several, by that name', () => {
    const missing = runQuery({
      text: 'FROM "x" WHERE shot.hitter = player("Zed")',
      games: [makeDoublesGame()]
    })
    expect(missing.shots).toEqual([])
    expect(missing.warnings).toEqual([expect.objectContaining({
      code: 'PBQL_PLAYER_NOT_FOUND',
      message: expect.stringContaining('player("Zed")')
    })])
    const twins = makeDoublesGame()
    twins.meta = {
      ...twins.meta,
      players: [{ name: 'Sam' }, { name: 'Sam' }, { name: 'Carol' }, { name: 'Dan' }]
    }
    const ambiguous = runQuery({
      text: 'FROM "x" WHERE shot.hitter = player("Sam")', games: [twins]
    })
    // never a guess between the two: unknown, and the warning says why
    expect(ambiguous.shots).toEqual([])
    expect(ambiguous.warnings).toEqual([expect.objectContaining({
      code: 'PBQL_PLAYER_AMBIGUOUS',
      message: expect.stringContaining('2 players in this game are named "Sam"')
    })])
  })

  test('propagates parse and analyze errors', () => {
    expect(runQuery({ text: 'FROM @', games: [] }).errors[0].code)
      .toBe('PBQL_LEX_ERROR')
    expect(runQuery({ text: 'FROM "f" WHERE shot.isVoley', games: [] })
      .errors[0].code).toBe('PBQL_UNKNOWN_PROPERTY')
    // a relation called like a method: an error, never a thrown TypeError
    expect(runQuery({ text: 'FROM "f" WHERE shot.hitter("a")', games: [] })
      .errors[0].code).toBe('PBQL_UNKNOWN_METHOD')
  })
})

// Real files carry explicit JSON nulls wherever the pipeline had nothing
// to say; the engine must read them as unknown (docs §3) instead of
// dereferencing them, and skip-and-report what is structurally broken.
describe('null and malformed data', () => {
  const damaged = mutate => {
    const game = makeDoublesGame()
    mutate(game.insights)
    return game
  }
  const runOn = (expr, game) => {
    const result = runQuery({ text: `FROM "x" WHERE ${expr}`, games: [game] })
    expect(result.errors).toBeUndefined()
    return result
  }

  test('a null position is unknown, and only for the shot that lost it', () => {
    // the strike point sets the hitter frame, so losing it takes every
    // position of that shot with it (the sparse shot has none either way)
    const struck = damaged(i => {
      i.rallies[0].shots[0].resulting_ball_movement.trajectory.start.location =
        null
    })
    expect(runOn('exists(shot.from.x)', struck).shots).toHaveLength(7)
    expect(runOn('exists(shot.from.feetToNet)', struck).shots).toHaveLength(7)
    expect(runOn('exists(shot.to.x)', struck).shots).toHaveLength(7)
    // a null endpoint takes only its own position with it
    const landed = damaged(i => {
      i.rallies[2].shots[0].resulting_ball_movement.trajectory.end.location =
        null
    })
    expect(runOn('exists(shot.to.x)', landed).shots).toHaveLength(7)
    expect(runOn('exists(shot.to.absY)', landed).shots).toHaveLength(7)
    expect(runOn('exists(shot.from.x)', landed).shots).toHaveLength(8)
  })

  test('a game outcome that is not a pair is unknown', () => {
    expect(runOn('game.winner = 0',
      damaged(i => { i.game_data.game_outcome = null })).shots).toEqual([])
    expect(runOn('exists(game.winner)',
      damaged(i => { i.game_data.game_outcome = 7 })).shots).toEqual([])
    // SELECT * reads it for every row, so it must not throw there either
    const projected = runQuery({
      text: 'SELECT * FROM "x" WHERE shot.num = 1',
      games: [damaged(i => { i.game_data.game_outcome = null })]
    })
    expect(projected.rows).toHaveLength(3)
  })

  test('missing and null highlights are unknown, not crashes', () => {
    expect(runOn('shot.inHighlight("atp")',
      damaged(i => { i.highlights = null })).shots).toEqual([])
    expect(runOn('shot.inHighlight("atp")',
      damaged(i => { i.highlights = [null] })).shots).toEqual([])
    // a null entry among real ones is skipped, not fatal
    expect(runOn('shot.inHighlight("atp")',
      damaged(i => { i.highlights.unshift(null) })).shots).toHaveLength(1)
  })

  test('null rally players are unknown, not "nobody reached"', () => {
    // rally 0 loses its answer; rally 1 (nobody arrived) still answers false
    const game = damaged(i => { i.rallies[0].players = null })
    expect(runOn('NOT rally.allPlayersReachedKitchen', game).shots
      .map(s => [s.rallyIdx, s.shotIdx])).toEqual([[1, 0], [1, 1]])
    expect(runOn('rally.allPlayersReachedKitchen', game).shots).toHaveLength(4)
  })

  test('null player_data falls back instead of aborting the query', () => {
    const game = damaged(i => { i.player_data = null })
    expect(runOn('shot.taggedWith("Alice")', game).shots).toHaveLength(3)
    // the batch-wide tag warning probes every slot: it must survive too
    const none = runOn('shot.taggedWith("Nobody")', game)
    expect(none.shots).toEqual([])
    expect(none.warnings[0].code).toBe('PBQL_TAG_NOT_FOUND')
  })

  test('a null tagged address matches nothing, quietly', () => {
    const game = makeDoublesGame()
    game.meta = { ...game.meta, players: [{ name: 'Alice', addr: null }] }
    const result = runOn('shot.taggedWith("alice@example.com")', game)
    expect(result.shots).toEqual([])
    expect(result.warnings[0].code).toBe('PBQL_TAG_NOT_FOUND')
  })

  test('null error blocks mean no error, not an unknown one', () => {
    const game = damaged(i => {
      i.rallies[1].shots[1].errors = null
      i.rallies[2].shots[3].errors.faults = null
    })
    expect(runOn('shot.hasError', game).shots.map(s => [s.rallyIdx, s.shotIdx]))
      .toEqual([[0, 1], [2, 3]])
    expect(runOn('shot.hasFault', game).shots).toEqual([])
  })

  test('a null value is unknown, never a value of its own', () => {
    const game = damaged(i => {
      i.rallies[2].shots[0].shot_type = null
      i.rallies[2].shots[1].shot_type = null
    })
    expect(runOn('exists(shot.type)', game).shots).toHaveLength(6)
    // two absent types are not "the same type": only the real pair matches
    expect(runOn('shot.type = shot[1].type', game).shots
      .map(s => [s.rallyIdx, s.shotIdx])).toEqual([[2, 2]])
  })

  test('null sort keys sort last, in both directions', () => {
    const game = damaged(i => { i.rallies[0].shots[0].shot_type = null })
    const lastTwo = dir => runQuery({
      text: `FROM "x" WHERE shot.num >= 1 ORDER BY shot.type ${dir}`,
      games: [game]
    }).shots.map(s => [s.rallyIdx, s.shotIdx]).slice(-2)
    // the nulled shot joins the sparse one at the end, in video order
    expect(lastTwo('')).toEqual([[0, 0], [1, 1]])
    expect(lastTwo('DESC')).toEqual([[0, 0], [1, 1]])
  })

  test('null timestamps are unknown, not time zero', () => {
    const game = damaged(i => {
      const shot = i.rallies[0].shots[0]
      shot.start_ms = null
      shot.resulting_ball_movement.trajectory.start.ms = null
      i.rallies[1].end_ms = null
    })
    expect(runOn('shot.hitTime <= 0', game).shots).toEqual([])
    expect(runOn('exists(shot.hitTime)', game).shots).toHaveLength(8)
    expect(runOn('exists(rally.endTime)', game).shots).toHaveLength(7)
    expect(runOn('exists(rally.duration)', game).shots).toHaveLength(7)
    // the game's own span needs both ends too
    const spanless = damaged(i => { i.rallies[0].start_ms = null })
    expect(runOn('exists(game.startTime)', spanless).shots).toEqual([])
    expect(runOn('exists(game.duration)', spanless).shots).toEqual([])
  })

  test('a shot without a player_id has no hitter at all', () => {
    const game = damaged(i => { i.rallies[0].shots[0].player_id = null })
    // "null" is not a player: it is neither on team 0 nor anyone's partner
    expect(runOn('shot.hitter.team = 0', game).shots
      .map(s => [s.rallyIdx, s.shotIdx])).toEqual([[0, 2], [1, 1], [2, 0], [2, 2]])
    expect(runOn('exists(shot.hitter.teammate.id)', game).shots).toHaveLength(8)
    expect(runOn('shot.hitter = me', game).shots).toHaveLength(2)
    expect(runOn('shot.taggedWith("Alice")', game).shots).toHaveLength(2)
  })

  test('a null myPlayerIdx is untagged, warning and all', () => {
    const game = makeDoublesGame()
    game.meta = { ...game.meta, myPlayerIdx: null }
    const result = runOn('me.team = 0', game)
    expect(result.shots).toEqual([])
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'PBQL_ME_NOT_TAGGED' })])
  })

  test('a shot that is not an object skips the game with a warning', () => {
    for (const broken of [null, 7]) {
      const result = runQuery({
        text: 'FROM "x" WHERE shot.num = 1',
        games: [damaged(i => { i.rallies[0].shots[1] = broken })]
      })
      expect(result.shots).toEqual([])
      expect(result.warnings).toEqual([{
        vid: 'testvid00001',
        sessionIdx: 0,
        code: 'PBQL_INVALID_INSIGHTS',
        message: expect.stringContaining('rallies[0].shots[1] is not an object')
      }])
    }
  })
})

describe('default "Player N" names', () => {
  test('untagged players are queryable by the name the UI shows', () => {
    const game = makeDoublesGame()
    game.meta = {} // nobody tagged: insights defaults ("Player 3") apply
    const result = runQuery({
      text: 'FROM "v" WHERE shot.taggedWith("player 3")',
      games: [game]
    })
    expect(result.shots.map(s => [s.rallyIdx, s.shotIdx]))
      .toEqual([[0, 1], [1, 0], [2, 1]])
    expect(result.warnings).toEqual([])
    // even with no player_data at all, the "Player N" fallback holds
    delete game.insights.player_data
    const bare = runQuery({
      text: 'FROM "v" WHERE shot.hitter.name = "Player 3"',
      games: [{ ...game, insights: game.insights }]
    })
    expect(bare.shots).toHaveLength(3)
  })

  test('tagged names supersede defaults; empty singles slots never match', () => {
    const tagged = runQuery({
      text: 'FROM "v" WHERE shot.taggedWith("Player 3")',
      games: [makeDoublesGame()] // p2 is tagged as Carol
    })
    expect(tagged.shots).toEqual([])
    expect(tagged.warnings[0].code).toBe('PBQL_TAG_NOT_FOUND')
    const singles = runQuery({
      text: 'FROM "v" WHERE shot.taggedWith("Player 2")',
      games: [makeSinglesGame()] // slot 1 is empty in singles
    })
    expect(singles.shots).toEqual([])
    expect(singles.warnings[0].code).toBe('PBQL_TAG_NOT_FOUND')
  })
})

describe('runQuery: UNION', () => {
  const both = () => [makeDoublesGame(), makeSinglesGame()]
  const run = text => runQuery({ text, games: both() })

  test('joins rows from branches, naming columns from the first', () => {
    // the second branch supplies rows, not headings: SQL takes names from
    // the first branch, so a branch that forgot its aliases still lines up
    const result = run(
      'SELECT "serves" AS "what", count() AS "n" ' +
      'FROM "testvid00001" WHERE shot.num = 1 ' +
      'UNION ALL ' +
      'SELECT "drops", count() FROM "testvid00001" WHERE shot.type = "drop"')
    expect(result.errors).toBeUndefined()
    expect(result.columns).toEqual(['what', 'n'])
    expect(result.rows).toEqual([['serves', 3], ['drops', 1]])
  })

  test('each branch keeps its own FROM, WHERE and LIMIT', () => {
    // the whole reason UNION earns its place: one shot from each game.
    // An OR over both sources shares a single LIMIT and can return two
    // from the same game, which is a different question.
    const result = run(
      'FROM "testvid00001" WHERE shot.num = 1 LIMIT 1 ' +
      'UNION ALL ' +
      'FROM "testvid00002" WHERE shot.num = 1 LIMIT 1')
    expect(result.errors).toBeUndefined()
    expect(result.shots.map(s => s.vid))
      .toEqual(['testvid00001', 'testvid00002'])
  })

  test('a branch sees only the games its own FROM names', () => {
    // deliberately asymmetric. A LONE query does not narrow: the host
    // resolved FROM and passed the games it meant, and second-guessing
    // that would change every existing caller's results. Only a union
    // narrows, because there its branches disagree about FROM and
    // something has to decide which rows came from where.
    const lone = run('FROM "testvid00002" WHERE shot.num = 1')
    expect(new Set(lone.shots.map(s => s.vid)))
      .toEqual(new Set(['testvid00001', 'testvid00002']))

    const branch = run('FROM "testvid00002" WHERE shot.num = 1 ' +
      'UNION ALL FROM "testvid00002" WHERE shot.num = 2')
    expect(branch.shots.every(s => s.vid === 'testvid00002')).toBe(true)
  })

  test('UNION de-duplicates, UNION ALL does not', () => {
    const q = 'SELECT count() AS "n" FROM "testvid00001" WHERE shot.num = 1'
    expect(run(`${q} UNION ALL ${q}`).rows).toEqual([[3], [3]])
    expect(run(`${q} UNION ${q}`).rows).toEqual([[3]])
  })

  test('UNION de-duplicates shots too', () => {
    const q = 'FROM "testvid00001" WHERE shot.num = 1'
    expect(run(`${q} UNION ALL ${q}`).shots).toHaveLength(6)
    expect(run(`${q} UNION ${q}`).shots).toHaveLength(3)
  })

  test('branches must agree on shape and width', () => {
    expect(run('SELECT count() FROM "testvid00001" WHERE true ' +
      'UNION ALL FROM "testvid00002" WHERE true').errors[0].code)
      .toBe('PBQL_UNION_SHAPE')
    expect(run('SELECT count() FROM "testvid00001" WHERE true UNION ALL ' +
      'SELECT count(), count() FROM "testvid00002" WHERE true').errors[0])
      .toMatchObject({ code: 'PBQL_UNION_WIDTH', message: /1 and 2/ })
  })

  test('every branch is analyzed, not just the first', () => {
    const result = run('SELECT count() FROM "testvid00001" WHERE true ' +
      'UNION ALL SELECT count() FROM "testvid00002" WHERE shot.nope = 1')
    expect(result.errors).toHaveLength(1)
    expect(result.rows).toBeUndefined()
  })

  test('a branch naming a glob keeps every game rather than none', () => {
    // a glob expands host-side into games this layer never sees the names
    // of, so narrowing would silently drop every row
    const result = runQuery({
      text: 'FROM "games/*.json" WHERE shot.num = 1 ' +
        'UNION ALL FROM "testvid00002" WHERE shot.num = 1',
      games: both()
    })
    expect(result.errors).toBeUndefined()
    expect(result.shots.length).toBeGreaterThan(3)
  })

  test('a branch may name a file path', () => {
    const result = runQuery({
      text: 'FROM "/tmp/testvid00001.json" WHERE shot.num = 1 ' +
        'UNION ALL FROM "testvid00002" WHERE shot.num = 1',
      games: both()
    })
    expect(result.errors).toBeUndefined()
    expect(new Set(result.shots.map(s => s.vid)))
      .toEqual(new Set(['testvid00001', 'testvid00002']))
  })
})
