// runQuery: the engine's public entry point. The caller supplies the games
// to search (the host resolves FROM sources to insights JSON — the CLI via
// src/sources/resolve.js); the engine analyzes, filters, orders,
// limits, computes context windows, and projects SELECT.
import { analyze, containsAggregate, isAggregateCall } from '../analyze/analyze.js'
import { parse } from '../lang/parse.js'
import { printExpr } from '../lang/print.js'
import { Game, InvalidInsightsError, UnsupportedInsightsError } from '../model/game.js'
import { playerMatchesTag, REGISTRY } from '../model/registry.js'
import { parseVidSource } from '../sources/vid.js'

import { UNKNOWN, asNumber, evalExpr } from './evaluate.js'
import { computeWindow } from './window.js'

// Aggregate coercion: booleans fold to 1/0 so avg(<condition>) is a rate and
// sum(<condition>) counts trues; numbers pass through; strings and other
// non-numbers become UNKNOWN and are skipped (so sum(shot.type) is null).
function aggregateNumber (value) {
  if (typeof value === 'boolean') {
    return value ? 1 : 0
  }
  return asNumber(value)
}

// projected rows carry unknown as JSON null
function nullIfUnknown (value) {
  return value === UNKNOWN ? null : value
}

// one aggregate value over a set of shots; all inputs unknown (or an empty
// set) aggregates to null
function evalAggregate (expr, shots) {
  if (expr.name === 'count') {
    return shots.length
  }
  const values = shots
    .map(ctx => aggregateNumber(evalExpr(expr.args[0], ctx)))
    .filter(v => v !== UNKNOWN) // so avg(<cond>) is a rate, sum(<cond>) a count
  if (values.length === 0) {
    return null
  }
  switch (expr.name) {
    case 'sum': return values.reduce((a, b) => a + b, 0)
    case 'avg': return values.reduce((a, b) => a + b, 0) / values.length
    case 'min': return values.reduce((a, b) => Math.min(a, b))
    default: return values.reduce((a, b) => Math.max(a, b))
  }
}

// Substitutes every aggregate call within an expression with its computed
// value (as a literal), so the surrounding expression can then be evaluated
// by the ordinary evaluator — that is what lets an aggregate be an operand
// (avg(x) * 100). A null aggregate (empty or all-unknown inputs) becomes
// UNKNOWN, which propagates through the arithmetic instead of counting as 0.
function withAggregatesEvaluated (node, shots) {
  if (Array.isArray(node)) {
    return node.map(child => withAggregatesEvaluated(child, shots))
  }
  if (node === null || typeof node !== 'object') {
    return node
  }
  if (isAggregateCall(node)) {
    const value = evalAggregate(node, shots)
    return { kind: 'lit', value: value === null ? UNKNOWN : value }
  }
  const out = {}
  for (const [key, child] of Object.entries(node)) {
    out[key] = withAggregatesEvaluated(child, shots)
  }
  return out
}

// One value for an expression over a set of shots: its aggregates fold over
// the whole set and the rest evaluates against the set's first shot (group
// keys are constant within a group, and an aggregating projection has no
// other per-shot references — the analyzer enforces both).
function evalOverShots (expr, shots) {
  return evalExpr(
    containsAggregate(expr) ? withAggregatesEvaluated(expr, shots) : expr,
    shots[0])
}

function compareValues (a, b) {
  // unknowns sort last regardless of direction (handled by the caller)
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b
  }
  if (typeof a === 'string' && typeof b === 'string') {
    return a < b ? -1 : a > b ? 1 : 0
  }
  /* istanbul ignore else -- every registry property has a uniform type, so
     mixed-type keys can't occur today */
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return Number(a) - Number(b)
  } else {
    return 0 // incomparable values keep their relative order
  }
}

// stable sort by per-item ORDER BY keys; UNKNOWN keys sort last regardless
// of direction
function sortByKeys (items, orderBy, keysOf) {
  const keyed = items.map(item => ({ item, keys: keysOf(item) }))
  keyed.sort((a, b) => {
    for (let i = 0; i < orderBy.length; i++) {
      const ka = a.keys[i]
      const kb = b.keys[i]
      if (ka === UNKNOWN || kb === UNKNOWN) {
        if (ka !== kb) {
          return ka === UNKNOWN ? 1 : -1
        }
        continue
      }
      const cmp = compareValues(ka, kb)
      if (cmp !== 0) {
        return orderBy[i].dir === 'desc' ? -cmp : cmp
      }
    }
    return 0
  })
  return keyed.map(k => k.item)
}

