// Semantic validation of a parsed query against the property registry:
// unknown properties/methods/functions (with nearest-match suggestions),
// arity problems, obvious type mismatches, and the GROUP BY rules. Alias
// spellings are canonicalized earlier, by the grammar itself.
import { printExpr } from '../lang/print.js'
import { REGISTRY, walkRelations } from '../model/registry.js'

// scalar functions usable anywhere; SELECT additionally allows aggregates
export const SCALAR_FNS = new Map([
  ['min', { minArgs: 2, maxArgs: Infinity }],
  ['max', { minArgs: 2, maxArgs: Infinity }],
  ['abs', { minArgs: 1, maxArgs: 1 }],
  ['exists', { minArgs: 1, maxArgs: 1 }],
  // unit conversions: mph→km/h, seconds→ms, ms→seconds ("secs"/"ms"
  // themselves are duration-unit keywords, hence the to- prefix)
  ['kph', { minArgs: 1, maxArgs: 1 }],
  ['toMs', { minArgs: 1, maxArgs: 1 }],
  ['toSecs', { minArgs: 1, maxArgs: 1 }],
  // timecode(secs[, withFrames]) formats a video position as an "m:ss"
  // string ("m:ss:ff" with withFrames — see the engine for the semantics)
  ['timecode', { minArgs: 1, maxArgs: 2 }],
  // date(epoch) formats an epoch-seconds moment (like game.epoch) as a
  // local "YYYY-MM-DD" string
  ['date', { minArgs: 1, maxArgs: 1 }]
])
export const AGGREGATE_FNS = new Map([
  ['count', { minArgs: 0, maxArgs: 0 }],
  ['sum', { minArgs: 1, maxArgs: 1 }],
  ['avg', { minArgs: 1, maxArgs: 1 }],
  ['min', { minArgs: 1, maxArgs: 1 }],
  ['max', { minArgs: 1, maxArgs: 1 }]
])

// An aggregate-shaped call: one of the row-collapsing functions at its
// aggregate arity (count() alone is 0-ary; min/max with 2+ args are the
// scalar functions). The analyzer and the engine share this test.
export function isAggregateCall (expr) {
  return expr.kind === 'call' && AGGREGATE_FNS.has(expr.name) &&
    expr.args.length === (expr.name === 'count' ? 0 : 1)
}

// Whether an aggregate appears anywhere within an expression. An aggregate
// may be an operand of a larger expression (avg(x) * 100), so "does this
// aggregate?" is a question about the whole tree, not just its root.
export function containsAggregate (node) {
  if (Array.isArray(node)) {
    return node.some(containsAggregate)
  }
  if (node === null || typeof node !== 'object') {
    return false
  }
  // loc objects and IN lists hold no nodes, so visiting them is harmless
  return isAggregateCall(node) || containsAggregate(Object.values(node))
}

// The first per-shot reference (a property or a method call) OUTSIDE every
// aggregate of the expression, or undefined. An aggregate's own argument is
// per-shot by design, so it is skipped.
function firstShotRef (node) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = firstShotRef(child)
      if (found !== undefined) {
        return found
      }
    }
    return undefined
  }
  if (node === null || typeof node !== 'object' || isAggregateCall(node)) {
    return undefined
  }
  return node.kind === 'prop' ? node : firstShotRef(Object.values(node))
}

// structural AST equality ignoring source positions — the GROUP BY rule:
// a SELECT/ORDER BY expression "is" a group key when the trees match
function sameExpr (a, b) {
  const strip = node => JSON.stringify(node, (key, value) =>
    key === 'loc' ? undefined : value)
  return strip(a) === strip(b)
}

function levenshtein (a, b) {
  const rows = [[...Array(b.length + 1).keys()]]
  for (let i = 1; i <= a.length; i++) {
    rows.push([i])
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
  }
  return rows[a.length][b.length]
}

function suggest (name, candidates) {
  let best
  let bestDist = Infinity
  for (const candidate of candidates) {
    const dist = levenshtein(name.toLowerCase(), candidate.toLowerCase())
    if (dist < bestDist) {
      bestDist = dist
      best = candidate
    }
  }
  // allow more edits for longer names (taggedAs → taggedWith is distance 4)
  return best !== undefined &&
    bestDist <= Math.max(3, Math.floor(best.length / 2))
    ? best
    : undefined
}

