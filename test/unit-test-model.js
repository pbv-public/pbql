import { Game, InvalidInsightsError, UnsupportedInsightsError } from '../src/model/game.js'
import * as geometry from '../src/model/geometry.js'
import { REGISTRY, playerMatchesTag } from '../src/model/registry.js'

import { makeDoublesGame, makeSinglesGame } from './fixtures/make-insights.js'

const game = new Game(makeDoublesGame())
// rally 0, shot 1: hit by p2 from the far side at abs (15, 40)
const farShotCtx = { game, rally: game.rallies[0], rallyIdx: 0, shot: game.rallies[0].shots[1], shotIdx: 1 }
// rally 1, shot 1: the sparse shot (no trajectory/ball movement at all)
const sparseCtx = { game, rally: game.rallies[1], rallyIdx: 1, shot: game.rallies[1].shots[1], shotIdx: 1 }

describe('geometry', () => {
  test('near-side frames reflect x only (own baseline already y=0)', () => {
    // by hand: x' = 20 − 5 = 15; y and z pass through
    expect(geometry.toPlayerFrame({ x: 5, y: 2, z: 1 }, false))
      .toEqual({ x: 15, y: 2, z: 1 })
  })

  test('far-side frames reflect y only (x already grows to the right)', () => {
    // by hand: y' = 44 − 40 = 4; x and z pass through
    expect(geometry.toPlayerFrame({ x: 15, y: 40, z: 3 }, true))
      .toEqual({ x: 15, y: 4, z: 3 })
    expect(geometry.toPlayerFrame({ x: 15, y: 40 }, true)).toEqual({ x: 15, y: 4 })
  })

  test('distances to lines', () => {
    expect(geometry.feetToNearestSideline({ x: 3, y: 10 })).toBe(3)
    expect(geometry.feetToNearestSideline({ x: 18, y: 10 })).toBe(2)
    expect(geometry.feetToNearestBaseline({ x: 3, y: 40 })).toBe(4)
    expect(geometry.feetToNet({ x: 3, y: 15 })).toBe(7)
  })

  test('feetToKitchen clamps to 0 at/inside the kitchen', () => {
    expect(geometry.feetToKitchen({ x: 5, y: 2 })).toBe(13) // near side
    expect(geometry.feetToKitchen({ x: 5, y: 16 })).toBe(0) // inside kitchen
    expect(geometry.feetToKitchen({ x: 5, y: 40 })).toBe(11) // far side
    expect(geometry.feetToKitchen({ x: 5, y: 27 })).toBe(0) // inside far kitchen
  })
})

