import { runQuery, toShotExplorerURLs, validate } from '../src/index.js'

import { makeDoublesGame } from './fixtures/make-insights.js'

function shotsWhere (expr) {
  const result = runQuery({
    text: `FROM "v" WHERE ${expr}`,
    games: [makeDoublesGame()]
  })
  expect(result.errors).toBeUndefined()
  return result.shots.map(s => [s.rallyIdx, s.shotIdx])
}

describe('validate()', () => {
  test('valid queries return no errors plus the AST', () => {
    const { errors, ast } = validate('FROM "f" WHERE shot.taggedWith("A*")')
    expect(errors).toEqual([])
    expect(ast.where.kind).toBe('prop')
  })

  test('parse and analyze errors flow through', () => {
    expect(validate('FROM @').errors[0].code).toBe('PBQL_LEX_ERROR')
    const analyzed = validate('FROM "f" WHERE shot.isVoley')
    expect(analyzed.errors[0].code).toBe('PBQL_UNKNOWN_PROPERTY')
    expect(analyzed.ast).toBeDefined() // parsed fine, still returned
  })
})

describe('built-ins', () => {
  test('unit conversions evaluate', () => {
    expect(shotsWhere('kph(shot.speed) > 80')).toEqual([[2, 2]]) // 50mph = 80.47
    expect(shotsWhere('toMs(shot.hitTime) = 58000')).toEqual([[2, 2]])
    expect(shotsWhere('toSecs(toMs(shot.hitTime)) = 58')).toEqual([[2, 2]])
  })

  test('isHitOnSide uses the hitter frame', () => {
    // by hand from the fixture strike points: near-side strikes reflect x
    // ((0,0) abs x=5 → x'=15 right; (0,2) abs x=14 → x'=6 left; (2,0) x'=15;
    // (2,2) x'=6 left), far-side strikes keep x ((0,1) x'=15; (1,0) x'=14;
    // (2,1) abs x=10 → x'=10, the right edge of the midline; (2,3) x'=15)
    expect(shotsWhere('shot.isHitOnSide("right")'))
      .toEqual([[0, 0], [0, 1], [1, 0], [2, 0], [2, 1], [2, 3]])
    expect(shotsWhere('rally.num = 1 AND shot.isHitOnSide("left")'))
      .toEqual([[0, 2]])
    // a bad side ("up") is now an analyzer error; the runtime guard for
    // unanalyzed ASTs is covered in unit-test-engine.js
    expect(shotsWhere('rally.num = 2 AND shot.num = 2 AND shot.isHitOnSide("left")'))
      .toEqual([]) // no trajectory on the sparse shot
  })
})