// A unit string made solely of quoted alternatives ('"dig"|"neutral"|…') or
// of integer alternatives ('0|1', a team) declares the property's complete
// enum — production never emits anything else, so the analyzer rejects other
// literals outright. Any other unit (a measure like 'feet', a range like
// '0-1') returns undefined.
export function enumValuesOf (unit) {
  if (unit === undefined) {
    return undefined
  }
  if (/^"[^"]+"(\|"[^"]+")*$/.test(unit)) {
    return unit.slice(1, -1).split('"|"')
  }
  return /^\d+(\|\d+)+$/.test(unit) ? unit.split('|').map(Number) : undefined
}

// the enum of a scalar-property reference, or undefined for anything else
function enumOf (node) {
  if (node.kind !== 'prop' || node.args) {
    return undefined
  }
  const { typeName, rest } = walkRelations(node.base, node.path)
  return enumValuesOf(REGISTRY[typeName].props.get(rest.join('.'))?.unit)
}

function inferType (node) {
  switch (node.kind) {
    case 'lit': return typeof node.value
    case 'arith':
    case 'neg': return 'number'
    case 'prop': {
      const { typeName, rest } = walkRelations(node.base, node.path)
      if (node.args) {
        // most methods stay untyped (boolean, comparing loosely); a method
        // that declares a result type (rally.count -> number) reports it
        const method = rest.length === 1
          ? REGISTRY[typeName].methods.get(rest[0])
          : undefined
        return method?.type
      }
      if (rest.length === 0) {
        // a path ending at a player is its identity, which compares only
        // with another player (a bare shot/rally is reported elsewhere)
        return typeName === 'player' ? 'player' : undefined
      }
      return REGISTRY[typeName].props.get(rest.join('.'))?.type
    }
    // timecode() and date() are the string-valued functions; the rest stay
    // untyped (min/max double as duration combinators, exists/methods are
    // boolean)
    case 'call':
      return ['timecode', 'date'].includes(node.name) ? 'string' : undefined
    default: return undefined
  }
}

// walks an expression, invoking fn on every rally.count(...) node within
function forEachRallyCount (node, fn) {
  if (node === undefined || typeof node !== 'object') {
    return
  }
  if (node.kind === 'prop' && node.args !== undefined &&
      node.base.object === 'rally' &&
      node.path.length === 1 && node.path[0] === 'count') {
    fn(node)
  }
  for (const key of ['arg', 'lhs', 'rhs']) {
    forEachRallyCount(node[key], fn)
  }
  for (const child of node.args ?? []) {
    forEachRallyCount(child, fn)
  }
}

const ORDERING_OPS = new Set(['<', '<=', '>', '>='])

// A projection (SELECT / GROUP BY) returns rows, not clips, so it carries no
// context window and its context stays at the (0secs, 0secs) default. Both
// projection guards use this to reject an explicitly written CONTEXT.
function isDefaultContext ({ before, after }) {
  const isZero = d => d.kind === 'dur' && d.unit === 'secs' && d.value === 0
  return isZero(before) && isZero(after)
}