describe('Game', () => {
  test('rejects unsupported insights majors with a helpful error', () => {
    for (const version of ['2.9.0', '1.0.2', undefined]) {
      expect(() => new Game({
        vid: 'x',
        sessionIdx: 0,
        insights: { version, rallies: [] }
      })).toThrow(UnsupportedInsightsError)
    }
  })

  test('rejects malformed insights with InvalidInsightsError', () => {
    const make = insights => () => new Game({ vid: 'x', sessionIdx: 0, insights })
    for (const insights of [null, 'not an object', 42, []]) {
      expect(make(insights)).toThrow(InvalidInsightsError)
    }
    expect(make({ version: '4.2.0' }))
      .toThrow('"rallies" is missing or not an array')
    expect(make({ version: '4.2.0', rallies: 'nope' }))
      .toThrow(InvalidInsightsError)
    expect(make({ version: '4.2.0', rallies: [null] }))
      .toThrow('rallies[0] is not an object')
    expect(make({ version: '4.2.0', rallies: ['nope'] }))
      .toThrow(InvalidInsightsError)
    expect(make({ version: '4.2.0', rallies: [{}, { shots: 'nope' }] }))
      .toThrow('rallies[1].shots is not an array')
  })

  test('indexes every shot in video order', () => {
    expect(game.shotRefs.map(r => [r.rallyIdx, r.shotIdx])).toEqual([
      [0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [2, 0], [2, 1], [2, 2], [2, 3]])
  })

  test('hit/end times prefer trajectory timing, then start/end_ms', () => {
    expect(game.hitMs(game.rallies[0].shots[0])).toBe(12000)
    expect(game.endMs(game.rallies[0].shots[0])).toBe(13000)
    // the sparse shot has no trajectory
    expect(game.hitMs(sparseCtx.shot)).toBe(35000)
    expect(game.endMs(sparseCtx.shot)).toBe(35600)
  })

  test('player names prefer host-supplied tags over insights defaults', () => {
    expect(game.playerName(0)).toBe('Alice')
    const untagged = new Game({ ...makeDoublesGame(), meta: {} })
    expect(untagged.playerName(0)).toBe('Player 1')
    expect(untagged.myPlayerIdx).toBeUndefined()
    // a null tag is no tag: it must not read as player slot 0
    const nulled = new Game({ ...makeDoublesGame(), meta: { myPlayerIdx: null } })
    expect(nulled.myPlayerIdx).toBeUndefined()
  })

  test('playerHandedness only surfaces the orientable values', () => {
    expect(game.playerHandedness(0)).toBe('right')
    expect(game.playerHandedness(1)).toBe('left')
    expect(game.playerHandedness(2)).toBeUndefined() // untagged
    expect(game.playerHandedness(3)).toBeUndefined() // "both" cannot orient
    const bare = makeDoublesGame()
    delete bare.insights.player_data // bucket-shaped insights
    expect(new Game(bare).playerHandedness(0)).toBeUndefined()
  })

  test('team falls back to the id convention without player_data', () => {
    const bare = makeDoublesGame()
    delete bare.insights.player_data
    const bareGame = new Game(bare)
    expect([0, 1, 2, 3].map(i => bareGame.playerTeam(i))).toEqual([0, 0, 1, 1])
  })

  test('exposes per-shot player positions', () => {
    expect(game.playerPosAtShot(game.rallies[0].shots[0], 2)).toEqual({ x: 4, y: 41 })
    expect(game.playerPosAtShot(sparseCtx.shot, 0)).toBeUndefined()
  })
})

describe('registry', () => {
  test('every property extractor tolerates rich, sparse, and bare shots', () => {
    // a pathological context: empty shot in an empty rally
    const bareCtx = { game, rally: {}, rallyIdx: 0, shot: {}, shotIdx: 9 }
    for (const [objName, { propList }] of Object.entries(REGISTRY)) {
      for (const prop of propList) {
        for (const ctx of [farShotCtx, sparseCtx, bareCtx]) {
          // player props take an index; others ignore the extra arg
          const value = prop.extract(ctx, 1)
          if (value !== undefined) {
            const expected = { string: 'string', boolean: 'boolean' }[prop.type] ?? 'number'
            expect([objName, prop.path, typeof value].join(':'))
              .toBe([objName, prop.path, expected].join(':'))
          }
        }
      }
    }
  })

  test('hitter-frame coordinates mirror y for far-side hitters', () => {
    const props = REGISTRY.shot.props
    // struck at abs (15, 40), far side: x' = 15 (kept), y' = 44 − 40 = 4
    expect(props.get('from.x').extract(farShotCtx)).toBe(15)
    expect(props.get('from.y').extract(farShotCtx)).toBe(4)
    expect(props.get('from.absX').extract(farShotCtx)).toBe(15)
    expect(props.get('from.absY').extract(farShotCtx)).toBe(40)
    expect(props.get('from.z').extract(farShotCtx)).toBe(3)
  })

  test('num/times derive from position and timing', () => {
    const props = REGISTRY.shot.props
    expect(props.get('num').extract(farShotCtx)).toBe(2)
    expect(props.get('hitTime').extract(farShotCtx)).toBe(15)
    expect(props.get('endTime').extract(farShotCtx)).toBe(16)
  })

  test('error properties, presence flags never unknown', () => {
    const props = REGISTRY.shot.props
    expect(props.get('hasError').extract(farShotCtx)).toBe(true) // popup
    expect(props.get('hasFault').extract(farShotCtx)).toBe(false)
    expect(props.get('hasError').extract(sparseCtx)).toBe(true)
    expect(props.get('hasFault').extract(sparseCtx)).toBe(true)
    expect(props.get('errors.faults.net').extract(sparseCtx)).toBe(true)
    expect(props.get('errors.popup').extract(farShotCtx)).toBe('potential')
  })

  test('fault flags read false, never unknown, when the fault is absent', () => {
    const props = REGISTRY.shot.props
    // no faults group at all (farShotCtx), and a shot with no errors at all
    const cleanCtx = { ...farShotCtx, shot: game.rallies[0].shots[0], shotIdx: 0 }
    for (const ctx of [farShotCtx, cleanCtx]) {
      expect(props.get('errors.faults.net').extract(ctx)).toBe(false)
      expect(props.get('errors.faults.short').extract(ctx)).toBe(false)
    }
    // a faults group present for another fault still reads false for these
    const outCtx = { game, rally: game.rallies[2], rallyIdx: 2, shot: game.rallies[2].shots[3], shotIdx: 3 }
    expect(props.get('errors.faults.net').extract(outCtx)).toBe(false)
    expect(props.get('errors.faults.short').extract(outCtx)).toBe(false)
    expect(props.get('errors.faults.out.direction').extract(outCtx)).toBe('long')
    expect(props.get('errors.faults.short').extract(sparseCtx)).toBe(false)
  })

  test('pressure and positioning scores surface where the model emits them', () => {
    const props = REGISTRY.shot.props
    const smashCtx = { ...farShotCtx, shot: game.rallies[0].shots[2], shotIdx: 2 }
    expect(props.get('quality.pressure').extract(smashCtx)).toBe(0.85)
    expect(props.get('positioningScore').extract(smashCtx)).toBe(0.9)
    expect(props.get('partnerPositioningScore').extract(smashCtx)).toBe(0.75)
    // omitted on serves/returns (and sparse shots): unknown
    for (const ctx of [farShotCtx, sparseCtx]) {
      expect(props.get('quality.pressure').extract(ctx)).toBeUndefined()
      expect(props.get('positioningScore').extract(ctx)).toBeUndefined()
      expect(props.get('partnerPositioningScore').extract(ctx)).toBeUndefined()
    }
  })

  test('team positional performance is game-scoped and unknown in singles', () => {
    const props = REGISTRY.player.props
    // teammates share the team value; team 1 is team 0's complement
    expect([0, 1, 2, 3].map(i => props.get('forwardPressure').extract(farShotCtx, i)))
      .toEqual([0.6, 0.6, 0.4, 0.4])
    expect([0, 1, 2, 3].map(i => props.get('finishingAbility').extract(farShotCtx, i)))
      .toEqual([0.4, 0.4, 0.6, 0.6])
    const singles = new Game(makeSinglesGame())
    const sctx = { game: singles, rally: singles.rallies[0], rallyIdx: 0, shot: singles.rallies[0].shots[0], shotIdx: 0 }
    expect(props.get('forwardPressure').extract(sctx, 0)).toBeUndefined()
    expect(props.get('finishingAbility').extract(sctx, 2)).toBeUndefined()
  })

  test('per-game ratings come from trends, and never read as zero', () => {
    const props = REGISTRY.player.props
    // p0 is rated on every area
    expect(props.get('rating.overall').extract(farShotCtx, 0)).toBe(3.75)
    expect(props.get('rating.kitchenGame').extract(farShotCtx, 0)).toBe(3.5)
    expect(props.get('rating.ballControl').extract(farShotCtx, 0)).toBe(3.25)
    expect(props.get('rating.defense').extract(farShotCtx, 0)).toBe(3)
    expect(props.get('rating.offense').extract(farShotCtx, 0)).toBe(4)
    expect(props.get('rating.courtIQ').extract(farShotCtx, 0)).toBe(3.6)
    expect(props.get('rating.targeting').extract(farShotCtx, 0)).toBe(3.9)

    // only the current areas are columns: the ones they replaced are gone
    // rather than reading unknown on every game rated since
    for (const retired of ['serve', 'return', 'agility', 'consistency']) {
      expect(props.get(`rating.${retired}`)).toBeUndefined()
    }

    // An unrated area is UNKNOWN, not 0: charting a missing rating as zero
    // would tell a player their defense collapsed when it was never scored.
    expect(props.get('rating.overall').extract(farShotCtx, 1)).toBe(2.5)
    expect(props.get('rating.defense').extract(farShotCtx, 1)).toBeUndefined()
    expect(props.get('rating.overall').extract(farShotCtx, 2)).toBeUndefined()
    expect(props.get('rating.overall').extract(farShotCtx, 3)).toBeUndefined()

    // a rating is one value per game, so it reads the same on every shot
    const smashCtx = { ...farShotCtx, shot: game.rallies[0].shots[2], shotIdx: 2 }
    expect(props.get('rating.overall').extract(smashCtx, 0)).toBe(3.75)

    // the slots singles does not have are unknown, never a phantom rating
    const singles = new Game(makeSinglesGame())
    const sctx = { game: singles, rally: singles.rallies[0], rallyIdx: 0, shot: singles.rallies[0].shots[0], shotIdx: 0 }
    expect(props.get('rating.overall').extract(sctx, 1)).toBeUndefined()
    expect(props.get('rating.overall').extract(sctx, 3)).toBeUndefined()
  })

  test('rally properties', () => {
    const props = REGISTRY.rally.props
    expect(props.get('num').extract(farShotCtx)).toBe(1)
    expect(props.get('numShots').extract(farShotCtx)).toBe(3)
    expect(props.get('duration').extract(farShotCtx)).toBe(14)
    expect(props.get('winner').extract(farShotCtx)).toBe(0)
    // rally 0: p1 never reached the kitchen; rally 2: everyone did
    expect(props.get('allPlayersReachedKitchen').extract(farShotCtx)).toBe(false)
    const r2 = { ...farShotCtx, rally: game.rallies[2], rallyIdx: 2 }
    expect(props.get('allPlayersReachedKitchen').extract(r2)).toBe(true)
  })

  test('game properties, including outcome interpretation', () => {
    const props = REGISTRY.game.props
    expect(props.get('vid').extract(farShotCtx)).toBe('testvid00001')
    expect(props.get('sessionNum').extract(farShotCtx)).toBe(1)
    expect(props.get('name').extract(farShotCtx)).toBe('Test Game')
    const unnamed = makeDoublesGame()
    unnamed.meta = {}
    expect(props.get('name').extract({ ...farShotCtx, game: new Game(unnamed) }))
      .toBeUndefined()
    expect(props.get('numRallies').extract(farShotCtx)).toBe(3)
    // rally 0 starts at 10000ms, rally 2 ends at 64000ms
    expect(props.get('startTime').extract(farShotCtx)).toBe(10)
    expect(props.get('endTime').extract(farShotCtx)).toBe(64)
    expect(props.get('duration').extract(farShotCtx)).toBe(54)
    expect(props.get('winner').extract(farShotCtx)).toBe(0) // 11 > 9
    const singles = new Game(makeSinglesGame())
    const sctx = { game: singles, rally: singles.rallies[0], rallyIdx: 0, shot: singles.rallies[0].shots[0], shotIdx: 0 }
    expect(props.get('winner').extract(sctx)).toBe(1) // ['lost', 'won']
    for (const outcome of [[7, 7], [null, null], undefined]) {
      const g = makeDoublesGame()
      if (outcome === undefined) {
        delete g.insights.game_data
      } else {
        g.insights.game_data.game_outcome = outcome
      }
      const ctx = { ...farShotCtx, game: new Game(g) }
      expect(props.get('winner').extract(ctx)).toBeUndefined()
    }
  })

  test('game.videoDuration surfaces only from augmented insights', () => {
    const props = REGISTRY.game.props
    expect(props.get('videoDuration').extract(farShotCtx)).toBeUndefined()
    const augmented = makeDoublesGame()
    augmented.insights.session.videoDurationMs = 65500
    expect(props.get('videoDuration')
      .extract({ ...farShotCtx, game: new Game(augmented) })).toBe(65.5)
  })

  test('player properties measure at the current shot', () => {
    const props = REGISTRY.player.props
    // at rally 0 shot 1, p1 stands at (15, 8): near side, x' = 20 − 15 = 5
    expect(props.get('pos.absX').extract(farShotCtx, 1)).toBe(15)
    expect(props.get('pos.x').extract(farShotCtx, 1)).toBe(5)
    expect(props.get('feetToKitchen').extract(farShotCtx, 1)).toBe(7)
    // p2 stands at (15, 40): far side, x' = 15 (kept), y' = 44 − 40 = 4
    expect(props.get('pos.x').extract(farShotCtx, 2)).toBe(15)
    expect(props.get('pos.y').extract(farShotCtx, 2)).toBe(4)
    expect(props.get('feetToKitchen').extract(farShotCtx, 2)).toBe(11)
    expect(props.get('name').extract(farShotCtx, 3)).toBe('Dan')
    expect(props.get('team').extract(farShotCtx, 3)).toBe(1)
    expect(props.get('id').extract(farShotCtx, 3)).toBe(3)
    expect(props.get('startedOnLeftSide').extract(farShotCtx, 0)).toBe(true)
    expect(props.get('reachedKitchen').extract(farShotCtx, 0)).toBe(true)
    expect(props.get('reachedKitchen').extract(farShotCtx, 1)).toBe(false)
    expect(props.get('reachedKitchen').extract(farShotCtx, 2)).toBe(true)
    // no position data on the sparse shot
    expect(props.get('pos.x').extract(sparseCtx, 0)).toBeUndefined()
    expect(props.get('feetToKitchen').extract(sparseCtx, 0)).toBeUndefined()
  })

  test('edge branches: missing rally players, outcome forms, null slots', () => {
    const props = REGISTRY.rally.props
    expect(props.get('allPlayersReachedKitchen')
      .extract({ ...farShotCtx, rally: { shots: [] } })).toBeUndefined()
    for (const [outcome, winner] of [
      [['lost', null], 1], [[null, 'lost'], 0], [[null, 'won'], 1], [[3, 7], 1]
    ]) {
      const g = makeDoublesGame()
      g.insights.game_data.game_outcome = outcome
      expect(REGISTRY.game.props.get('winner')
        .extract({ ...farShotCtx, game: new Game(g) })).toBe(winner)
    }
    const singles = new Game(makeSinglesGame())
    const sctx = { game: singles, rally: singles.rallies[0], rallyIdx: 0, shot: singles.rallies[0].shots[0], shotIdx: 0 }
    expect(REGISTRY.player.props.get('reachedKitchen').extract(sctx, 1)).toBeUndefined()
    expect(REGISTRY.player.props.get('startedOnLeftSide').extract(sctx, 1)).toBeUndefined()
  })

  test('Game accepts serverMetadata versions, missing meta, shotless rallies', () => {
    const insights = makeDoublesGame().insights
    delete insights.version
    insights.serverMetadata = { version: '4.2.0' }
    insights.rallies.push({ start_ms: 70000, end_ms: 71000 }) // no shots array
    const game = new Game({ vid: 'v', sessionIdx: 0, insights })
    expect(game.meta).toEqual({})
    expect(game.shotRefs).toHaveLength(9)
  })

  test('playerMatchesTag: email exact, name glob, unknowns', () => {
    expect(playerMatchesTag(farShotCtx, 0, 'ALICE@example.com')).toBe(true)
    expect(playerMatchesTag(farShotCtx, 0, 'bob@example.com')).toBe(false)
    expect(playerMatchesTag(farShotCtx, 1, 'bob@example.com')).toBeUndefined() // no addr
    expect(playerMatchesTag(farShotCtx, 0, 'ali*')).toBe(true)
    expect(playerMatchesTag(farShotCtx, 0, 'Al*e')).toBe(true)
    expect(playerMatchesTag(farShotCtx, 0, 'Bob')).toBe(false)
    expect(playerMatchesTag(farShotCtx, undefined, 'x')).toBeUndefined()
    // a pattern the analyzer could not type away is unknown, not a crash
    expect(playerMatchesTag(farShotCtx, 0, 5)).toBeUndefined()
    // even with no tags and no player_data, default names still match
    const noTags = new Game({ ...makeDoublesGame(), meta: {} })
    delete noTags.insights.player_data
    const ctx = { ...farShotCtx, game: noTags }
    expect(playerMatchesTag(ctx, 0, 'Alice')).toBe(false)
    expect(playerMatchesTag(ctx, 0, 'Player 1')).toBe(true)
  })

  test('playerMatchesTag: glob edge cases', () => {
    expect(playerMatchesTag(farShotCtx, 0, 'Alice*')).toBe(true) // trailing *
    expect(playerMatchesTag(farShotCtx, 0, 'A**l*e')).toBe(true) // ** acts as *
    expect(playerMatchesTag(farShotCtx, 0, '*')).toBe(true)
    expect(playerMatchesTag(farShotCtx, 0, 'Ali')).toBe(false) // prefix only
    expect(playerMatchesTag(farShotCtx, 0, 'Alicee')).toBe(false)
    expect(playerMatchesTag(farShotCtx, 0, 'a*b')).toBe(false)
  })

  test('pathological wildcard patterns cannot blow up the matcher', () => {
    // 20 stars against a 60-char near-match: a backtracking regex takes
    // minutes on this input; the two-pointer scan must stay instant
    const meta = { players: [{ name: 'a'.repeat(59) + 'b' }] }
    const ctx = { game: new Game({ ...makeDoublesGame(), meta }) }
    const pattern = '*a'.repeat(20)
    const startMs = Date.now()
    expect(playerMatchesTag(ctx, 0, pattern)).toBe(false)
    expect(Date.now() - startMs).toBeLessThan(50)
  })

  test('shot methods: inHighlight matches kind + rally + time window', () => {
    const inHighlight = REGISTRY.shot.methods.get('inHighlight')
    const smashCtx = { ...farShotCtx, shot: game.rallies[0].shots[2], shotIdx: 2 }
    expect(inHighlight.apply(smashCtx, undefined, ['atp'])).toBe(true)
    expect(inHighlight.apply(smashCtx, undefined, ['erne'])).toBe(false)
    expect(inHighlight.apply(farShotCtx, undefined, ['atp'])).toBe(false) // outside s..e
    expect(inHighlight.apply(sparseCtx, undefined, ['atp'])).toBe(false)
    const bare = makeDoublesGame()
    delete bare.insights.highlights
    const ctx = { ...smashCtx, game: new Game(bare) }
    expect(inHighlight.apply(ctx, undefined, ['atp'])).toBeUndefined()
  })
})

describe('default player names', () => {
  test('playerName falls back to "Player N" only for existing players', () => {
    const bare = makeDoublesGame()
    bare.meta = {}
    delete bare.insights.player_data
    const bareGame = new Game(bare)
    expect(bareGame.playerName(0)).toBe('Player 1')
    expect(bareGame.playerExists(3)).toBe(true)
    // a short player_data array means the missing slots don't exist
    const short = makeDoublesGame()
    short.insights.player_data = short.insights.player_data.slice(0, 2)
    expect(new Game(short).playerExists(3)).toBe(false)
    const singlesData = makeSinglesGame()
    delete singlesData.insights.player_data
    singlesData.meta = {}
    const singles = new Game(singlesData)
    expect(singles.playerName(0)).toBe('Player 1')
    expect(singles.playerName(1)).toBeUndefined() // empty slot
    expect(singles.playerName(2)).toBe('Player 3')
    // with player_data present, null slots are authoritative
    expect(new Game(makeSinglesGame()).playerName(3)).toBeUndefined()
  })
})