// SELECT * expands to every scalar column of the shot, its rally, and the
// game -- built once from the registry, in dictionary order
const STAR_SELECT = ['shot', 'rally', 'game'].flatMap(object =>
  REGISTRY[object].propList.map(prop => ({
    expr: {
      kind: 'prop',
      base: object === 'game' ? { object } : { object, offset: 0 },
      path: prop.path.split('.')
    },
    label: `${object}.${prop.path}`
  })))

function project (query, selected) {
  const select = query.select === 'star' ? STAR_SELECT : query.select
  const columns = select.map(({ expr, label }) =>
    label ?? printExpr(expr))
  // any aggregate collapses the whole projection to a single row (the
  // analyzer has already rejected per-shot references alongside it)
  const rows = select.some(({ expr }) => containsAggregate(expr))
    ? [select.map(({ expr }) => nullIfUnknown(evalOverShots(expr, selected)))]
    : selected.map(ctx =>
      select.map(({ expr }) => nullIfUnknown(evalExpr(expr, ctx))))
  return { columns, rows }
}

// The documented default row order for GROUP BY: ascending per key
// component with null (unknown) keys last; across types — which a single
// key expression cannot produce today — booleans sort before numbers
// before strings.
const TYPE_RANK = { boolean: 0, number: 1, string: 2 }
function compareKeyValues (a, b) {
  if (a === null || b === null) {
    return a === b ? 0 : a === null ? 1 : -1
  }
  const rank = TYPE_RANK[typeof a] - TYPE_RANK[typeof b]
  /* istanbul ignore next -- every expression has one runtime value type, so
     a key column never mixes types today */
  if (rank !== 0) {
    return rank
  }
  return compareValues(a, b)
}

function compareKeyTuples (a, b) {
  let cmp = 0
  for (let i = 0; cmp === 0 && i < a.length; i++) {
    cmp = compareKeyValues(a[i], b[i])
  }
  return cmp
}

// GROUP BY: partition the WHERE-selected shots by their key tuple, then
// evaluate SELECT once per group. Unknown key values become null (shots
// sharing the null-extended tuple form one group — never dropped). Group
// keys are constant within a group, so they read off its first member;
// aggregates run over the members. Without ORDER BY, rows sort ascending by
// key tuple (compareKeyValues); ORDER BY sorts rows by its aggregate/key
// expressions; LIMIT keeps the first rows.
function projectGrouped (query, selected) {
  const groups = new Map() // serialized key tuple → { keyValues, members }
  for (const ctx of selected) {
    const keyValues = query.groupBy.map(expr => {
      const value = evalExpr(expr, ctx)
      return value === UNKNOWN ? null : value
    })
    const id = JSON.stringify(keyValues)
    if (!groups.has(id)) {
      groups.set(id, { keyValues, members: [] })
    }
    groups.get(id).members.push(ctx)
  }
  // the analyzer guarantees every SELECT/ORDER BY expr is built from
  // aggregates (folded over the group) and group keys (constant within it)
  const valueOf = (expr, group) =>
    nullIfUnknown(evalOverShots(expr, group.members))
  let rows = [...groups.values()]
  if (query.having) {
    // a group whose condition is unknown — an aggregate over empty or
    // all-unknown inputs, say — filters out, exactly like WHERE
    rows = rows.filter(group =>
      evalOverShots(query.having, group.members) === true)
  }
  rows = query.orderBy
    ? sortByKeys(rows, query.orderBy, group => query.orderBy.map(({ expr }) => {
      const value = valueOf(expr, group)
      return value === null ? UNKNOWN : value // nulls sort last either way
    }))
    : rows.sort((a, b) => compareKeyTuples(a.keyValues, b.keyValues))
  if (query.limit !== null) {
    rows = rows.slice(0, query.limit)
  }
  return {
    columns: query.select.map(({ expr, label }) => label ?? printExpr(expr)),
    rows: rows.map(group => query.select.map(({ expr }) => valueOf(expr, group)))
  }
}

// Collects the facts about a query that depend on per-game player metadata:
// whether it references "me"/"my…" (needs meta.myPlayerIdx), each player("Name")
// (needs exactly one player of that name in the game) and each literal
// taggedWith() pattern (needs a matching tagged player in the game).
function collectPlayerFacts (node, facts) {
  if (Array.isArray(node)) {
    node.forEach(item => collectPlayerFacts(item, facts))
    return
  }
  if (node === null || typeof node !== 'object') {
    return
  }
  if (node.kind === 'prop') {
    const { base } = node
    if (base.object === 'player' && base.root === 'me') {
      facts.referencesMe = true
    } else if (base.object === 'player') {
      facts.playerNames.add(base.name)
    }
    // taggedWith is always the final path segment of a method call; the
    // analyzer has already held its argument to a string, so a literal
    // one here is a pattern this game either holds or does not
    if (node.args && node.path[node.path.length - 1] === 'taggedWith' &&
        node.args[0].kind === 'lit') {
      facts.tagPatterns.add(node.args[0].value)
    }
  }
  for (const value of Object.values(node)) {
    collectPlayerFacts(value, facts)
  }
}