export function analyze (query) {
  // A UNION is its branches, each a whole query analyzed on its own; their
  // positions already point into the shared text. Whether the branches'
  // shapes agree is a property of their results, which the engine checks
  // once it has them.
  if (query.kind === 'union') {
    return { errors: query.branches.flatMap(b => analyze(b.query).errors) }
  }
  const errors = []
  const err = (node, code, message, hint) => {
    errors.push({
      code,
      message,
      line: node.loc?.line ?? 1,
      col: node.loc?.col ?? 1,
      length: 0,
      ...(hint === undefined ? {} : { hint })
    })
  }

  // `aggregates` says what an aggregate call means at this point of the
  // tree: true where they are allowed (SELECT items, HAVING, ORDER BY on a
  // grouped query) — at any depth, so avg(x) * 100 works — 'nested' inside
  // an aggregate's own argument (where they cannot go), and false where
  // they were never allowed (WHERE, GROUP BY keys, ungrouped ORDER BY).
  function checkExpr (node, aggregates, existsArg = false) {
    switch (node.kind) {
      case 'lit':
        return
      case 'not':
      case 'neg':
        return checkExpr(node.arg, aggregates)
      case 'and':
      case 'or':
        return node.args.forEach(a => checkExpr(a, aggregates))
      case 'arith':
      case 'cmp': {
        checkExpr(node.lhs, aggregates)
        checkExpr(node.rhs, aggregates)
        if (node.kind === 'cmp') {
          const lhsType = inferType(node.lhs)
          const rhsType = inferType(node.rhs)
          if (lhsType !== undefined && rhsType !== undefined && lhsType !== rhsType) {
            err(node, 'PBQL_TYPE_MISMATCH',
              `cannot compare ${lhsType} with ${rhsType}`,
              playerHint(node.lhs, node.rhs))
          } else if (ORDERING_OPS.has(node.op)) {
            for (const type of [lhsType, rhsType]) {
              if (type !== undefined && type !== 'number') {
                err(node, 'PBQL_TYPE_MISMATCH',
                  `"${node.op}" needs numbers, not ${type}`)
                break
              }
            }
          } else {
            // enum-typed property = / != a string literal, either order
            for (const [subject, lit] of [[node.lhs, node.rhs], [node.rhs, node.lhs]]) {
              const values = enumOf(subject)
              if (values !== undefined && lit.kind === 'lit') {
                checkEnumValue(node, values, printExpr(subject), lit.value)
              }
            }
          }
        }
        return
      }
      case 'in': {
        checkExpr(node.lhs, aggregates)
        const lhsType = inferType(node.lhs)
        for (const value of node.list) {
          // eslint-disable-next-line valid-typeof -- lhsType is a typeof string
          if (lhsType !== undefined && typeof value !== lhsType) {
            err(node, 'PBQL_TYPE_MISMATCH',
              `IN list mixes ${typeof value} with ${lhsType}`,
              playerHint(node.lhs))
            break
          }
        }
        const values = enumOf(node.lhs)
        for (const value of values === undefined ? [] : node.list) {
          if (checkEnumValue(node, values, printExpr(node.lhs), value)) {
            break
          }
        }
        return
      }
      case 'prop': {
        const { typeName, rest } = walkRelations(node.base, node.path)
        const table = REGISTRY[typeName]
        if (node.args) {
          node.args.forEach(a => checkExpr(a, aggregates))
          if (rest.length === 0) {
            // the path ended at a relation (shot.hitter(…), me.teammate(…)):
            // a relation names a player, it is not callable
            const ref = printExpr({ ...node, args: undefined })
            err(node, 'PBQL_UNKNOWN_METHOD',
              `${ref} is a player, not a method`,
              `call a player method on it (e.g. ${ref}.taggedWith("Alex")) ` +
              `or compare it (e.g. ${ref} = me)`)
            return
          }
          const name = rest[rest.length - 1]
          const method = rest.length === 1 ? table.methods.get(name) : undefined
          if (method === undefined) {
            err(node, 'PBQL_UNKNOWN_METHOD',
              `${typeName} has no method "${rest.join('.')}"`,
              hintFor(name, [...table.methods.keys(), ...table.relations.keys()]))
          } else if (node.args.length !== method.args.length) {
            err(node, 'PBQL_BAD_ARITY',
              `${name}() takes ${method.args.length} argument(s), got ${node.args.length}`)
          } else {
            method.args.forEach((spec, i) => {
              // a condition argument is a nested boolean expression; one
              // level only -- rally.count inside rally.count is an error
              if (spec.type === 'condition') {
                forEachRallyCount(node.args[i], inner =>
                  err(inner, 'PBQL_NESTED_COUNT',
                    'rally.count() cannot appear inside a rally.count() ' +
                    'condition'))
                return
              }
              // a declared argument type is enforced like a comparison's;
              // expressions of unknown type pass (they evaluate per the
              // Kleene rules)
              const argType = inferType(node.args[i])
              if (argType !== undefined && argType !== spec.type) {
                err(node, 'PBQL_TYPE_MISMATCH',
                  `${name}() takes a ${spec.type} ${spec.name}, not ${argType}`)
                return
              }
              // enum-typed arguments only accept their declared values
              const values = enumValuesOf(spec.unit)
              if (values !== undefined && node.args[i].kind === 'lit') {
                checkEnumValue(node.args[i], values, `${name}() ${spec.name}`,
                  node.args[i].value)
              }
            })
          }
          return
        }
        if (rest.length === 0) {
          // a path ending AT a player is an identity value; a bare shot/
          // rally/game is not a value
          if (typeName !== 'player') {
            const ref = printExpr(node)
            err(node, 'PBQL_MISSING_PROPERTY',
              `select a property of ${typeName} (e.g. ${typeName}.num)`,
              // exists() probes a property; shot/rally references are
              // probed via .num, which is always present when the
              // reference is in range
              existsArg && typeName !== 'game'
                ? `to test whether ${ref} exists, use exists(${ref}.num) ` +
                  '(num is always present when the reference is in range)'
                : undefined)
          }
          return
        }
        const key = rest.join('.')
        if (!table.props.has(key)) {
          err(node, 'PBQL_UNKNOWN_PROPERTY',
            `${typeName} has no property "${key}"`,
            hintFor(key, [...table.props.keys(), ...table.methods.keys(),
              ...table.relations.keys()]))
        }
        return
      }
      case 'call':
        return checkCall(node, aggregates)
    }
  }

  function checkCall (node, aggregates) {
    const scalar = SCALAR_FNS.get(node.name)
    const aggregate = aggregates === true ? AGGREGATE_FNS.get(node.name) : undefined
    const fits = fn => fn !== undefined &&
      node.args.length >= fn.minArgs && node.args.length <= fn.maxArgs
    // an aggregate folds many shots into one value, so its argument is an
    // ordinary per-shot expression: aggregates cannot nest
    node.args.forEach(a =>
      checkExpr(a, fits(aggregate) ? 'nested' : aggregates, node.name === 'exists'))
    if (aggregates === 'nested' && isAggregateCall(node)) {
      err(node, 'PBQL_NESTED_AGGREGATE',
        `${node.name}() cannot appear inside another aggregate`)
      return
    }
    if (fits(aggregate) || fits(scalar)) {
      // timecode's second argument is the withFrames flag; expressions of
      // unknown type pass (they evaluate per the Kleene rules)
      if (node.name === 'timecode' && node.args.length === 2) {
        const argType = inferType(node.args[1])
        if (argType !== undefined && argType !== 'boolean') {
          err(node.args[1], 'PBQL_TYPE_MISMATCH',
            `timecode() takes a boolean second argument, not ${argType}`)
        }
      }
      return
    }
    if (scalar === undefined && aggregate === undefined) {
      err(node, 'PBQL_UNKNOWN_FUNCTION', `unknown function "${node.name}"`,
        hintFor(node.name, [
          ...SCALAR_FNS.keys(),
          ...(aggregates === true ? AGGREGATE_FNS.keys() : [])
        ]))
    } else {
      err(node, 'PBQL_BAD_ARITY',
        `${node.name}() cannot take ${node.args.length} argument(s) here`)
    }
  }

  function hintFor (name, candidates) {
    const match = suggest(name, candidates)
    return match === undefined ? undefined : `did you mean "${match}"?`
  }

  // A player is an identity, not its id or name: steer a player compared
  // with a literal (shot.hitter = 3) to another player or to a property
  function playerHint (...sides) {
    const player = sides.find(side => inferType(side) === 'player')
    if (player === undefined) {
      return undefined
    }
    const ref = printExpr(player)
    return 'a player compares only with another player (e.g. shot.hitter = ' +
      `me); to compare a value, read one of its properties (e.g. ${ref}.id, ` +
      `${ref}.name, ${ref}.team)`
  }

  // Flags a literal an enum-typed subject can never hold (production never
  // writes it, so the comparison could only ever be false/unknown). A
  // literal of another type is left to the type checks. Returns whether an
  // error was reported.
  function checkEnumValue (node, values, subject, value) {
    if (typeof value !== typeof values[0] || values.includes(value)) {
      return false
    }
    err(node, 'PBQL_UNKNOWN_ENUM_VALUE',
      `${subject} is never ${JSON.stringify(value)} ` +
      `(valid: ${values.map(v => JSON.stringify(v)).join(', ')})`,
      typeof value === 'string' ? hintFor(value, values) : undefined)
    return true
  }

  // GROUP BY output is one row per group, so it needs a SELECT, cannot
  // carry per-shot context windows, and holds every SELECT and ORDER BY
  // expression to an aggregate or one of the group keys
  function checkGrouping () {
    const { groupBy } = query
    if (query.select === null) {
      err(groupBy[0], 'PBQL_GROUP_BY_NO_SELECT',
        'GROUP BY produces rows, not shots: add a SELECT of aggregates ' +
        'and/or group keys')
    }
    if (!isDefaultContext(query.context)) {
      err(groupBy[0], 'PBQL_GROUP_BY_CONTEXT',
        'CONTEXT cannot be combined with GROUP BY: grouped results are ' +
        'rows, not shots')
    }
    const isKey = expr => groupBy.some(key => sameExpr(key, expr))
    // Every grouped expression must have one value per group: aggregates
    // and group keys do, and they combine freely (avg(shot.speed) * 2,
    // count() >= 4), but a bare per-shot reference does not. SELECT,
    // ORDER BY and HAVING all answer to this rule.
    const checkGroupedRefs = node => {
      if (node === null || typeof node !== 'object') {
        return
      }
      if (isAggregateCall(node) || isKey(node)) {
        return
      }
      if (node.kind === 'prop') {
        err(node, 'PBQL_NOT_GROUPED',
          `"${printExpr(node)}" must be an aggregate or a GROUP BY key`)
        return
      }
      for (const key of ['arg', 'lhs', 'rhs']) {
        checkGroupedRefs(node[key])
      }
      for (const child of node.args ?? []) {
        checkGroupedRefs(child)
      }
    }
    const selectItems = Array.isArray(query.select) ? query.select : []
    for (const { expr } of [...selectItems, ...(query.orderBy ?? [])]) {
      checkGroupedRefs(expr)
    }
    if (query.having) {
      checkGroupedRefs(query.having)
    }
  }

  // An aggregating SELECT without GROUP BY collapses every shot into ONE
  // row, so a per-shot reference beside (or inside) the aggregates has no
  // single value to report — the ungrouped counterpart of checkGrouping.
  function checkUngroupedAggregates () {
    const select = Array.isArray(query.select) ? query.select : []
    if (!select.some(({ expr }) => containsAggregate(expr))) {
      return
    }
    for (const { expr } of select) {
      const ref = firstShotRef(expr)
      if (ref !== undefined) {
        err(ref, 'PBQL_MIXED_AGGREGATES',
          'SELECT cannot mix aggregate and per-shot expressions ' +
          '(unless the per-shot expressions are GROUP BY keys)')
      }
    }
  }

  const grouped = Boolean(query.groupBy)
  // SELECT * expands to every scalar column at projection time; there are
  // no item expressions to check, and grouping it makes no sense
  if (query.select === 'star' && grouped) {
    err(query.groupBy[0], 'PBQL_STAR_GROUPED',
      'SELECT * lists per-shot columns: with GROUP BY, select aggregates ' +
      'and/or group keys explicitly')
  }
  for (const item of Array.isArray(query.select) ? query.select : []) {
    checkExpr(item.expr, true)
  }
  checkExpr(query.where, false)
  for (const key of query.groupBy ?? []) {
    checkExpr(key, false) // keys are per-shot values; aggregates can't nest
  }
  for (const item of query.orderBy ?? []) {
    checkExpr(item.expr, grouped) // grouped rows may order by aggregates
  }
  if (query.having) {
    checkExpr(query.having, true) // aggregates anywhere in the condition
    if (!grouped) {
      err(query.having, 'PBQL_HAVING_NO_GROUP_BY',
        'HAVING filters grouped rows: add a GROUP BY (or move the ' +
        'condition into WHERE)')
    }
  }
  if (grouped) {
    checkGrouping()
  } else {
    checkUngroupedAggregates()
    if (query.select && !isDefaultContext(query.context)) {
      // a plain projection has no clips either, so CONTEXT is meaningless
      const at = query.select === 'star' ? query.where : query.select[0].expr
      err(at, 'PBQL_SELECT_CONTEXT',
        'CONTEXT applies to shot clips, not SELECT results')
    }
  }
  return { errors }
}
