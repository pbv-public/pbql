// Expression evaluation with SQL/Kleene three-valued logic: missing
// data evaluates to UNKNOWN, which propagates through comparisons and
// arithmetic; WHERE keeps a shot only when the condition is exactly true.
import { REGISTRY } from '../model/registry.js'

export const UNKNOWN = Symbol('pbql.unknown')

// Missing data — an absent value or an explicit JSON null, which the
// insights write interchangeably — and non-finite numbers (JSON like 1e400
// parses to Infinity) surface as UNKNOWN, never as a value. A null that
// slipped through would compare equal to the next null and sort as a value.
const u = value =>
  value === undefined || value === null ||
  (typeof value === 'number' && !Number.isFinite(value))
    ? UNKNOWN
    : value

function comparable (a, b) {
  return typeof a === typeof b
}

function compare (op, a, b) {
  if (a === UNKNOWN || b === UNKNOWN || !comparable(a, b)) {
    return UNKNOWN
  }
  switch (op) {
    case '=': return a === b
    case '!=': return a !== b
    default:
      if (typeof a !== 'number') {
        return UNKNOWN // ordering is defined for numbers only
      }
      switch (op) {
        case '<': return a < b
        case '<=': return a <= b
        case '>': return a > b
        default: return a >= b
      }
  }
}

// The numeric-coercion rule shared by scalar functions, arithmetic, unary
// minus, and the SELECT aggregates: anything but a finite number is UNKNOWN.
export function asNumber (value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : UNKNOWN
}

// The typed path traversal (docs §5.4). Starting from the base — shot[k]/
// rally[k]/game context, or the `me` player — walk the path: while the next
// segment is a relation of the current type (shot→hitter; player→teammate/
// opponent…), advance the player cursor in the appropriate shot context. The
// remaining segments form a scalar-prop path or a method call in the current
// type; zero remaining segments while the cursor is a player is an identity.
function evalProp (node, ctx) {
  const { base } = node
  let type = base.object
  let subCtx = ctx // the shot/rally moment scalar props are measured at
  let playerIdx // set once the cursor sits on a player
  if (base.object === 'player') { // `me` or player("Name")
    playerIdx = base.root === 'me'
      ? ctx.game.myPlayerIdx
      : ctx.game.playerNamed(base.name)
    if (playerIdx === undefined) {
      return UNKNOWN
    }
  } else if (base.object === 'shot') {
    const shotIdx = ctx.shotIdx + base.offset
    const shots = ctx.rally.shots ?? []
    if (shotIdx < 0 || shotIdx >= shots.length) {
      return UNKNOWN
    }
    subCtx = { ...ctx, shot: shots[shotIdx], shotIdx }
  } else if (base.object === 'rally') {
    const rallyIdx = ctx.rallyIdx + base.offset
    const rallies = ctx.game.rallies
    if (rallyIdx < 0 || rallyIdx >= rallies.length) {
      return UNKNOWN
    }
    subCtx = { ...ctx, rally: rallies[rallyIdx], rallyIdx }
  }

  // rally.count(condition): how many of the rally's shots satisfy the
  // condition, which is re-rooted so `shot` (and every position) means
  // each shot of the rally in turn; unknown does not count
  if (node.args !== undefined && base.object === 'rally' &&
      node.path.length === 1 && node.path[0] === 'count') {
    const shots = subCtx.rally.shots ?? []
    let count = 0
    for (let shotIdx = 0; shotIdx < shots.length; shotIdx++) {
      const innerCtx = { ...subCtx, shot: shots[shotIdx], shotIdx }
      if (evalExpr(node.args[0], innerCtx) === true) {
        count++
      }
    }
    return count
  }

  // advance the cursor across leading relation segments
  let i = 0
  while (i < node.path.length) {
    const relation = REGISTRY[type].relations.get(node.path[i])
    if (relation === undefined) {
      break
    }
    const nextIdx = relation.resolve(subCtx, playerIdx)
    // only a real player slot advances the cursor: a null player_id would
    // otherwise navigate (null^1 = 1) and read properties as player "null"
    if (!Number.isInteger(nextIdx)) {
      return UNKNOWN
    }
    playerIdx = nextIdx
    type = 'player'
    i++
  }

  const table = REGISTRY[type]
  const rest = node.path.slice(i)
  if (node.args) { // method call (analyzer guarantees it resolves)
    const method = rest.length === 1 ? table.methods.get(rest[0]) : undefined
    if (method === undefined) {
      return UNKNOWN
    }
    const args = []
    for (const argNode of node.args) {
      const arg = evalExpr(argNode, ctx)
      if (arg === UNKNOWN) {
        return UNKNOWN
      }
      args.push(arg)
    }
    return u(method.apply(subCtx, playerIdx, args))
  }
  if (rest.length === 0) {
    // a path ending AT a player is its identity (so shot.hitter = me works)
    return type === 'player' ? playerIdx : UNKNOWN
  }
  const prop = table.props.get(rest.join('.'))
  if (prop === undefined) {
    return UNKNOWN
  }
  return u(prop.extract(subCtx, playerIdx))
}

