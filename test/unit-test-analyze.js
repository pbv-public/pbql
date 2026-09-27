import { analyze, enumValuesOf } from '../src/analyze/analyze.js'
import { parse, validate } from '../src/index.js'
import { REGISTRY } from '../src/model/registry.js'

function analyzeQuery (text) {
  const { ast, errors } = parse(text)
  expect(errors).toBeUndefined()
  return analyze(ast).errors
}

function analyzeWhere (expr) {
  return analyzeQuery(`FROM "f" WHERE ${expr}`)
}

describe('analyze()', () => {
  test('accepts every corpus-style construct', () => {
    expect(analyzeWhere(
      'shot.isVolley AND shot.hitter = me AND shot.quality.overall >= 0.5 AND ' +
      'shot.taggedWith("A*") AND exists(shot.winnerType) AND ' +
      'min(shot.from.x, shot.to.x) < 10 AND NOT rally.winner = me.team'))
      .toEqual([])
  })

  test('validates player navigation: relations, identity, scalar tails', () => {
    // multi-hop relations, then a scalar; identity comparisons; me root
    expect(analyzeWhere(
      'shot.hitter.opponentLHS.feetToKitchen <= 2 AND ' +
      'me.teammate.name = "Anna" AND shot[1].hitter = me AND ' +
      'shot.hitter != shot[-1].hitter AND me.opponentRHS.taggedWith("Ben*")'))
      .toEqual([])
    // an unknown relation/prop after a valid player transition is caught,
    // reported against the terminal type (player)
    const [bad] = analyzeWhere('shot.hitter.feetToKichen > 1')
    expect(bad.message).toBe('player has no property "feetToKichen"')
    expect(bad.hint).toBe('did you mean "feetToKitchen"?')
    // a relation used on the wrong type is just an unknown property there
    expect(analyzeWhere('shot.teammate = me')[0].code).toBe('PBQL_UNKNOWN_PROPERTY')
  })

  test('unknown property gets a nearest-match hint with its position', () => {
    const [error] = analyzeWhere('shot.isVoley')
    expect(error).toEqual({
      code: 'PBQL_UNKNOWN_PROPERTY',
      message: 'shot has no property "isVoley"',
      line: 1,
      col: 16,
      length: 0,
      hint: 'did you mean "isVolley"?'
    })
  })

  test('unknown player property names the player type after navigation', () => {
    const [error] = analyzeWhere('me.teammate.feetToKichen > 1')
    expect(error.message).toBe('player has no property "feetToKichen"')
    expect(error.hint).toBe('did you mean "feetToKitchen"?')
  })

  test('a wildly wrong name gets no hint', () => {
    const [error] = analyzeWhere('shot.zzzzzzzzzzzzzzzz = 1')
    expect(error.hint).toBeUndefined()
  })

  test('unknown methods and bad arity are flagged', () => {
    expect(analyzeWhere('shot.taggedAs("x")')[0]).toMatchObject({
      code: 'PBQL_UNKNOWN_METHOD',
      hint: 'did you mean "taggedWith"?'
    })
    expect(analyzeWhere('shot.taggedWith("x", "y")')[0].code).toBe('PBQL_BAD_ARITY')
    // rally.count: a condition argument, validated recursively, one level
    expect(analyzeWhere('rally.count(shot.hitter = me) >= 3')).toEqual([])
    expect(analyzeWhere('rally.count() = 1')[0].code).toBe('PBQL_BAD_ARITY')
    expect(analyzeWhere('rally.count(shot.nope) = 1')[0].code)
      .toBe('PBQL_UNKNOWN_PROPERTY')
    expect(analyzeWhere(
      'rally.count(rally.count(shot.num = 1) = 1) > 0')[0].code)
      .toBe('PBQL_NESTED_COUNT')
    expect(analyzeWhere(
      'rally.count(NOT (rally.count(shot.num = 1) = 1)) > 0')[0].code)
      .toBe('PBQL_NESTED_COUNT')
    // its result is a NUMBER: comparing to a string is a type error
    expect(analyzeWhere('rally.count(shot.num = 1) = "three"')[0].code)
      .toBe('PBQL_TYPE_MISMATCH')
    // an unresolvable method stays untyped, so only the unknown-method
    // error fires (no bogus type error stacked on top)
    expect(analyzeWhere('shot.quality.taggedWith("x") = 1').map(e => e.code))
      .toEqual(['PBQL_UNKNOWN_METHOD'])
    expect(analyzeWhere('shot.quality.taggedWith("x")')[0].code)
      .toBe('PBQL_UNKNOWN_METHOD')
  })

  test('method arguments are checked against their declared type', () => {
    expect(analyzeWhere('shot.taggedWith(5)')[0]).toEqual({
      code: 'PBQL_TYPE_MISMATCH',
      message: 'taggedWith() takes a string pattern, not number',
      line: 1,
      col: 16,
      length: 0
    })
    expect(analyzeWhere('me.taggedWith(true)')[0].code).toBe('PBQL_TYPE_MISMATCH')
    expect(analyzeWhere('shot.isHitOnSide(1 + 2)')[0].message)
      .toBe('isHitOnSide() takes a string side, not number')
    // typed property arguments are checked too; untyped expressions pass
    expect(analyzeWhere('shot.taggedWith(shot.speed)')[0].code)
      .toBe('PBQL_TYPE_MISMATCH')
    expect(analyzeWhere('shot.taggedWith(shot.type)')).toEqual([])
    expect(analyzeWhere('shot.taggedWith(min(1, 2))')).toEqual([])
    // the enum check still fires for well-typed strings
    expect(analyzeWhere('shot.isHitOnSide("up")')[0].code)
      .toBe('PBQL_UNKNOWN_ENUM_VALUE')
  })

  test('a relation called like a method is an error, not a crash', () => {
    expect(analyzeWhere('shot.hitter("a")')[0]).toEqual({
      code: 'PBQL_UNKNOWN_METHOD',
      message: 'shot.hitter is a player, not a method',
      line: 1,
      col: 16,
      length: 0,
      hint: 'call a player method on it (e.g. shot.hitter.taggedWith("Alex")) ' +
        'or compare it (e.g. shot.hitter = me)'
    })
    // every relation root: the `me` root, a multi-hop path, no arguments at all
    expect(analyzeWhere('me.teammate(1)')[0].message)
      .toBe('me.teammate is a player, not a method')
    expect(analyzeWhere('shot[1].hitter.opponentLHS(1)')[0].message)
      .toBe('shot[1].hitter.opponentLHS is a player, not a method')
    expect(analyzeWhere('shot.hitter()')[0].code).toBe('PBQL_UNKNOWN_METHOD')
    // the arguments are still checked (they are ordinary expressions)
    expect(analyzeWhere('shot.hitter(shot.isVoley)').map(e => e.code))
      .toEqual(['PBQL_UNKNOWN_PROPERTY', 'PBQL_UNKNOWN_METHOD'])
  })

  test('SELECT * stands alone: no GROUP BY, no CONTEXT', () => {
    const analyzeText = text => analyze(parse(text).ast).errors
    expect(analyzeText('SELECT * FROM "x" WHERE shot.num = 1')).toEqual([])
    expect(analyzeText(
      'SELECT * FROM "x" WHERE shot.num = 1 GROUP BY shot.type')[0].code)
      .toBe('PBQL_STAR_GROUPED')
    expect(analyzeText(
      'SELECT * FROM "x" WHERE shot.num = 1 CONTEXT BEFORE rally')[0].code)
      .toBe('PBQL_SELECT_CONTEXT')
  })

  test('HAVING needs GROUP BY and groups its references', () => {
    const analyzeText = text => analyze(parse(text).ast).errors
    expect(analyzeText('SELECT rally.num, count() FROM "x" ' +
      'WHERE shot.num >= 1 GROUP BY rally.num HAVING count() >= 3'))
      .toEqual([])
    expect(analyzeText('SELECT count() FROM "x" WHERE shot.num >= 1 ' +
      'HAVING count() >= 3')[0].code).toBe('PBQL_HAVING_NO_GROUP_BY')
    // a bare per-shot property has no single value within a group
    expect(analyzeText('SELECT rally.num FROM "x" WHERE shot.num >= 1 ' +
      'GROUP BY rally.num HAVING shot.speed > 3')[0].code)
      .toBe('PBQL_NOT_GROUPED')
    // an aggregate may be scaled inside the condition
    expect(analyzeText('SELECT rally.num, avg(shot.speed) FROM "x" ' +
      'WHERE shot.num >= 1 GROUP BY rally.num ' +
      'HAVING avg(shot.speed) * 1.609 > 50')).toEqual([])
  })

  test('bare non-player objects are not values; players are (identity)', () => {
    const [bare] = analyzeWhere('shot = 1')
    expect(bare.code).toBe('PBQL_MISSING_PROPERTY')
    expect(bare.hint).toBeUndefined() // the .num hint is exists()-specific
    expect(analyzeWhere('rally = 1')[0].message)
      .toBe('select a property of rally (e.g. rally.num)')
    expect(analyzeWhere('shot.hitter = me')).toEqual([])
    expect(analyzeWhere('me = shot.hitter')).toEqual([])
  })

  test('a player compares only with another player', () => {
    // a player id is not the player: shot.hitter = 3 matched only by luck
    expect(analyzeWhere('shot.hitter = 3')[0]).toEqual({
      code: 'PBQL_TYPE_MISMATCH',
      message: 'cannot compare player with number',
      line: 1,
      col: 28,
      length: 0,
      hint: 'a player compares only with another player (e.g. shot.hitter = ' +
        'me); to compare a value, read one of its properties (e.g. ' +
        'shot.hitter.id, shot.hitter.name, shot.hitter.team)'
    })
    // either side, every literal type, IN lists; the hint names the player
    expect(analyzeWhere('"Anna" = me.teammate')[0]).toMatchObject({
      message: 'cannot compare string with player',
      hint: expect.stringContaining('me.teammate.name')
    })
    expect(analyzeWhere('me != true')[0].message)
      .toBe('cannot compare player with boolean')
    expect(analyzeWhere('shot[1].hitter IN (2, 3)')[0]).toMatchObject({
      code: 'PBQL_TYPE_MISMATCH',
      message: 'IN list mixes number with player',
      hint: expect.stringContaining('shot[1].hitter.id')
    })
    // players have no order, and are not a string argument
    expect(analyzeWhere('shot.hitter < me')[0].message)
      .toBe('"<" needs numbers, not player')
    expect(analyzeWhere('shot.taggedWith(me)')[0].message)
      .toBe('taggedWith() takes a string pattern, not player')
    // a mismatch without a player carries no hint
    expect(analyzeWhere('shot.num IN (1, "x")')[0].hint).toBeUndefined()
    // reading a property off the player is the way to compare a value
    expect(analyzeWhere('shot.hitter.id = 3 AND me.name = "Anna" AND ' +
      'shot.hitter.team IN (0, 1) AND shot.hitter = me.teammate')).toEqual([])
  })

  test('exists() on a bare shot/rally reference hints at .num', () => {
    const [error] = analyzeWhere('exists(shot[1])')
    expect(error).toMatchObject({
      code: 'PBQL_MISSING_PROPERTY',
      message: 'select a property of shot (e.g. shot.num)',
      hint: 'to test whether shot[1] exists, use exists(shot[1].num) ' +
        '(num is always present when the reference is in range)'
    })
    expect(analyzeWhere('exists(rally[-1])')[0].hint)
      .toBe('to test whether rally[-1] exists, use exists(rally[-1].num) ' +
        '(num is always present when the reference is in range)')
    // game has no num property, so the hint is withheld there
    expect(analyzeWhere('exists(game)')[0].hint).toBeUndefined()
    // a player is a value, so exists(me) needs no hint (and no error)
    expect(analyzeWhere('exists(me)')).toEqual([])
  })

  test('unknown and misused functions', () => {
    expect(analyzeWhere('foo(1) = 1')[0]).toMatchObject({
      code: 'PBQL_UNKNOWN_FUNCTION',
      message: 'unknown function "foo"'
    })
    expect(analyzeWhere('min(1) = 1')[0].code).toBe('PBQL_BAD_ARITY')
    expect(analyzeWhere('abs(1, 2) = 1')[0].code).toBe('PBQL_BAD_ARITY')
    expect(analyzeWhere('timecode() = "0:00"')[0].code).toBe('PBQL_BAD_ARITY')
    expect(analyzeWhere('timecode(1, true, 2) = "x"')[0].code)
      .toBe('PBQL_BAD_ARITY')
    // aggregates don't exist in WHERE...
    expect(analyzeWhere('count() = 1')[0].code).toBe('PBQL_UNKNOWN_FUNCTION')
    // ...but do in SELECT, where min() is also a 1-arg aggregate
    expect(analyzeQuery('SELECT count(), min(shot.speed) FROM "f" WHERE true'))
      .toEqual([])
  })

  test('type mismatches in comparisons, ordering, and IN lists', () => {
    expect(analyzeWhere('shot.speed = "fast"')[0]).toMatchObject({
      code: 'PBQL_TYPE_MISMATCH',
      message: 'cannot compare number with string'
    })
    expect(analyzeWhere('shot.type < "dink"')[0].message)
      .toBe('"<" needs numbers, not string')
    expect(analyzeWhere('shot.num IN (1, "x")')[0].message)
      .toBe('IN list mixes string with number')
    // unknown-typed sides are let through (runtime handles them)
    expect(analyzeWhere('shot.speed > min(1, 2)')).toEqual([])
    // ...including parenthesized boolean operands, which have no type
    expect(analyzeWhere('(shot.isVolley AND shot.isFinal) = true')).toEqual([])
  })

  test('timecode: both arities, string result, boolean withFrames', () => {
    expect(analyzeWhere('timecode(shot.hitTime) = "0:18"')).toEqual([])
    expect(analyzeWhere('timecode(shot.hitTime, true) != "0:18:00"')).toEqual([])
    // the result is a string: equality is fine, ordering is not
    expect(analyzeWhere('timecode(shot.hitTime) < "0:30"')[0]).toMatchObject({
      code: 'PBQL_TYPE_MISMATCH',
      message: '"<" needs numbers, not string'
    })
    expect(analyzeWhere('timecode(shot.hitTime) = 5')[0].message)
      .toBe('cannot compare string with number')
    // withFrames must be a boolean when its type is known statically...
    expect(analyzeWhere('timecode(1, 30) = "x"')[0]).toMatchObject({
      code: 'PBQL_TYPE_MISMATCH',
      message: 'timecode() takes a boolean second argument, not number'
    })
    expect(analyzeWhere('timecode(1, shot.isVolley) = "0:01"')).toEqual([])
    // ...while unknown-typed flags pass and resolve per Kleene at runtime
    expect(analyzeWhere('timecode(1, exists(shot.speed)) = "0:01"')).toEqual([])
  })

  test('date: one arity, string result', () => {
    expect(analyzeWhere('date(game.epoch) = "2025-01-01"')).toEqual([])
    expect(analyzeWhere('date() = "x"')[0].code).toBe('PBQL_BAD_ARITY')
    expect(analyzeWhere('date(1, 2) = "x"')[0].code).toBe('PBQL_BAD_ARITY')
    // string result: equality is fine, ordering is not (order games by
    // game.epoch itself instead)
    expect(analyzeWhere('date(game.epoch) < "2025-01-01"')[0]).toMatchObject({
      code: 'PBQL_TYPE_MISMATCH',
      message: '"<" needs numbers, not string'
    })
    expect(analyzeWhere('date(game.epoch) = 5')[0].message)
      .toBe('cannot compare string with number')
  })

  test('enum properties reject values production never emits', () => {
    expect(analyzeWhere('shot.type = "smsh"')[0]).toMatchObject({
      code: 'PBQL_UNKNOWN_ENUM_VALUE',
      message: 'shot.type is never "smsh" (valid: "smash", "lob", "dink", ' +
        '"drop", "drive", "atp", "erne")',
      hint: 'did you mean "smash"?'
    })
    // both operand orders, both equality operators
    expect(analyzeWhere('"drivee" = shot[1].type')[0]).toMatchObject({
      code: 'PBQL_UNKNOWN_ENUM_VALUE',
      message: expect.stringContaining('shot[1].type is never "drivee"'),
      hint: 'did you mean "drive"?'
    })
    expect(analyzeWhere('shot.winnerType != "winner"')[0]).toMatchObject({
      code: 'PBQL_UNKNOWN_ENUM_VALUE',
      message: 'shot.winnerType is never "winner" (valid: "clean", "forced_fault")'
    })
    // IN lists: one report for the first invalid element
    const inErrors = analyzeWhere('shot.type IN ("smash", "speedup", "volley")')
    expect(inErrors).toHaveLength(1)
    expect(inErrors[0]).toMatchObject({
      code: 'PBQL_UNKNOWN_ENUM_VALUE',
      message: expect.stringContaining('shot.type is never "speedup"')
    })
    expect(analyzeWhere('shot.type IN ("smash", "drive")')).toEqual([])
  })

  test('team properties reject numbers that are not a team', () => {
    // a player's id (0-3) is not a team: this counted zero wins in a real chat
    expect(analyzeQuery('SELECT sum(rally.winner = 3) FROM "f" WHERE true')[0])
      .toEqual({
        code: 'PBQL_UNKNOWN_ENUM_VALUE',
        message: 'rally.winner is never 3 (valid: 0, 1)',
        line: 1,
        col: 25,
        length: 0
      })
    expect(analyzeWhere('game.winner != 2')[0].message)
      .toBe('game.winner is never 2 (valid: 0, 1)')
    expect(analyzeWhere('shot.hitter.team IN (0, 2)')[0].message)
      .toBe('shot.hitter.team is never 2 (valid: 0, 1)')
    expect(analyzeWhere('rally.winner = 1 AND 0 = me.team')).toEqual([])
    expect(analyzeWhere('rally.winner = me.team')).toEqual([])
    // a string is the type check's business, not the enum's
    expect(analyzeWhere('rally.winner = "us"').map(e => e.code))
      .toEqual(['PBQL_TYPE_MISMATCH'])
  })

  test('every declared enum value passes for every enum property', () => {
    const roots = { shot: 'shot', rally: 'rally', game: 'game', player: 'me' }
    let checked = 0
    for (const [objName, { propList }] of Object.entries(REGISTRY)) {
      for (const { path, unit } of propList) {
        for (const value of enumValuesOf(unit) ?? []) {
          expect(analyzeWhere(`${roots[objName]}.${path} = ${JSON.stringify(value)}`))
            .toEqual([])
          checked++
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(30) // the surface stays enum-rich
  })

  test('enum-typed method arguments are validated the same way', () => {
    for (const kind of ['atp', 'erne', 'hands_battle', 'long_rally', 'poach', 'sequence']) {
      expect(analyzeWhere(`shot.inHighlight("${kind}")`)).toEqual([])
    }
    expect(analyzeWhere('shot.isHitOnSide("left")')).toEqual([])
    expect(analyzeWhere('shot.isHitOnSide("right")')).toEqual([])
    expect(analyzeWhere('shot.inHighlight("ernie")')[0]).toMatchObject({
      code: 'PBQL_UNKNOWN_ENUM_VALUE',
      message: 'inHighlight() kind is never "ernie" (valid: "atp", "erne", ' +
        '"hands_battle", "long_rally", "poach", "sequence")',
      hint: 'did you mean "erne"?'
    })
    expect(analyzeWhere('shot.isHitOnSide("up")')[0]).toMatchObject({
      code: 'PBQL_UNKNOWN_ENUM_VALUE',
      message: 'isHitOnSide() side is never "up" (valid: "left", "right")'
    })
  })

  test('enum enforcement leaves non-literal comparisons and arguments alone', () => {
    expect(analyzeWhere('shot.type = shot[1].type')).toEqual([])
    expect(analyzeWhere('shot.from.zone = shot.to.zone')).toEqual([])
    expect(analyzeWhere('shot.inHighlight(shot.winnerType)')).toEqual([])
    // non-string literals stay the type checker's business
    expect(analyzeWhere('shot.type = 5')).toEqual([
      expect.objectContaining({ code: 'PBQL_TYPE_MISMATCH' })])
    // a non-string argument is the type check's business, not the enum's
    expect(analyzeWhere('shot.taggedWith(5)').map(e => e.code))
      .toEqual(['PBQL_TYPE_MISMATCH'])
  })

  test('GROUP BY: keys and aggregates in SELECT and ORDER BY are valid', () => {
    expect(analyzeQuery(
      'SELECT shot.type, avg(rally.winner = me.team) AS "win rate" FROM "f" ' +
      'WHERE shot.hitter = me GROUP BY shot.type')).toEqual([])
    // ORDER BY may use aggregates (even ones not in SELECT) and keys
    expect(analyzeQuery(
      'SELECT shot.type, shot.hitter.team, count() FROM "f" WHERE true ' +
      'GROUP BY shot.type, shot.hitter.team ' +
      'ORDER BY avg(shot.speed) DESC, shot.type')).toEqual([])
  })

  test('aggregates combine with operators wherever they are allowed', () => {
    // the motivating case: a rate charted as a percentage
    expect(analyzeQuery(
      'SELECT shot.type, avg(rally.winner = me.team) * 100 AS "win %" ' +
      'FROM "f" WHERE shot.hitter = me GROUP BY shot.type')).toEqual([])
    // ungrouped: one aggregate scaled, and two combined
    expect(analyzeQuery('SELECT count() / 2 FROM "f" WHERE true')).toEqual([])
    expect(analyzeQuery('SELECT max(shot.speed) - min(shot.speed) AS "spread" ' +
      'FROM "f" WHERE true')).toEqual([])
    // grouped ORDER BY, and a scalar function wrapping an aggregate
    expect(analyzeQuery('SELECT shot.type FROM "f" WHERE true ' +
      'GROUP BY shot.type ORDER BY avg(shot.quality.overall) * 100 DESC'))
      .toEqual([])
    expect(analyzeQuery('SELECT kph(avg(shot.speed)) FROM "f" WHERE true'))
      .toEqual([])
    // constants ride along with an aggregate; a per-shot column does not
    expect(analyzeQuery('SELECT count(), 100 FROM "f" WHERE true')).toEqual([])
    expect(analyzeQuery('SELECT count() * 2, shot.type FROM "f" WHERE true')[0])
      .toMatchObject({
        code: 'PBQL_MIXED_AGGREGATES',
        message: 'SELECT cannot mix aggregate and per-shot expressions ' +
          '(unless the per-shot expressions are GROUP BY keys)',
        col: 21 // reported at the ungrouped reference itself
      })
    // ...including within one expression, where nothing pairs them up
    expect(analyzeQuery('SELECT count() * shot.speed FROM "f" WHERE true')[0].code)
      .toBe('PBQL_MIXED_AGGREGATES')
    expect(analyzeQuery('SELECT count() * rally.count(shot.isVolley) ' +
      'FROM "f" WHERE true')[0].code).toBe('PBQL_MIXED_AGGREGATES')
  })

  test('aggregates stay illegal where they have no set of shots', () => {
    // WHERE, GROUP BY keys and an ungrouped ORDER BY reject them, and
    // arithmetic around one changes nothing
    expect(analyzeWhere('avg(shot.speed) * 100 > 20')[0].code)
      .toBe('PBQL_UNKNOWN_FUNCTION')
    expect(analyzeQuery('SELECT count() FROM "f" WHERE true ' +
      'GROUP BY count() * 2')[0].code).toBe('PBQL_UNKNOWN_FUNCTION')
    expect(analyzeQuery('FROM "f" WHERE true ORDER BY count() * 2')[0].code)
      .toBe('PBQL_UNKNOWN_FUNCTION')
  })

  test('aggregates never nest', () => {
    // one clear error, not a confusing "unknown function"
    expect(analyzeQuery('SELECT avg(count()) FROM "f" WHERE true')).toEqual([
      expect.objectContaining({
        code: 'PBQL_NESTED_AGGREGATE',
        message: 'count() cannot appear inside another aggregate'
      })
    ])
    expect(analyzeQuery('SELECT sum(avg(shot.speed) * 2) FROM "f" WHERE true')[0]
      .code).toBe('PBQL_NESTED_AGGREGATE')
    // 1-ary min() is the aggregate; the 2-ary scalar min() is fine there
    expect(analyzeQuery('SELECT avg(min(shot.speed)) FROM "f" WHERE true')[0]
      .message).toBe('min() cannot appear inside another aggregate')
    expect(analyzeQuery('SELECT avg(min(shot.speed, 40)) FROM "f" WHERE true'))
      .toEqual([])
    // an unknown function inside an aggregate is still just unknown
    expect(analyzeQuery('SELECT avg(nope(shot.speed)) FROM "f" WHERE true')[0]
      .code).toBe('PBQL_UNKNOWN_FUNCTION')
  })

  test('GROUP BY: non-key, non-aggregate expressions are PBQL_NOT_GROUPED', () => {
    const [select] = analyzeQuery(
      'SELECT shot.speed FROM "f" WHERE true GROUP BY shot.type')
    expect(select).toMatchObject({
      code: 'PBQL_NOT_GROUPED',
      message: '"shot.speed" must be an aggregate or a GROUP BY key'
    })
    // key matching is structural: shot[1].type is not the key shot.type
    expect(analyzeQuery(
      'SELECT shot[1].type FROM "f" WHERE true GROUP BY shot.type')[0].code)
      .toBe('PBQL_NOT_GROUPED')
    // 2-ary min() is the scalar function, not the aggregate, so its
    // ungrouped argument is what has no per-group value
    expect(analyzeQuery(
      'SELECT count() FROM "f" WHERE true GROUP BY shot.type ' +
      'ORDER BY min(shot.speed, 1)')[0]).toMatchObject({
      code: 'PBQL_NOT_GROUPED',
      message: '"shot.speed" must be an aggregate or a GROUP BY key'
    })
    // an aggregate combined with a per-shot property is caught inside the
    // expression too
    expect(analyzeQuery(
      'SELECT count() * shot.speed FROM "f" WHERE true GROUP BY shot.type')[0])
      .toMatchObject({
        code: 'PBQL_NOT_GROUPED',
        message: '"shot.speed" must be an aggregate or a GROUP BY key'
      })
  })

  test('GROUP BY needs a SELECT and cannot carry CONTEXT', () => {
    expect(analyzeQuery('FROM "f" WHERE true GROUP BY shot.type')[0])
      .toMatchObject({ code: 'PBQL_GROUP_BY_NO_SELECT', line: 1, col: 30 })
    expect(analyzeQuery('SELECT count() FROM "f" WHERE true GROUP BY shot.type ' +
      'CONTEXT BEFORE 1 shot')[0].code).toBe('PBQL_GROUP_BY_CONTEXT')
    expect(analyzeQuery('SELECT count() FROM "f" WHERE true GROUP BY shot.type ' +
      'CONTEXT AFTER 2secs')[0].code).toBe('PBQL_GROUP_BY_CONTEXT')
  })

  test('a plain SELECT cannot carry CONTEXT either', () => {
    // a projection returns rows, not clips, so CONTEXT is meaningless on it
    expect(analyzeQuery('SELECT shot.speed FROM "f" WHERE true CONTEXT BEFORE 1 shot')[0])
      .toMatchObject({
        code: 'PBQL_SELECT_CONTEXT',
        message: 'CONTEXT applies to shot clips, not SELECT results'
      })
    // the AFTER side is guarded the same way
    expect(analyzeQuery('SELECT shot.speed FROM "f" WHERE true CONTEXT AFTER 2secs')[0].code)
      .toBe('PBQL_SELECT_CONTEXT')
    // a SELECT at the zero-context default is fine, and shot-lists still take
    // CONTEXT freely
    expect(analyzeQuery('SELECT shot.speed FROM "f" WHERE true')).toEqual([])
    expect(analyzeQuery('FROM "f" WHERE true CONTEXT BEFORE 1 shot')).toEqual([])
  })

  test('GROUP BY keys are checked and cannot hold aggregates', () => {
    expect(analyzeQuery('SELECT count() FROM "f" WHERE true GROUP BY shot.tpye')[0])
      .toMatchObject({ code: 'PBQL_UNKNOWN_PROPERTY', hint: 'did you mean "type"?' })
    expect(analyzeQuery('SELECT count() FROM "f" WHERE true GROUP BY count()')[0].code)
      .toBe('PBQL_UNKNOWN_FUNCTION')
  })

  test('ORDER BY aggregates stay invalid without GROUP BY', () => {
    expect(analyzeQuery('FROM "f" WHERE true ORDER BY count()')[0].code)
      .toBe('PBQL_UNKNOWN_FUNCTION')
  })

  test('handmade nodes without positions default to 1:1', () => {
    const { errors } = analyze({
      select: null,
      sources: [],
      where: { kind: 'prop', base: { object: 'shot', offset: 0 }, path: ['nope'] },
      orderBy: null,
      limit: null
    })
    expect(errors[0]).toMatchObject({ line: 1, col: 1 })
  })

  test('unknown functions in SELECT suggest aggregates too', () => {
    const [error] = analyzeQuery('SELECT coont() FROM "f" WHERE true')
    expect(error.code).toBe('PBQL_UNKNOWN_FUNCTION')
    expect(error.hint).toBe('did you mean "count"?')
  })

  test('checks SELECT and ORDER BY expressions too', () => {
    expect(analyzeQuery('SELECT shot.spd FROM "f" WHERE true')[0].hint)
      .toBe('did you mean "speed"?')
    expect(analyzeQuery('FROM "f" WHERE true ORDER BY shot.spd')[0].code)
      .toBe('PBQL_UNKNOWN_PROPERTY')
  })
})

describe('methods have exactly one spelling', () => {
  test('a method written function-style is an unknown function', () => {
    // the bare `shot` argument is also flagged (objects are not values)
    expect(analyzeWhere('taggedWith(shot, "BJ*")').map(e => e.code))
      .toContain('PBQL_UNKNOWN_FUNCTION')
    expect(analyzeWhere('taggedWith(me.teammate, "A*")')[0].code)
      .toBe('PBQL_UNKNOWN_FUNCTION')
  })
})

describe('UNION', () => {
  // 0.12.0 taught the grammar and the engine UNION but not the analyzer,
  // and validate() handed it the union node whole: every UNION query a
  // client wrote threw out of its PBQL tool.
  test('analyzes each branch as a whole query', () => {
    expect(analyzeQuery(
      'FROM "f" WHERE shot.isVolley UNION FROM "g" WHERE shot.num = 2'))
      .toEqual([])
    expect(analyzeQuery(
      'SELECT count() FROM "f" WHERE shot.isVolley UNION ALL ' +
      'SELECT count() FROM "g" WHERE shot.num = 2')).toEqual([])
  })

  test('reports a branch error where it sits in the whole text', () => {
    const errors = analyzeQuery(
      'FROM "f" WHERE shot.isVolley\nUNION\nFROM "g" WHERE shot.isVoley')
    expect(errors).toHaveLength(1)
    expect(errors[0].code).toBe('PBQL_UNKNOWN_PROPERTY')
    expect(errors[0].line).toBe(3)
  })

  test('validate() takes a UNION without throwing', () => {
    const { errors, ast } = validate(
      'FROM "f" WHERE shot.isVolley UNION FROM "g" WHERE shot.num = 2')
    expect(errors).toEqual([])
    expect(ast.kind).toBe('union')
  })
})
