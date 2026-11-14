import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse, print } from '../src/index.js'

import { stripLoc } from './helpers.js'

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

function roundtrips (text) {
  const first = parse(text)
  expect(first.errors).toBeUndefined()
  const printed = print(first.ast)
  const second = parse(printed)
  expect(second.errors).toBeUndefined()
  expect(stripLoc(second.ast)).toEqual(stripLoc(first.ast))
  return printed
}

// every example in the NL→PBQL corpus, split on its "# Q:" markers
function readCorpus () {
  const text = fs.readFileSync(
    path.join(repoRoot, 'test', 'corpus', 'examples.pbql'), 'utf8')
  const examples = []
  for (const line of text.split('\n')) {
    if (line.startsWith('# Q:')) {
      examples.push({ question: line.slice(4).trim(), lines: [] })
    } else if (examples.length > 0 && line.trim() !== '') {
      examples.at(-1).lines.push(line)
    }
  }
  return examples.map(e => ({ question: e.question, query: e.lines.join('\n') }))
}

describe('the example corpus', () => {
  const corpus = readCorpus()

  test('has a healthy number of examples', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(20)
  })

  test.each(corpus)('parses and roundtrips: $question', ({ query }) => {
    roundtrips(query)
  })

  // the corpus feeds docs/llms.txt, so its examples must be stored exactly
  // as print() would emit them (canonical keyword case, singular "1 shot" /
  // "1sec" units, current FROM string syntax, …) — no drift allowed
  test.each(corpus)('is stored canonically: $question', ({ query }) => {
    expect(query).toBe(print(parse(query).ast))
  })
})

// example queries displayed by the docs site and README are authored
// separately from the corpus, so hold them to the same canonical bar
describe('displayed example queries are canonical', () => {
  const decode = html => html.replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>').replaceAll('&amp;', '&')
  const expectCanonical = query => {
    const { ast, errors } = parse(query)
    expect(errors).toBeUndefined()
    expect(query).toBe(print(ast))
  }

  test('the docs-site homepage example', () => {
    const html = fs.readFileSync(
      path.join(repoRoot, 'docs-site', 'index.html'), 'utf8')
    const match = html.match(/<pre><code>([\s\S]*?)<\/code><\/pre>/)
    expect(match).not.toBeNull()
    expectCanonical(decode(match[1]))
  })

  test('the playground starter query', () => {
    const html = fs.readFileSync(
      path.join(repoRoot, 'docs-site', 'playground', 'index.html'), 'utf8')
    const match = html.match(/<textarea id="query"[^>]*>\n?([\s\S]*?)<\/textarea>/)
    expect(match).not.toBeNull()
    expectCanonical(decode(match[1]))
  })

  test('the README example', () => {
    const md = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8')
    const match = md.match(/```sql\n([\s\S]*?)\n```/)
    expect(match).not.toBeNull()
    expectCanonical(match[1])
  })
})