// Per-game warnings for player references the game cannot resolve. These are
// additive: the conditions still evaluate to unknown and simply never
// match — the warnings tell the user why (hosts show them like validation
// errors).
function playerWarnings (facts, game) {
  const warnings = []
  const warn = (code, message) =>
    warnings.push({ vid: game.vid, sessionIdx: game.sessionIdx, code, message })
  if (facts.referencesMe && game.myPlayerIdx === undefined) {
    warn('PBQL_ME_NOT_TAGGED',
      '"me" is not tagged in this game, so conditions using "me" or "my…" ' +
      'players are unknown here')
  }
  for (const name of facts.playerNames) {
    const count = game.playersNamed(name).length
    if (count === 0) {
      warn('PBQL_PLAYER_NOT_FOUND',
        `no player in this game is named "${name}", so player("${name}") is ` +
        'unknown here')
    } else if (count > 1) {
      warn('PBQL_PLAYER_AMBIGUOUS',
        `${count} players in this game are named "${name}", so ` +
        `player("${name}") is unknown here`)
    }
  }
  for (const pattern of facts.tagPatterns) {
    const matches = [0, 1, 2, 3].some(playerIdx =>
      playerMatchesTag({ game }, playerIdx, pattern) === true)
    if (!matches) {
      warn('PBQL_TAG_NOT_FOUND',
        `no player in this game matches taggedWith("${pattern}"), so it is ` +
        'unknown here')
    }
  }
  return warnings
}

/**
 * The games a UNION branch's own FROM names, out of everything the host
 * resolved for the whole query.
 *
 * A branch is semantically "FROM everything WHERE it came from my
 * sources AND <my where>", so its FROM acts as an implicit filter. Only
 * vid-shaped and file-shaped sources can be matched here: a directory or
 * glob expands host-side into games this layer never sees the names of,
 * so a branch naming one keeps every game rather than silently losing
 * rows.
 */
export function gamesForBranch (query, wrapped) {
  const wanted = []
  for (const source of query.sources) {
    const ref = parseVidSource(source)
    if (ref !== null) {
      wanted.push(`${ref.vid}:${ref.sessionIdx}`)
      continue
    }
    // a glob or a directory expands host-side into games whose names
    // this layer never sees, so narrowing would silently drop rows
    const file = /[*?[\]]/.test(source)
      ? null
      : source.match(/([^/\\]+)\.json$/)
    if (file === null) {
      return wrapped
    }
    wanted.push(`${file[1]}:0`)
  }
  const keep = new Set(wanted)
  return wrapped.filter(game => keep.has(`${game.vid}:${game.sessionIdx}`))
}

/**
 * Rows and shots of every branch, in order, with UNION's de-duplication.
 *
 * Branch shapes must agree: rows unioned with rows, clips with clips.
 * Mixing them has no meaningful answer, so it is an error rather than a
 * guess.
 */
export function combineBranches (results) {
  const projected = results.map(r => r.columns !== undefined)
  if (new Set(projected).size > 1) {
    return {
      errors: [{
        code: 'PBQL_UNION_SHAPE',
        message: 'UNION needs every branch to be the same shape: either ' +
          'all of them SELECT columns, or none of them do',
        line: 1,
        col: 1,
        length: 0
      }]
    }
  }
  const widths = new Set(results.map(r => r.columns?.length).filter(Boolean))
  if (widths.size > 1) {
    return {
      errors: [{
        code: 'PBQL_UNION_WIDTH',
        message: 'UNION needs every branch to select the same number of ' +
          `columns (got ${[...widths].sort().join(' and ')})`,
        line: 1,
        col: 1,
        length: 0
      }]
    }
  }
  return { ok: true }
}

/**
 * Runs a PBQL query over the given games.
 * @param {object} args
 * @param {string} args.text the query text
 * @param {Array<object>} args.games the games to search, as plain
 *   {vid, sessionIdx, insights, meta} descriptors (the engine wraps them);
 *   games whose insights version is unsupported are skipped and reported in
 *   warnings
 * @returns {{shots: Array, columns?: Array, rows?: Array,
 *   warnings: Array} | {errors: Array}} results, or lex/parse/analyze errors
 */
