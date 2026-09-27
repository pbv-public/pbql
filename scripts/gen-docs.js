// Generates docs/data-dictionary.md and docs/llms.txt from the property
// registry (src/model/registry.js) and the example corpus
// (test/corpus/examples.pbql), so the docs cannot drift from the code.
// Run via `yarn docs`.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { POSITION_ROOT_DOCS, POSITION_SUBPROPS, REGISTRY } from '../src/model/registry.js'

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

const OBJECT_DOCS = {
  shot: 'The shot being tested. `shot[k]` addresses the shot k earlier/later in the same rally. `shot.hitter` navigates to the player who hit it.',
  position: 'The shape of `shot.from`, `shot.to`, and `shot.peak`: append one of these properties to read a value (`shot.peak.z`, `shot.to.feetToNet`).',
  rally: 'The rally containing the current shot. `rally[k]` addresses neighboring rallies in the same game.',
  game: 'The session (one game of a possibly multi-game video) containing the shot.',
  player: 'A player value, reached from the root `me` or a shot\'s `hitter` (e.g. `shot.hitter`, `shot[1].hitter`) and stepped through the relations below. A path ending AT a player is its identity, for `=`/`!=` (`shot.hitter = me`). Scalar props are measured at the moment of the shot the player was reached through.'
}

// pipes inside a cell (enum unit strings like "a"|"b") would otherwise
// split it and silently drop the values after the first
const cell = text => String(text).replaceAll('|', '\\|')

// The shot table shows each position as one position-typed row (its shape
// is the shared `position` section) instead of nine near-identical rows;
// the per-position zone rows keep their own entries.
function collapsePositions (propList) {
  const out = []
  const seen = new Set()
  for (const p of propList) {
    const root = p.path.match(/^(from|to|peak)\./)?.[1]
    if (root !== undefined && !p.path.endsWith('.zone')) {
      if (!seen.has(root)) {
        seen.add(root)
        out.push({ path: root, type: 'position', doc: POSITION_ROOT_DOCS[root] })
      }
      continue
    }
    out.push(p)
  }
  return out
}

function propRows (objName, { propList, methodList, relationList }) {
  const rows = relationList.map(r =>
    `| \`${objName}.${r.name}\` | ${cell(r.doc)} | player | |`)
  const props = objName === 'shot' ? collapsePositions(propList) : propList
  rows.push(...props.map(p =>
    `| \`${objName}.${p.path}\` | ${cell(p.doc)} | ${p.type} | ${cell(p.unit ?? '')} |`))
  rows.push(...methodList.map(m => {
    const args = m.args.map(a => a.name).join(', ')
    return `| \`${objName}.${m.name}(${args})\` | ${cell(m.doc)} | ${m.type ?? 'boolean'} | |`
  }))
  return rows
}

function generateDictionary () {
  const parts = [
    '# PBQL Data Dictionary',
    '',
    '<!-- GENERATED FILE — do not edit. Run `yarn docs` to regenerate',
    '     from src/model/registry.js. -->',
    '',
    'The complete queryable surface. Any property may be **unknown** when the',
    'underlying data was not detected — see the unknown-handling rules in',
    '[Language](language.md). `player.*` rows apply to every player',
    'reference; positions are measured at the moment the current shot was hit.',
    ''
  ]
  for (const [objName, entry] of Object.entries(REGISTRY)) {
    parts.push(`## ${objName}`, '', OBJECT_DOCS[objName], '',
      '| Property | Description | Type | Unit / values |',
      '|---|---|---|---|',
      ...propRows(objName, entry), '')
    if (objName === 'shot') {
      parts.push('## position', '', OBJECT_DOCS.position, '',
        '| Property | Description | Type | Unit / values |',
        '|---|---|---|---|',
        ...POSITION_SUBPROPS.map(s =>
          `| \`.${s.path}\` | ${cell(s.doc)} | number | ${cell(s.unit)} |`), '')
    }
  }
  return parts.join('\n')
}