describe('print()', () => {
  test('the demo query roundtrips through print', () => {
    roundtrips(fs.readFileSync(path.join(repoRoot, 'test', 'demo.pbql'), 'utf8'))
  })

  test('canonicalizes keyword case and alias operators', () => {
    const printed = roundtrips('from "f" where shot.speed <> 3 and shot.num == 2')
    expect(printed).toBe('FROM "f"\nWHERE shot.speed != 3 AND shot.num = 2')
  })

  test('keeps necessary parentheses and drops redundant ones', () => {
    const printed = roundtrips(
      'FROM "f" WHERE ((shot.isVolley OR shot.isReset)) AND (shot.isPoach AND (shot.isFinal))')
    expect(printed).toBe(
      'FROM "f"\nWHERE (shot.isVolley OR shot.isReset) AND shot.isPoach AND shot.isFinal')
  })

  test('prints CASE in its searched form, needing no parentheses', () => {
    expect(roundtrips('SELECT case shot.type when "drop" then 1 else 2 end * 3 ' +
      'FROM "f" WHERE true')).toContain(
      'SELECT CASE WHEN shot.type = "drop" THEN 1 ELSE 2 END * 3')
    expect(roundtrips('FROM "f" WHERE CASE WHEN shot.isVolley OR shot.isFinal ' +
      'THEN shot.speed > 40 END')).toContain(
      'WHERE CASE WHEN shot.isVolley OR shot.isFinal THEN shot.speed > 40 END')
    // IS NULL prints as the exists() test it is
    expect(roundtrips('FROM "f" WHERE shot.type IS NULL OR shot.speed IS NOT NULL'))
      .toContain('WHERE NOT exists(shot.type) OR exists(shot.speed)')
  })

  test('parenthesizes NOT of a junction but not NOT of a comparison', () => {
    expect(roundtrips('FROM "f" WHERE NOT (shot.isVolley AND shot.isReset)'))
      .toContain('NOT (shot.isVolley AND shot.isReset)')
    expect(roundtrips('FROM "f" WHERE NOT shot.speed = 3'))
      .toContain('NOT shot.speed = 3')
  })

  test('prints arithmetic with minimal parens, honoring associativity', () => {
    expect(roundtrips('FROM "f" WHERE shot.a - (shot.b + 1) * 2 = 0'))
      .toContain('shot.a - (shot.b + 1) * 2 = 0')
    expect(roundtrips('FROM "f" WHERE - -1 = 1'))
      .toContain('- -1 = 1')
  })

  test('prints relative references, methods, IN, and durations canonically', () => {
    const printed = roundtrips(`
      select shot.speed as "mph" from "abc123def456:2", "games/*.json"
      where shot[-1].taggedWith("BJ*") and shot.num in (1, 3)
      context before max(1 shot, 2sec)
      context after rally
      order by shot.speed desc, shot.hitTime asc
      limit 10`)
    expect(printed).toBe([
      'SELECT shot.speed AS "mph"',
      'FROM "abc123def456:2", "games/*.json"',
      'WHERE shot[-1].taggedWith("BJ*") AND shot.num IN (1, 3)',
      'CONTEXT BEFORE max(1 shot, 2secs)',
      'CONTEXT AFTER rally',
      'ORDER BY shot.speed DESC, shot.hitTime',
      'LIMIT 10'
    ].join('\n'))
  })

  test('prints GROUP BY canonically between WHERE and ORDER BY', () => {
    const printed = roundtrips(
      'select shot.type, count() from "f" where true group by shot.type ' +
      'order by count() desc limit 3')
    expect(printed).toBe([
      'SELECT shot.type, count()',
      'FROM "f"',
      'WHERE true',
      'GROUP BY shot.type',
      'ORDER BY count() DESC',
      'LIMIT 3'
    ].join('\n'))
    // multiple keys keep their comma list
    expect(roundtrips(
      'SELECT count() FROM "f" WHERE true GROUP BY shot.type, shot.hitter.team'))
      .toContain('GROUP BY shot.type, shot.hitter.team')
    // GROUP BY + CONTEXT is an analyzer error, but it still prints/reparses
    expect(roundtrips(
      'SELECT count() FROM "f" WHERE true GROUP BY shot.type CONTEXT BEFORE 2secs'))
      .toBe('SELECT count()\nFROM "f"\nWHERE true\nGROUP BY shot.type\nCONTEXT BEFORE 2secs')
  })

  test('extreme magnitudes print decimal-only, never e-notation', () => {
    // 0.0000001 is 1e-7: String() would render it with an exponent, which
    // the lexer cannot reparse — the printer must expand it
    expect(roundtrips('FROM "f" WHERE shot.speed = 0.0000001'))
      .toContain('shot.speed = 0.0000001')
    expect(roundtrips('FROM "f" WHERE shot.speed = 0.00000015'))
      .toContain('shot.speed = 0.00000015')
    expect(roundtrips('FROM "f" WHERE shot.speed = 1000000000000000000000000'))
      .toContain('shot.speed = 1000000000000000000000000')
    expect(roundtrips('FROM "f" WHERE true CONTEXT BEFORE 0.0000001secs'))
      .toContain('CONTEXT BEFORE 0.0000001secs')
    expect(roundtrips('FROM "f" WHERE true LIMIT 1000000000000000000000000'))
      .toContain('LIMIT 1000000000000000000000000')
  })

  test('prints sources as quoted strings, escapes included', () => {
    expect(roundtrips('from "abc123def456:2" , "games/*.json" WHERE true'))
      .toBe('FROM "abc123def456:2", "games/*.json"\nWHERE true')
    expect(roundtrips('FROM "a \\"b\\" \\\\" WHERE true'))
      .toBe('FROM "a \\"b\\" \\\\"\nWHERE true')
  })

  test('omits the ±1 default context and prints escaped strings', () => {
    const printed = roundtrips('FROM "f" WHERE shot.hitter.name = "say \\"hi\\" \\\\"')
    expect(printed).toBe('FROM "f"\nWHERE shot.hitter.name = "say \\"hi\\" \\\\"')
  })

  test('prints player navigation: me root and shot.hitter relations', () => {
    expect(roundtrips('FROM "f" WHERE me.teammate.feetToKitchen <= 2'))
      .toContain('me.teammate.feetToKitchen <= 2')
    expect(roundtrips('FROM "f" WHERE shot[1].hitter.opponentLHS.name = "Joe"'))
      .toContain('shot[1].hitter.opponentLHS.name = "Joe"')
    expect(roundtrips('FROM "f" WHERE shot.hitter = me'))
      .toContain('shot.hitter = me')
  })
})

