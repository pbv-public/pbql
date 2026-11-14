import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse } from '../src/index.js'

import { stripLoc } from './helpers.js'

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

function read (...parts) {
  return fs.readFileSync(path.join(repoRoot, ...parts), 'utf8')
}

// parses a WHERE-clause expression via a tiny query wrapper
function parseWhere (expr) {
  const { ast, errors } = parse(`FROM "f" WHERE ${expr}`)
  expect(errors).toBeUndefined()
  return stripLoc(ast.where)
}

const ZERO = { kind: 'dur', unit: 'secs', value: 0 }
const ONE_SHOT = { kind: 'dur', unit: 'shots', value: 1 }

describe('parse()', () => {
  test('parses the kitchen-sink demo query to exactly the golden AST', () => {
    const { ast, errors } = parse(read('test', 'demo.pbql'))
    expect(errors).toBeUndefined()
    const golden = JSON.parse(read('test', 'corpus', 'demo-ast.json'))
    expect(ast).toEqual(golden)
  })

  test('parses a minimal query and applies defaults', () => {
    const { ast, errors } = parse('FROM "f" WHERE true')
    expect(errors).toBeUndefined()
    expect(ast.select).toBeNull()
    expect(ast.sources).toEqual(['f'])
    expect(stripLoc(ast.where)).toEqual({ kind: 'lit', value: true })
    expect(ast.groupBy).toBeNull()
    // a bare shot-list frames each clip with a one-shot lead-in and lead-out
    expect(ast.context).toEqual({ before: ONE_SHOT, after: ONE_SHOT })
    expect(ast.orderBy).toBeNull()
    expect(ast.limit).toBeNull()
  })

  test('context defaults per query shape and written side', () => {
    // writing one CONTEXT clause opts out of the ±1 default: the side left
    // unwritten becomes zero, not one shot
    const before = parse('FROM "f" WHERE true CONTEXT BEFORE 2secs').ast.context
    expect(before).toEqual({ before: { kind: 'dur', unit: 'secs', value: 2 }, after: ZERO })
    const after = parse('FROM "f" WHERE true CONTEXT AFTER 1 shot').ast.context
    expect(after).toEqual({ before: ZERO, after: ONE_SHOT })
    // projections return rows, not clips, so their context is the zero default
    expect(parse('SELECT count() FROM "f" WHERE true').ast.context)
      .toEqual({ before: ZERO, after: ZERO })
    expect(parse('SELECT count() FROM "f" WHERE true GROUP BY shot.type').ast.context)
      .toEqual({ before: ZERO, after: ZERO })
  })

  test('GROUP BY takes a comma list of key expressions', () => {
    const { ast, errors } = parse(
      'SELECT count() FROM "f" WHERE true GROUP BY shot.type, shot.hitter.team')
    expect(errors).toBeUndefined()
    expect(stripLoc(ast.groupBy)).toEqual([
      { kind: 'prop', base: { object: 'shot', offset: 0 }, path: ['type'] },
      { kind: 'prop', base: { object: 'shot', offset: 0 }, path: ['hitter', 'team'] }
    ])
  })

  test('GROUP BY is case-insensitive with any whitespace between the words', () => {
    const { ast, errors } = parse('SELECT count() FROM "f" WHERE true group \n By shot.type')
    expect(errors).toBeUndefined()
    expect(ast.groupBy).toHaveLength(1)
  })

  test('FROM takes a comma list of opaque quoted strings', () => {
    const { ast } = parse(
      'FROM "abc123def456", "abc123def456:2", "games/*.json" WHERE true')
    expect(ast.sources).toEqual(
      ['abc123def456', 'abc123def456:2', 'games/*.json'])
    // unquoted sources (the old video()/folder() forms) no longer parse
    expect(parse('FROM video("abc123def456") WHERE true').errors[0])
      .toMatchObject({ code: 'PBQL_PARSE_ERROR', message: 'unexpected "video"' })
    expect(parse('FROM folder(92) WHERE true').errors[0])
      .toMatchObject({ code: 'PBQL_PARSE_ERROR', message: 'unexpected "folder"' })
  })

  test('AND binds tighter than OR; junctions flatten n-ary', () => {
    expect(parseWhere('shot.a = 1 OR shot.b = 2 AND shot.c = 3 AND shot.d = 4'))
      .toMatchObject({
        kind: 'or',
        args: [
          { kind: 'cmp' },
          { kind: 'and', args: [{ kind: 'cmp' }, { kind: 'cmp' }, { kind: 'cmp' }] }
        ]
      })
  })

  test('comparison binds tighter than NOT', () => {
    expect(parseWhere('NOT shot.isVolley = false')).toEqual({
      kind: 'not',
      arg: {
        kind: 'cmp',
        op: '=',
        lhs: {
          kind: 'prop',
          base: { object: 'shot', offset: 0 },
          path: ['isVolley']
        },
        rhs: { kind: 'lit', value: false }
      }
    })
  })

  test('arithmetic precedence and unary minus', () => {
    expect(parseWhere('-shot.yaw + 3 * 2 > 1')).toMatchObject({
      kind: 'cmp',
      op: '>',
      lhs: {
        kind: 'arith',
        op: '+',
        lhs: { kind: 'neg', arg: { kind: 'prop' } },
        rhs: { kind: 'arith', op: '*' }
      }
    })
  })

  test('alias operators canonicalize in the AST', () => {
    expect(parseWhere('shot.speed <> 3').op).toBe('!=')
    expect(parseWhere('shot.speed == 3').op).toBe('=')
  })

  test('IN keeps its literal list', () => {
    expect(parseWhere('shot.num IN (3, 5, "x")')).toMatchObject({
      kind: 'in',
      lhs: { kind: 'prop', path: ['num'] },
      list: [3, 5, 'x']
    })
  })

  test('IN admits signed numeric literals, matching "= -1" legality', () => {
    expect(parseWhere('shot.pitch IN (-1, 2, -3.5)').list).toEqual([-1, 2, -3.5])
  })

  test('relative shot/rally references carry offsets', () => {
    expect(parseWhere('shot[-1].isVolley').base).toEqual({ object: 'shot', offset: -1 })
    expect(parseWhere('rally[2].winner = 1').lhs.base).toEqual({ object: 'rally', offset: 2 })
  })

  test('the me root parses as a player base; relations are path segments', () => {
    const me = parseWhere('me.teammate.name = "x"').lhs
    expect(me.base).toEqual({ object: 'player', root: 'me' })
    expect(me.path).toEqual(['teammate', 'name'])
    // shot.hitter navigates from a shot base; hitter is just a path segment
    const hitter = parseWhere('shot[1].hitter.opponentLHS = me').lhs
    expect(hitter.base).toEqual({ object: 'shot', offset: 1 })
    expect(hitter.path).toEqual(['hitter', 'opponentLHS'])
    // a path ending AT a player carries an empty scalar tail (identity)
    expect(parseWhere('shot.hitter = me').lhs)
      .toMatchObject({ base: { object: 'shot', offset: 0 }, path: ['hitter'] })
  })

  test('keywords are legal path segments', () => {
    expect(parseWhere('shot.video.true.min = 1').lhs.path)
      .toEqual(['video', 'true', 'min'])
  })

  test('methods attach args to the last path segment; empty args allowed', () => {
    expect(parseWhere('shot.taggedWith("BJ*")')).toEqual({
      kind: 'prop',
      base: { object: 'shot', offset: 0 },
      path: ['taggedWith'],
      args: [{ kind: 'lit', value: 'BJ*' }]
    })
    const { ast } = parse('SELECT count() FROM "f" WHERE true')
    expect(stripLoc(ast.select)).toEqual([
      { expr: { kind: 'call', name: 'count', args: [] }, label: null }])
  })

  test('string escapes resolve in the AST', () => {
    expect(parseWhere('shot.hitter.name = "say \\"hi\\" \\\\"').rhs.value)
      .toBe('say "hi" \\')
  })

  test('function names take their canonical spelling, whatever the case', () => {
    const { ast, errors } = parse('SELECT SUM(shot.speed), Count(), ' +
      'AVG(TOMS(shot.hitTime)) FROM "f" WHERE EXISTS(shot.type)')
    expect(errors).toBeUndefined()
    expect(ast.select.map(({ expr }) => expr.name)).toEqual(['sum', 'count', 'avg'])
    expect(ast.select[2].expr.args[0].name).toBe('toMs')
    expect(ast.where.name).toBe('exists')
    // a name the language lacks stays as written, for the analyzer to report
    expect(parseWhere('FOO(shot.speed)').name).toBe('FOO')
    // methods are not functions: their names stay case-sensitive
    expect(parseWhere('shot.TaggedWith("x")').path).toEqual(['TaggedWith'])
  })

  test('a one-word label may go unquoted, in SELECT and ORDER BY', () => {
    const { ast, errors } = parse(
      'SELECT shot.type AS t, count() AS n FROM "f" WHERE true ' +
      'GROUP BY shot.type ORDER BY n DESC, t')
    expect(errors).toBeUndefined()
    expect(ast.select.map(({ label }) => label)).toEqual(['t', 'n'])
    expect(stripLoc(ast.orderBy)).toEqual([
      { expr: { kind: 'lit', value: 'n' }, dir: 'desc' },
      { expr: { kind: 'lit', value: 't' }, dir: 'asc' }])
    // keyword words too, where nothing else can stand
    const words = parse('SELECT count() AS shots, game.vid AS game, ' +
      'shot.speed AS secs FROM "f" WHERE true ORDER BY shots, secs')
    expect(words.errors).toBeUndefined()
    expect(words.ast.select.map(({ label }) => label))
      .toEqual(['shots', 'game', 'secs'])
    expect(stripLoc(words.ast.orderBy).map(({ expr }) => expr.value))
      .toEqual(['shots', 'secs'])
  })

  test('count(*) is count()', () => {
    for (const text of ['count(*)', 'COUNT( * )']) {
      const { ast, errors } = parse(`SELECT ${text} FROM "f" WHERE true`)
      expect(errors).toBeUndefined()
      expect(stripLoc(ast.select[0].expr)).toEqual({ kind: 'call', name: 'count', args: [] })
    }
    // no other function takes a star
    expect(parse('SELECT sum(*) FROM "f" WHERE true').errors[0].code)
      .toBe('PBQL_PARSE_ERROR')
  })

  test('single-quoted strings mean the same as double-quoted ones', () => {
    expect(parseWhere("shot.hitter.name = 'it''s \\ \"me\"'").rhs.value)
      .toBe('it\'s \\ "me"')
    // everywhere a string goes: sources, player names and labels too
    const { ast, errors } = parse(
      "SELECT count() AS 'n' FROM 'f' WHERE shot.hitter = player('Ray')")
    expect(errors).toBeUndefined()
    expect(ast.sources).toEqual(['f'])
    expect(ast.select[0].label).toBe('n')
    expect(ast.where.rhs.base.name).toBe('Ray')
  })

  test('durations: units, aliases, rally, min/max', () => {
    const q = 'FROM "f" WHERE true CONTEXT BEFORE max(1 shot, 2.5secs) CONTEXT AFTER rally'
    const { ast, errors } = parse(q)
    expect(errors).toBeUndefined()
    expect(ast.context.before).toEqual({
      kind: 'durfn',
      fn: 'max',
      args: [
        { kind: 'dur', unit: 'shots', value: 1 },
        { kind: 'dur', unit: 'secs', value: 2.5 }
      ]
    })
    expect(ast.context.after).toEqual({ kind: 'dur', unit: 'rally' })
  })

  test('ORDER BY supports directions per key; LIMIT parses', () => {
    const { ast } = parse(
      'FROM "f" WHERE true ORDER BY shot.speed DESC, shot.hitTime LIMIT 25')
    expect(ast.orderBy.map(o => o.dir)).toEqual(['desc', 'asc'])
    expect(ast.limit).toBe(25)
  })

  test('SELECT items take optional AS labels', () => {
    const { ast } = parse(
      'SELECT shot.speed AS "mph", shot.hitter.name FROM "f" WHERE true')
    expect(ast.select.map(s => s.label)).toEqual(['mph', null])
  })

  test('reports unrecognized text with its position', () => {
    const { ast, errors } = parse('FROM @')
    expect(ast).toBeUndefined()
    expect(errors).toEqual([{
      code: 'PBQL_LEX_ERROR',
      message: 'unrecognized text',
      line: 1,
      col: 6,
      length: 1
    }])
  })

  test('reports an unexpected token with its position and length', () => {
    const { errors } = parse('FROM FROM')
    expect(errors).toEqual([{
      code: 'PBQL_PARSE_ERROR',
      message: 'unexpected "FROM"',
      line: 1,
      col: 6,
      length: 4
    }])
  })

  test('reports an incomplete query at the end of the input', () => {
    const { errors } = parse('FROM "wxyz"\nWHERE')
    expect(errors).toEqual([{
      code: 'PBQL_UNEXPECTED_END',
      message: 'query ended unexpectedly (incomplete statement)',
      line: 2,
      col: 6,
      length: 0
    }])
  })

  test('names a missing WHERE instead of the clause that came next', () => {
    const missing = {
      code: 'PBQL_MISSING_WHERE',
      message: 'every query needs a WHERE clause after FROM; when no ' +
        'filter is wanted, write WHERE true'
    }
    // the next clause is where parsing stopped
    expect(parse('SELECT shot.type, count() FROM "g" GROUP BY shot.type')
      .errors).toEqual([{ ...missing, line: 1, col: 36, length: 8 }])
    expect(parse('FROM "g" LIMIT 3').errors)
      .toEqual([{ ...missing, line: 1, col: 10, length: 5 }])
    // or the end of the query, in any branch of a union
    expect(parse('SELECT count() FROM "g"').errors)
      .toEqual([{ ...missing, line: 1, col: 24, length: 0 }])
    expect(parse('SELECT count() FROM "h" UNION ALL ' +
      'SELECT count() FROM "g" WHERE true').errors[0].code)
      .toBe('PBQL_MISSING_WHERE')
    // a WHERE that is there but incomplete is not missing
    expect(parse('FROM "g" WHERE').errors[0].code).toBe('PBQL_UNEXPECTED_END')
    expect(parse('FROM "g" WHERE )').errors[0].code).toBe('PBQL_PARSE_ERROR')
  })

  test('says player needs a name instead of an unexpected "."', () => {
    expect(parse('SELECT player.name, count() FROM "g" WHERE true ' +
      'GROUP BY player.name').errors).toEqual([{
      code: 'PBQL_PLAYER_NEEDS_NAME',
      message: 'player needs a name, as in player("Ray").team; to go ' +
        'over every player, use shot.hitter (GROUP BY shot.hitter.name)',
      line: 1,
      col: 14,
      length: 1
    }])
    // any other stray "." is still just unexpected
    expect(parse('FROM "g" WHERE shot..num = 1').errors[0])
      .toMatchObject({ code: 'PBQL_PARSE_ERROR', message: 'unexpected "."' })
    expect(parse('FROM "g" WHERE . = 1').errors[0].code)
      .toBe('PBQL_PARSE_ERROR')
  })

  test('rejects calling an object or a non-min/max duration function', () => {
    expect(parse('FROM "f" WHERE shot("x")').errors[0].code)
      .toBe('PBQL_UNEXPECTED_END')
    expect(parse('FROM "f" WHERE true CONTEXT BEFORE avg(1 shots, 2secs)')
      .errors[0].code).toBe('PBQL_UNEXPECTED_END')
  })
})