// timecode(secs[, withFrames]): a video position formatted as "m:ss"
// (minutes unpadded, seconds floored and 2-padded), or "m:ss:ff" when
// withFrames is true — ff is a 0-based 2-padded frame counter within the
// second, counted at the game's own frame rate (from the insights camera
// data). Negative times, a non-boolean flag, and — when
// frames are requested — a missing or non-positive fps are all UNKNOWN.
function timecode (node, ctx) {
  const secs = asNumber(evalExpr(node.args[0], ctx))
  if (secs === UNKNOWN || secs < 0) {
    return UNKNOWN
  }
  const withFrames = node.args.length === 2 ? evalExpr(node.args[1], ctx) : false
  if (typeof withFrames !== 'boolean') {
    return UNKNOWN
  }
  const pad = n => String(n).padStart(2, '0')
  const base = `${Math.floor(secs / 60)}:${pad(Math.floor(secs) % 60)}`
  if (!withFrames) {
    return base
  }
  // an aggregating projection over zero shots has no game context to read a
  // frame rate from, so frames are unknown there (as they are without fps)
  const fps = ctx?.game.insights.camera?.fps
  if (!Number.isFinite(fps) || fps <= 0) {
    return UNKNOWN
  }
  return `${base}:${pad(Math.floor((secs - Math.floor(secs)) * fps))}`
}

// date(epoch): an epoch-seconds moment as a "YYYY-MM-DD" calendar date in
// the game's meta.tz (an IANA zone the host passes through, e.g. the
// signed-in user's), else the process's own local zone (game.epoch is the
// intended subject: chart labels, grouping shots by day). Epochs beyond
// what Date can represent, and an unrecognized zone, are UNKNOWN -- never
// a date in silently the wrong place.
function localDate (epochSecs, tz) {
  const date = new Date(epochSecs * 1000)
  if (!Number.isFinite(date.getTime())) {
    return UNKNOWN
  }
  try {
    return date.toLocaleDateString('en-CA', { timeZone: tz }) // YYYY-MM-DD
  } catch {
    return UNKNOWN
  }
}

function evalCall (node, ctx) {
  if (node.name === 'exists') {
    return evalExpr(node.args[0], ctx) !== UNKNOWN
  }
  if (node.name === 'timecode') { // numbers in, a string out — its own path
    return timecode(node, ctx)
  }
  const args = []
  for (const argNode of node.args) {
    const value = asNumber(evalExpr(argNode, ctx))
    if (value === UNKNOWN) {
      return UNKNOWN
    }
    args.push(value)
  }
  switch (node.name) {
    case 'min': return Math.min(...args)
    case 'max': return Math.max(...args)
    case 'abs': return Math.abs(args[0])
    case 'kph': return args[0] * 1.609344
    case 'toMs': return args[0] * 1000
    case 'toSecs': return args[0] / 1000
    // with no shot context (an aggregating projection over zero shots) there
    // is no host timezone either, so the process's own local zone applies
    case 'date': return localDate(args[0], ctx?.game.meta.tz)
    default: return UNKNOWN // unknown functions never reach here via runQuery
  }
}

export function evalExpr (node, ctx) {
  switch (node.kind) {
    case 'lit':
      return node.value
    case 'prop':
      return evalProp(node, ctx)
    case 'call':
      return evalCall(node, ctx)
    case 'neg': {
      const value = asNumber(evalExpr(node.arg, ctx))
      return value === UNKNOWN ? UNKNOWN : -value
    }
    case 'arith': {
      const lhs = asNumber(evalExpr(node.lhs, ctx))
      const rhs = asNumber(evalExpr(node.rhs, ctx))
      if (lhs === UNKNOWN || rhs === UNKNOWN) {
        return UNKNOWN
      }
      switch (node.op) {
        case '+': return lhs + rhs
        case '-': return lhs - rhs
        case '*': return lhs * rhs
        default: return rhs === 0 ? UNKNOWN : lhs / rhs
      }
    }
    case 'cmp':
      return compare(node.op, evalExpr(node.lhs, ctx), evalExpr(node.rhs, ctx))
    case 'in': {
      // the spec's OR-chain expansion: x IN (a, b) ≡ x = a OR x = b, with
      // Kleene OR (any true → true; any unknown and no true → unknown)
      const lhs = evalExpr(node.lhs, ctx)
      let sawUnknown = false
      for (const value of node.list) {
        const matches = compare('=', lhs, value)
        if (matches === true) {
          return true
        }
        if (matches !== false) {
          sawUnknown = true
        }
      }
      return sawUnknown ? UNKNOWN : false
    }
    case 'not': {
      const value = evalExpr(node.arg, ctx)
      return typeof value === 'boolean' ? !value : UNKNOWN
    }
    case 'and': {
      let sawUnknown = false
      for (const arg of node.args) {
        const value = evalExpr(arg, ctx)
        if (value === false) {
          return false
        }
        if (value !== true) {
          sawUnknown = true
        }
      }
      return sawUnknown ? UNKNOWN : true
    }
    default: { // 'or' is the only remaining kind
      let sawUnknown = false
      for (const arg of node.args) {
        const value = evalExpr(arg, ctx)
        if (value === true) {
          return true
        }
        if (value !== false) {
          sawUnknown = true
        }
      }
      return sawUnknown ? UNKNOWN : false
    }
  }
}