export function runQuery ({ text, games }) {
  const parsed = parse(text)
  if (parsed.errors) {
    return { errors: parsed.errors }
  }
  const branches = parsed.ast.kind === 'union'
    ? parsed.ast.branches
    : [{ query: parsed.ast, all: true }]
  const errors = analyze(parsed.ast).errors
  if (errors.length > 0) {
    return { errors }
  }

  const warnings = []
  const wrapped = []
  for (const game of games) {
    try {
      wrapped.push(new Game(game))
    } catch (err) {
      /* istanbul ignore next -- only insights problems are expected here */
      if (!(err instanceof UnsupportedInsightsError) &&
          !(err instanceof InvalidInsightsError)) {
        throw err
      }
      warnings.push({
        vid: game.vid,
        sessionIdx: game.sessionIdx,
        code: err.code,
        message: err.message
      })
    }
  }

  // Only a union narrows games per branch. A single query keeps the old
  // contract exactly: the host resolved FROM and passed the games it
  // meant, and second-guessing that here would change every existing
  // caller's results, not just the new ones.
  const results = branches.map(({ query }) => runBranch(
    query,
    branches.length > 1 ? gamesForBranch(query, wrapped) : wrapped,
    warnings))
  const shape = combineBranches(results)
  if (shape.errors) {
    return { errors: shape.errors }
  }
  return mergeResults(branches, results, warnings)
}

/** One branch's own selection, projection and window, over its own games. */
function runBranch (query, wrapped, warnings) {
  // warn per game about player references that cannot resolve there (the
  // conditions themselves still evaluate to unknown — see playerWarnings)
  const facts = {
    referencesMe: false, playerNames: new Set(), tagPatterns: new Set()
  }
  for (const part of [query.where, query.select, query.groupBy, query.orderBy]) {
    collectPlayerFacts(part, facts)
  }
  for (const game of wrapped) {
    warnings.push(...playerWarnings(facts, game))
  }

  let selected = []
  for (const game of wrapped) {
    for (const ctx of game.shotRefs) {
      if (evalExpr(query.where, ctx) === true) {
        selected.push(ctx)
      }
    }
  }

  // with GROUP BY, ORDER BY and LIMIT act on the grouped rows instead
  // (inside projectGrouped); the shots themselves keep video order
  if (!query.groupBy) {
    if (query.orderBy) {
      selected = sortByKeys(selected, query.orderBy, ctx =>
        query.orderBy.map(({ expr }) => evalExpr(expr, ctx)))
    }
    if (query.limit !== null) {
      selected = selected.slice(0, query.limit)
    }
  }

  const shots = selected.map(ctx => {
    const { sMs, eMs, contextShots } = computeWindow(ctx, query.context)
    return {
      vid: ctx.game.vid,
      sessionIdx: ctx.game.sessionIdx,
      rallyIdx: ctx.rallyIdx,
      shotIdx: ctx.shotIdx,
      hitMs: ctx.game.hitMs(ctx.shot),
      window: { sMs, eMs },
      contextShots
    }
  })

  const result = { shots, context: query.context }
  if (query.groupBy) {
    const { columns, rows } = projectGrouped(query, selected)
    result.columns = columns
    result.rows = rows
  } else if (query.select) {
    const { columns, rows } = project(query, selected)
    result.columns = columns
    result.rows = rows
  }
  return result
}

/**
 * The branches as one result.
 *
 * Column NAMES come from the first branch, the way SQL does it: later
 * branches supply rows, not headings, so a second branch that forgot its
 * aliases still lines up. A branch written without ALL de-duplicates its
 * own rows against everything already accumulated.
 */
function mergeResults (branches, results, warnings) {
  // the resolved context durations ride along so hosts can see the effective
  // window settings (a bare shot-list defaults to a ±1-shot lead-in/lead-out;
  // projections and a written-but-one-sided clause default the rest to 0secs)
  const merged = { shots: [], warnings, context: results[0].context }
  const projected = results[0].columns !== undefined
  if (projected) {
    merged.columns = results[0].columns
    merged.rows = []
  }
  const seenRows = new Set()
  const seenShots = new Set()
  results.forEach((result, at) => {
    const all = branches[at].all
    for (const row of result.rows ?? []) {
      const key = JSON.stringify(row)
      if (!all && seenRows.has(key)) {
        continue
      }
      seenRows.add(key)
      merged.rows.push(row)
    }
    for (const shot of result.shots) {
      const key = `${shot.vid}:${shot.sessionIdx}:${shot.rallyIdx}:${shot.shotIdx}`
      if (!all && seenShots.has(key)) {
        continue
      }
      seenShots.add(key)
      merged.shots.push(shot)
    }
  })
  return merged
}