describe('toShotExplorerURLs', () => {
  test('one explore link per vid-shaped source, carrying the query body in ?q=', () => {
    const text = 'FROM "83gyqyc10y8f", "./games", "jhc3t8h8b5cj:2"\nWHERE shot.isVolley'
    // the URL path already names the video/session, so the FROM clause is
    // dropped from the encoded query
    const body = encodeURIComponent('WHERE shot.isVolley')
    expect(toShotExplorerURLs(text, ['83gyqyc10y8f', './games', 'jhc3t8h8b5cj:2']))
      .toEqual([
        // sessions in URLs are 0-based; local paths have no explore page
        `https://pb.vision/video/83gyqyc10y8f/0/explore?q=${body}`,
        `https://pb.vision/video/jhc3t8h8b5cj/1/explore?q=${body}`
      ])
    expect(toShotExplorerURLs('FROM "./games" WHERE true', ['./games']))
      .toEqual([])
  })

  test('unparseable text is encoded as-is', () => {
    expect(toShotExplorerURLs('not pbql', ['ab12cd34ef56']))
      .toEqual([`https://pb.vision/video/ab12cd34ef56/0/explore?q=${
        encodeURIComponent('not pbql')}`])
  })

  test('session numbers are 1-based; :0 is rejected', () => {
    expect(() => toShotExplorerURLs('q', ['ab12cd34ef56:0']))
      .toThrow('"ab12cd34ef56:0": session numbers are 1-based')
  })

  // the link's ?q= body, decoded
  const bodies = urls => urls.map(url => new URL(url).searchParams.get('q'))

  test('a UNION link keeps only the branches that read its game', () => {
    const text = 'FROM "aaaaaaaaaaaa:1" WHERE rally.num = 2\n' +
      'UNION ALL FROM "bbbbbbbbbbbb:1" WHERE rally.num = 16\n' +
      'UNION ALL FROM "cccccccccccc:1" WHERE rally.num = 30'
    expect(bodies(toShotExplorerURLs(text,
      ['aaaaaaaaaaaa:1', 'bbbbbbbbbbbb:1', 'cccccccccccc:1'])))
      .toEqual(['WHERE rally.num = 2', 'WHERE rally.num = 16', 'WHERE rally.num = 30'])
  })

  test('a game read by several branches keeps them as a UNION', () => {
    const text = 'FROM "aaaaaaaaaaaa" WHERE shot.isVolley LIMIT 2\n' +
      'UNION FROM "bbbbbbbbbbbb" WHERE shot.isVolley\n' +
      'UNION ALL FROM "aaaaaaaaaaaa", "bbbbbbbbbbbb" WHERE shot.num = 3'
    expect(bodies(toShotExplorerURLs(text, ['aaaaaaaaaaaa', 'bbbbbbbbbbbb'])))
      .toEqual([
        'WHERE shot.isVolley\nLIMIT 2\nUNION ALL\nWHERE shot.num = 3',
        'WHERE shot.isVolley\nUNION ALL\nWHERE shot.num = 3'
      ])
  })

  test('a link calls each player by the name its page knows', () => {
    const text = 'FROM "aaaaaaaaaaaa:1", "bbbbbbbbbbbb:1"\n' +
      'WHERE shot.hitter.name IN ("Unknown 1", "Unknown 3") OR ' +
      'shot.hitter = player("Unknown 3").teammate OR ' +
      'shot.taggedWith("Unknown*")\n' +
      'UNION ALL FROM "aaaaaaaaaaaa:1" WHERE shot.hitter.name = "Amy"'
    const urls = toShotExplorerURLs(text, ['aaaaaaaaaaaa:1', 'bbbbbbbbbbbb:1'], {
      playerNames: {
        'aaaaaaaaaaaa:1': { 'Unknown 1': 'Player 2' },
        'bbbbbbbbbbbb:1': { 'Unknown 3': 'Player 4' }
      }
    })
    expect(bodies(urls)).toEqual([
      // another game's Unknown stays as written, matching nobody here
      'WHERE shot.hitter.name IN ("Player 2", "Unknown 3") OR ' +
        'shot.hitter = player("Unknown 3").teammate OR ' +
        'shot.taggedWith("Unknown*")\n' +
        'UNION ALL\nWHERE shot.hitter.name = "Amy"',
      'WHERE shot.hitter.name IN ("Unknown 1", "Player 4") OR ' +
        'shot.hitter = player("Player 4").teammate OR ' +
        'shot.taggedWith("Unknown*")'
    ])
  })

  test('a single-game UNION link keeps every branch', () => {
    const text = 'FROM "aaaaaaaaaaaa:1" WHERE shot.isVolley\n' +
      'UNION ALL FROM "aaaaaaaaaaaa:1" WHERE shot.num = 3 LIMIT 5'
    expect(bodies(toShotExplorerURLs(text, ['aaaaaaaaaaaa:1'])))
      .toEqual(['WHERE shot.isVolley\nUNION ALL\nWHERE shot.num = 3\nLIMIT 5'])
  })
})

describe('LLM_GUIDE', () => {
  test('ships the generated language guide for prompt-building hosts', async () => {
    const { LLM_GUIDE } = await import('../src/index.js')
    expect(LLM_GUIDE).toContain('## Query shape')
    expect(LLM_GUIDE).toContain('CONTEXT BEFORE')
    expect(LLM_GUIDE).toContain('## Data Dictionary')
    expect(LLM_GUIDE).toContain('## Examples')
  })

  test('methods carry their real return type, not a blanket boolean', async () => {
    const { LLM_GUIDE } = await import('../src/index.js')
    // rally.count() is the numeric method, and the whole point of it is
    // comparing the count: telling a model it returns a boolean is worse
    // than saying nothing
    expect(LLM_GUIDE).toContain('rally.count(condition) (number):')
    expect(LLM_GUIDE).toContain('shot.taggedWith(pattern) (boolean):')
  })
})