describe('duration number agreement', () => {
  test('singular units print as 1 shot / 1sec', () => {
    expect(roundtrips('FROM "f" WHERE true CONTEXT BEFORE 1secs CONTEXT AFTER 1 shots'))
      .toContain('CONTEXT BEFORE 1sec\nCONTEXT AFTER 1 shot')
  })
})

describe('default vs explicit CONTEXT printing', () => {
  // a bare shot-list carries the ±1 default, which prints with no clause
  test('the ±1 shot-list default prints no CONTEXT clause', () => {
    expect(roundtrips('FROM "f" WHERE shot.isVolley')).toBe(
      'FROM "f"\nWHERE shot.isVolley')
  })

  // an explicit zero window is distinct from the default: it prints one
  // canonical clause that reparses to (0secs, 0secs)
  test('an explicit zero window prints exactly CONTEXT BEFORE 0secs', () => {
    expect(roundtrips('FROM "f" WHERE shot.isVolley CONTEXT BEFORE 0secs')).toBe(
      'FROM "f"\nWHERE shot.isVolley\nCONTEXT BEFORE 0secs')
    // both-zero written either way canonicalizes to the same single clause
    expect(roundtrips('FROM "f" WHERE shot.isVolley CONTEXT AFTER 0secs')).toBe(
      'FROM "f"\nWHERE shot.isVolley\nCONTEXT BEFORE 0secs')
  })

  // a written clause opts out of the ±1 default; the unwritten side is zero
  test('a single written side leaves the other omitted (zero)', () => {
    expect(roundtrips('FROM "f" WHERE shot.isVolley CONTEXT BEFORE 5 shots')).toBe(
      'FROM "f"\nWHERE shot.isVolley\nCONTEXT BEFORE 5 shots')
    expect(roundtrips('FROM "f" WHERE shot.isVolley CONTEXT AFTER 2secs')).toBe(
      'FROM "f"\nWHERE shot.isVolley\nCONTEXT AFTER 2secs')
    // zero shots is not the secs zero: both sides print explicitly
    expect(roundtrips('FROM "f" WHERE shot.isVolley CONTEXT BEFORE 0 shots CONTEXT AFTER 0 shots'))
      .toBe('FROM "f"\nWHERE shot.isVolley\nCONTEXT BEFORE 0 shots\nCONTEXT AFTER 0 shots')
  })

  // projections have no ±1 default: (0, 0) prints nothing, non-zero prints
  test('a projection prints only its non-zero context sides', () => {
    expect(roundtrips('SELECT shot.speed FROM "f" WHERE true')).toBe(
      'SELECT shot.speed\nFROM "f"\nWHERE true')
    // GROUP BY + CONTEXT is an analyzer error but still prints/reparses
    expect(roundtrips('SELECT count() FROM "f" WHERE true GROUP BY shot.type CONTEXT AFTER 3secs'))
      .toBe('SELECT count()\nFROM "f"\nWHERE true\nGROUP BY shot.type\nCONTEXT AFTER 3secs')
  })
})

describe('print: UNION', () => {
  test('prints each branch, joined by the keyword that made it', () => {
    const text = 'SELECT count() AS "n" FROM "a" WHERE true ' +
      'UNION ALL SELECT count() FROM "b" WHERE true ' +
      'UNION SELECT count() FROM "c" WHERE true'
    expect(print(parse(text).ast)).toBe([
      'SELECT count() AS "n"', 'FROM "a"', 'WHERE true',
      'UNION ALL',
      'SELECT count()', 'FROM "b"', 'WHERE true',
      'UNION',
      'SELECT count()', 'FROM "c"', 'WHERE true'
    ].join('\n'))
  })

  test('a union round-trips, keeping each branch whole', () => {
    // the per-branch LIMIT is the point of the feature, so it is the
    // thing most worth knowing survives a print/parse cycle
    roundtrips('FROM "a" WHERE shot.isVolley LIMIT 1 ' +
      'UNION FROM "b" WHERE shot.isDink LIMIT 2')
    roundtrips('SELECT sum(shot.speed) FROM "a" WHERE true ' +
      'UNION ALL SELECT sum(shot.speed) FROM "b" WHERE true')
  })
})