function readExamples () {
  const text = fs.readFileSync(
    path.join(repoRoot, 'test', 'corpus', 'examples.pbql'), 'utf8')
  const examples = []
  for (const line of text.split('\n')) {
    if (line.startsWith('# Q:')) {
      examples.push({ question: line.slice(4).trim(), query: [] })
    } else if (examples.length > 0 && line.trim() !== '') {
      examples.at(-1).query.push(line)
    }
  }
  return examples.map(e => ({ ...e, query: e.query.join('\n') }))
}

/**
 * The guide, for two audiences.
 *
 * `withCli` keeps the CLI section: docs/llms.txt is read by people (and
 * their own LLMs) who run `pbql` in a shell. LLM_GUIDE is not -- every
 * consumer of it drives PBQL through tools, none of which has a shell.
 * Measured on a natural language to PBQL gate of 84 cases: with the section
 * 82/84 exact in all of 6 runs, without it 84/84 in all of 3. The section is
 * not merely unused, it costs two cases.
 */
function generateLlmsTxt ({ withCli = true } = {}) {
  const parts = [
    '# PBQL (Pickleball Query Language) — guide for LLMs',
    '',
    '<!-- GENERATED FILE — do not edit. Run `yarn docs`. -->',
    '',
    'PBQL selects shots from pickleball games analyzed by PB Vision.',
    '',
    '## Query shape (clauses in this order)',
    '',
    '    [SELECT expr [AS "label"], ...]      -- optional projection',
    '    FROM "source", ...                   -- quoted strings the host resolves',
    '      -- pb.vision video: "83gyqyc10y8f" (game 2 = "83gyqyc10y8f:2");',
    '      -- the CLI also takes a file ("game.json"), a directory (every',
    '      -- *.json beneath it), or a glob ("games/*.json")',
    '    WHERE condition                      -- required',
    '    [GROUP BY expr, ...]            -- one output row per group',
    '    [CONTEXT BEFORE duration]      -- omit for the default 1-shot lead-in; write to override',
    '    [CONTEXT AFTER duration]       -- omit for the default 1-shot lead-out; write to override',
    '    [ORDER BY expr [ASC|DESC], ...]',
    '    [LIMIT n]',
    '',
    '## Rules that matter',
    '',
    '- Keywords are case-insensitive; property names are case-sensitive.',
    '- Operators (loosest to tightest): OR, AND, NOT, comparisons',
    '  (= != < <= > >=, x IN (a, b)), + -, * /, unary -.',
    '- Strings are double-quoted. Comments start with #.',
    '- Missing data is "unknown" (SQL NULL-like): comparisons with unknown',
    '  are unknown and WHERE keeps only true. exists(x) tests presence.',
    '- exists() takes a property, not a bare object: to probe whether a',
    '  shot/rally reference exists, use its num — exists(shot[1].num), not',
    '  exists(shot[1]) — since num is always present when the reference is',
    '  in range. exists() tests only the property it names (which may be a',
    '  shot[k] reference) — it never scans the rally. To count or detect',
    '  shots satisfying a condition anywhere in the rally, use',
    '  rally.count(condition).',
    '- Fault flags are the exception to unknown-ness: shot.hasError,',
    '  shot.hasFault, shot.errors.faults.net and shot.errors.faults.short',
    '  are never unknown (a fault is recorded only when it happened, so',
    '  absent means false). NOT shot.errors.faults.net simply selects every',
    '  shot the net didn\'t stop — no exists() guard needed.',
    '- Who won and who missed are different properties, and they share a',
    '  vocabulary. shot.winnerType is set only on a shot that WON the',
    '  rally: "forced_fault" there means the OPPONENTS faulted replying to',
    '  it. Faults the hitter committed are shot.hasFault and',
    '  shot.errors.unforced. So "points lost to my own errors" is',
    '  shot.errors.unforced, never winnerType = "forced_fault", and',
    '  grouping faults by winnerType counts rallies the hitter won.',
    '  shot.errors.unforced is also three-valued and often unknown on a',
    '  real fault, so count forced faults as shot.errors.unforced = false.',
    '  Subtracting the unforced count from the fault count counts every',
    '  unknown as forced (on one sample game that turns 9 into 19).',
    '- avg() of a three-valued property averages only the rows where it is',
    '  known, so its denominator is not every shot. avg(shot.errors.unforced)',
    '  is the share of ASSESSED faults that were unforced (on one game, 7 of',
    '  19, 37%), never a rate per shot. For "how often do I make an unforced',
    '  error", divide by the shots: sum(shot.errors.unforced) / count() (7',
    '  of 285 shots, 2.5%). Whenever you state a rate, say what it is out of',
    '  (per shot, per fault, per rally).',
    '- UNION joins whole queries: each branch keeps its own SELECT, FROM,',
    '  WHERE and LIMIT, every branch must select the same number of columns',
    '  (names come from the first), and UNION ALL keeps duplicate rows where',
    '  a bare UNION drops them. Reach for it when the branches genuinely',
    '  differ -- a row per game from a different FROM, or one example shot',
    '  from each of two games (LIMIT 1 UNION ALL ... LIMIT 1, which no',
    '  single query expresses). When the categories are just values of one',
    '  property, GROUP BY it instead: GROUP BY shot.errors.unforced returns',
    '  a row each for true, false and unknown, in one pass.',
    '- Never SELECT a literal you worked out yourself. A chart is supposed',
    '  to show what the query found, so put the arithmetic in the query:',
    '  SELECT sum(<condition A>) AS "A", sum(<condition B>) AS "B".',
    '  There are still no subqueries and no FROM-less SELECT.',
    '- Durations: `2secs`, `1 shot`, `rally` (= to the rally boundary), or',
    '  min(a, b)/max(a, b) of two durations.',
    '  `N shots` also adds those shots to the results as context.',
    '- Subject predicates are methods: shot.taggedWith("Alex*"),',
    '  shot.inHighlight("atp"). Utilities are functions: min, max, exists,',
    '  abs, kph (mph→km/h — apply it to the property when testing a km/h',
    '  threshold: kph(shot.speed) > 70), toMs, toSecs, and',
    '  timecode(secs) — a time as an "m:ss" string (seconds floored;',
    '  timecode(x, true) appends a 0-based :ff frame counter at the game\'s',
    '  own fps). Strings compare with = / != only.',
    '- Times are seconds; distances feet; speeds mph; quality 0-1 (1 best).',
    '- String properties whose dictionary entry lists quoted alternatives',
    '  (shot.type, shot.winnerType, zones, …) accept ONLY those values in',
    '  =/!=/IN — any other string literal is a validation error. A "speedup"',
    '  or "volley" is never a shot.type: those are the shot.isSpeedup /',
    '  shot.isVolley booleans.',
    '- SELECT * (alone, never with GROUP BY) lists every scalar column of',
    '  the shot, its rally, and the game as a table.',
    '- Aggregates (count, sum, avg, min, max) are operands like any other:',
    '  they can be scaled and combined inside a bigger expression, in',
    '  SELECT, HAVING, or a grouped ORDER BY. A rate becomes a percentage',
    '  with avg(<condition>) * 100 — use that whenever the answer is asked',
    '  for (or charted) as a percentage. Aggregates never nest',
    '  (avg(count()) is an error) and never appear in WHERE or GROUP BY.',
    '- GROUP BY computes per-group breakdowns (win rate by shot type, avg',
    '  speed by player) in one query; with it, every SELECT/ORDER BY item',
    '  must be built from aggregates and group keys, and CONTEXT is not',
    '  allowed. HAVING (after GROUP BY) filters the grouped rows using',
    '  aggregates and group keys, e.g. GROUP BY rally.num HAVING',
    '  count() >= 4.',
    '- WHERE is required in every query — there is no bare FROM … GROUP BY.',
    '  When no filter is wanted (count everything, a whole-game breakdown),',
    '  write WHERE true.',
    '- Counting or aggregating RALLIES ("how many rallies …", average rally',
    '  length): every shot in a rally carries the rally\'s properties, so an',
    '  unanchored count()/avg() counts shots, not rallies. Anchor with',
    '  shot.num = 1 (exactly one shot per rally) alongside the rally',
    '  condition so each rally counts once.',
    '- Computing rates ("how often do we win when …"): if the condition can',
    '  hold at most once per rally (who served, a shot.num = 1 fact), one',
    '  query is enough — avg(<condition>) is a rate (booleans average as',
    '  1/0), and GROUP BY gives per-group rates. But when the condition can',
    '  occur MULTIPLE times in one rally (e.g. "rallies where I hit a',
    '  drop"), a shot-level avg over-counts rallies with several matching',
    '  shots: instead SELECT rally.num, rally.winner with the condition,',
    '  dedupe the rallies yourself, and divide — or run two such queries',
    '  and divide the deduped rally counts. Keep WHERE to exactly the',
    '  rally-membership condition asked about; who won is read from the',
    '  projected rally.winner afterward, never folded into WHERE. Never',
    '  present a shot-weighted average as a per-point rate.',
    '- Use SELECT only when the question asks for values or aggregates',
    '  (counts, averages, a spreadsheet of numbers). Questions that find or',
    '  show shots — including superlatives like "the fastest shot" (use',
    '  ORDER BY … LIMIT) — must NOT have a SELECT clause.',
    '- DEFAULT CONTEXT: a query that selects individual shots (no SELECT/',
    '  GROUP BY) is watched as clips, and each selected shot AUTOMATICALLY',
    '  comes with a one-shot lead-in and lead-out — so DON\'T write CONTEXT',
    '  for a normal clip; just omit it. Write CONTEXT only to CHANGE that',
    '  default: `CONTEXT BEFORE rally` (or a secs/shots/min/max duration) for',
    '  more footage on a side, or `CONTEXT BEFORE 0secs` for no lead-in or',
    '  lead-out at all. The rally form is ONLY for explicit whole-rally-clip',
    '  requests ("as whole-rally clips", "show the full rally around it") —',
    '  "every shot from rallies where …" already selects every shot of those',
    '  rallies, so it takes the default (no CONTEXT clause). Writing ANY',
    '  CONTEXT clause opts out of the ±1',
    '  default — the side you don\'t write becomes 0. SELECT / aggregate /',
    '  GROUP BY / count queries return rows, not clips, so they take NO',
    '  CONTEXT. CONTEXT never changes which shots match: to SELECT the shot',
    '  before/after an event, put a shot[1]/shot[-1] condition in WHERE (the',
    '  shot right before a winner: WHERE exists(shot[1].winnerType)).',
    '- "First/second half of the game" has two readings. By the clock,',
    '  compare shot.hitTime against the game\'s midpoint:',
    '  shot.hitTime >= game.startTime + game.duration / 2 (game.startTime/',
    '  game.endTime bound the rallies). By rally count, compare rally.num',
    '  against game.numRallies / 2 (rally.num > game.numRallies / 2). Use',
    '  the clock for time questions ("the last ten minutes", "late in the',
    '  video"), rally counts for rally-position questions ("the last five',
    '  rallies", "the game\'s second half of points").',
    '- Relative references work on both axes: shot[-1]/shot[1] address the',
    '  previous/next shot within the rally, and rally[-1]/rally[1] address',
    '  the previous/next rally within the game (e.g. rally[-1].winner is who',
    '  won the prior rally) — use them instead of arithmetic on shot.num or',
    '  rally.num.',
    '- Players are values you navigate to. Three roots: `me` (the asker),',
    '  `player("Name")` (the player listed under that name, e.g.',
    '  player("Chris").team), and a shot\'s hitter, `shot.hitter` (also',
    '  `shot[k].hitter`, e.g. `shot[1].hitter` targets the next shot\'s',
    '  hitter). From any player step to a related player: .teammate,',
    '  .opponent1, .opponent2, .opponentLHS, .opponentRHS (e.g. me.teammate,',
    '  shot.hitter.opponentLHS). Then read a player scalar (.name,',
    '  .team (0|1), .feetToKitchen, .pos.x, …) or stop',
    '  at the player to compare identities with = / != (shot.hitter = me,',
    '  shot[1].hitter.name = "Joe"). taggedWith is a player/shot method',
    '  (shot.hitter.taggedWith("Anna*")).',
    '- Never compare a team with a number (rally.winner = 0 is an error):',
    '  team 0 is whoever played one side of THAT video, so it can be',
    '  different people in each game. Name the team through a player:',
    '  rally.winner = me.team for the asker\'s team, rally.winner =',
    '  shot.hitter.team for the team of the shot\'s hitter (one player\'s win',
    '  rate by shot type is avg(rally.winner = shot.hitter.team) over their',
    '  shots), rally.winner = player("Chris").team for anyone by name.',
    '- Forehand/backhand questions: shot.strokeType needs the hitter\'s',
    '  handedness, which only host-augmented insights carry — it is unknown',
    '  otherwise. shot.strokeSide ("left"/"right" side of the body) always',
    '  works and is usually what "backhand speedups" style questions want',
    '  when handedness data may be missing.',
    '- Where a player STANDS is read off the player (me.feetToKitchen,',
    '  shot.hitter.opponentLHS.feetToNet <= 14 for a player up at the net);',
    '  shot.from/shot.to are where the BALL was hit/landed. Questions about',
    '  hitting at/near a player test that player\'s position properties, not',
    '  shot.to coordinates.',
    '',
    ...(withCli
      ? [
          '## Using the PBQL CLI',
          '',
          "    pbql '<query>' [--me N] [--out json|csv|edl|ffmpeg|se]",
          '',
          '- Each FROM string resolves by one rule: a pb.vision video id with an',
          '  optional 1-based session ("83gyqyc10y8f", "83gyqyc10y8f:2") fetched',
          '  from pb.vision; else an existing file (one insights JSON); else a',
          '  directory (every *.json beneath it, recursively); else a glob',
          '  ("games/*.json").',
          '- Fetched insights are cached with no expiration in $XDG_CACHE_HOME/pbql',
          "  (default ~/.cache/pbql); to refetch, delete the game's file (or the",
          '  whole directory).',
          ''
        ]
      : []),
    '## Data Dictionary',
    ''
  ]
  for (const [objName, entry] of Object.entries(REGISTRY)) {
    for (const r of entry.relationList) {
      parts.push(`- ${objName}.${r.name} (player): ${r.doc}`)
    }
    for (const p of entry.propList) {
      const unit = p.unit ? ` [${p.unit}]` : ''
      parts.push(`- ${objName}.${p.path} (${p.type}${unit}): ${p.doc}`)
    }
    for (const m of entry.methodList) {
      const args = m.args.map(a => a.name).join(', ')
      parts.push(`- ${objName}.${m.name}(${args}) (boolean): ${m.doc}`)
    }
  }
  parts.push('', '## Examples', '')
  for (const { question, query } of readExamples()) {
    parts.push(`Q: ${question}`, '', ...query.split('\n').map(l => '    ' + l), '')
  }
  return parts.join('\n')
}

fs.writeFileSync(path.join(repoRoot, 'docs', 'data-dictionary.md'),
  generateDictionary() + '\n')
fs.writeFileSync(path.join(repoRoot, 'docs', 'llms.txt'),
  generateLlmsTxt() + '\n')
console.log('wrote docs/data-dictionary.md and docs/llms.txt')

// also emit the guide as an importable module so a host app can embed it in
// copyable LLM prompts.
// No consumer of it has a shell, and the CLI section measurably costs
// accuracy, so this copy leaves it out (see generateLlmsTxt).
const guide = generateLlmsTxt({ withCli: false })
fs.writeFileSync(path.join(repoRoot, 'src', 'llm', 'guide.js'),
  '// GENERATED FILE — do not edit. Run `yarn docs` to regenerate from the\n' +
  '// property registry and the example corpus.\n' +
  `export const LLM_GUIDE = ${JSON.stringify(guide)}\n`)
console.log('wrote src/llm/guide.js')
