// Property-based roundtrip: for any canonical AST, print() then parse()
// yields the same AST (and never an ambiguous or failed parse).
import * as fc from 'fast-check'

import { parse, print } from '../src/index.js'

import { stripLoc } from './helpers.js'

const identArb = fc.constantFrom('speed', 'isVolley', 'quality', 'x', 'foo_2')
// includes keywords (legal path segments) and player relation/root names
// (`hitter`, `teammate`, `me`, …), which are ordinary segments in the AST
const segArb = fc.constantFrom(
  'speed', 'overall', 'video', 'true', 'from', 'secs',
  'hitter', 'teammate', 'opponentLHS', 'me', 'player')
const stringArb = fc.stringMatching(/^[ -~]{0,12}$/) // printable ascii incl. " and \
const numberArb = fc.oneof(
  fc.integer({ min: 0, max: 9999 }),
  fc.integer({ min: 0, max: 99999 }).map(n => n / 10),
  // extreme magnitudes (1e-7, 1e21, denormals, …) must print decimal-only:
  // the lexer has no e-notation, so the printer expands the exponent
  fc.double({ min: 0, noNaN: true, noDefaultInfinity: true })
    .map(n => (Object.is(n, -0) ? 0 : n)))
const literalArb = fc.oneof(numberArb, stringArb, fc.boolean())
// IN lists additionally admit signed numeric literals (never -0: it prints
// as "0", which reparses as +0)
const inLiteralArb = fc.oneof(
  literalArb,
  numberArb.map(n => -n).filter(n => !Object.is(n, -0)))

const baseArb = fc.oneof(
  fc.record({ object: fc.constant('game') }),
  // the player roots are `me` and player("Name"); hitter/teammate/
  // opponent… ride in the path
  fc.record({ object: fc.constant('player'), root: fc.constant('me') }),
  fc.record({
    object: fc.constant('player'), root: fc.constant('player'), name: stringArb
  }),
  fc.record({
    object: fc.constantFrom('shot', 'rally'),
    offset: fc.integer({ min: -3, max: 3 })
  }))

const litNodeArb = literalArb.map(value => ({ kind: 'lit', value }))

const { expr: exprArb } = fc.letrec(tie => ({
  prop: fc.record({
    base: baseArb,
    path: fc.array(segArb, { minLength: 0, maxLength: 3 }),
    args: fc.option(fc.array(litNodeArb, { maxLength: 2 }), { nil: undefined })
  }).map(({ base, path, args }) => {
    const node = { kind: 'prop', base, path }
    if (args !== undefined && path.length > 0) {
      node.args = args // methods require a non-empty path
    }
    return node
  }),
  call: fc.record({
    name: identArb,
    args: fc.array(tie('atom'), { maxLength: 2 })
  }).map(({ name, args }) => ({ kind: 'call', name, args })),
  atom: fc.oneof(litNodeArb, tie('prop'), tie('call')),
  arith: fc.record({
    op: fc.constantFrom('+', '-', '*', '/'),
    lhs: tie('numeric'),
    rhs: tie('numeric')
  }).map(n => ({ kind: 'arith', ...n })),
  neg: tie('numeric').map(arg => ({ kind: 'neg', arg })),
  numeric: fc.oneof(
    { maxDepth: 3, withCrossShrink: true },
    tie('atom'), tie('arith'), tie('neg')),
  cmp: fc.record({
    op: fc.constantFrom('=', '!=', '<', '<=', '>', '>='),
    lhs: tie('numeric'),
    rhs: tie('numeric')
  }).map(n => ({ kind: 'cmp', ...n })),
  inNode: fc.record({
    lhs: tie('numeric'),
    list: fc.array(inLiteralArb, { minLength: 1, maxLength: 3 })
  }).map(n => ({ kind: 'in', ...n })),
  not: tie('bool').map(arg => ({ kind: 'not', arg })),
  // canonical junctions never directly nest their own kind (the grammar
  // flattens them), so generate args of any *other* kind
  and: fc.array(fc.oneof(tie('bool'), tie('or')), { minLength: 2, maxLength: 3 })
    .filter(args => args.every(a => a.kind !== 'and'))
    .map(args => ({ kind: 'and', args })),
  or: fc.array(tie('bool'), { minLength: 2, maxLength: 3 })
    .filter(args => args.every(a => a.kind !== 'or'))
    .map(args => ({ kind: 'or', args })),
  bool: fc.oneof(
    { maxDepth: 4, withCrossShrink: true },
    tie('atom'), tie('cmp'), tie('inNode'), tie('not'), tie('and')),
  expr: fc.oneof(tie('bool'), tie('or'), tie('numeric'))
}))

const durArb = fc.letrec(tie => ({
  dur: fc.oneof(
    fc.record({
      kind: fc.constant('dur'),
      unit: fc.constant('secs'),
      value: numberArb
    }),
    fc.record({
      kind: fc.constant('dur'),
      unit: fc.constant('shots'),
      value: fc.integer({ min: 0, max: 99 })
    }),
    fc.constant({ kind: 'dur', unit: 'rally' }),
    fc.record({
      kind: fc.constant('durfn'),
      fn: fc.constantFrom('min', 'max'),
      args: fc.tuple(tie('simple'), tie('simple'))
    })),
  simple: fc.oneof(
    fc.record({
      kind: fc.constant('dur'),
      unit: fc.constant('secs'),
      value: numberArb
    }),
    fc.record({
      kind: fc.constant('dur'),
      unit: fc.constant('shots'),
      value: fc.integer({ min: 0, max: 99 })
    }))
})).dur

// sources are opaque strings: vid-shaped, path/glob-shaped, or any
// printable text (escapes included) — the language treats them all alike
const sourceArb = fc.oneof(
  stringArb,
  fc.stringMatching(/^[a-z0-9]{12}(:[1-9])?$/),
  fc.stringMatching(/^[a-z0-9./*_-]{1,16}$/))

const queryArb = fc.record({
  kind: fc.constant('query'),
  select: fc.option(fc.oneof(
    fc.constant('star'),
    fc.array(fc.record({ expr: exprArb, label: fc.option(stringArb) }),
      { minLength: 1, maxLength: 3 }))),
  sources: fc.array(sourceArb, { minLength: 1, maxLength: 3 }),
  where: exprArb,
  groupBy: fc.constant(null),
  having: fc.constant(null),
  context: fc.record({ before: durArb, after: durArb }),
  orderBy: fc.option(
    fc.array(fc.record({ expr: exprArb, dir: fc.constantFrom('asc', 'desc') }),
      { minLength: 1, maxLength: 3 })),
  limit: fc.option(fc.integer({ min: 0, max: 100000 }))
})

// aggregate calls at their aggregate arity (count 0-ary, the rest unary)
const aggregateArb = fc.oneof(
  fc.constant({ kind: 'call', name: 'count', args: [] }),
  fc.record({
    name: fc.constantFrom('sum', 'avg', 'min', 'max'),
    arg: exprArb
  }).map(({ name, arg }) => ({ kind: 'call', name, args: [arg] })))

// grouped queries honor the analyzer's shape: SELECT is present and every
// SELECT/ORDER BY expression is a group key or an aggregate, and context
// stays at its (unprintable) zero default
const groupedQueryArb = fc.array(exprArb, { minLength: 1, maxLength: 2 })
  .chain(groupBy => {
    const itemArb = fc.oneof(fc.constantFrom(...groupBy), aggregateArb)
    return fc.record({
      kind: fc.constant('query'),
      select: fc.array(fc.record({ expr: itemArb, label: fc.option(stringArb) }),
        { minLength: 1, maxLength: 3 }),
      sources: fc.array(sourceArb, { minLength: 1, maxLength: 3 }),
      where: exprArb,
      groupBy: fc.constant(groupBy),
      // HAVING combines aggregates and group keys, at any depth
      having: fc.option(fc.record({
        kind: fc.constant('cmp'),
        op: fc.constantFrom('>=', '<', '='),
        lhs: fc.oneof(fc.constantFrom(...groupBy), aggregateArb),
        rhs: fc.integer({ min: 0, max: 9 })
          .map(value => ({ kind: 'lit', value }))
      })),
      context: fc.constant(
        { before: { kind: 'dur', unit: 'secs', value: 0 }, after: { kind: 'dur', unit: 'secs', value: 0 } }),
      orderBy: fc.option(
        fc.array(fc.record({ expr: itemArb, dir: fc.constantFrom('asc', 'desc') }),
          { minLength: 1, maxLength: 2 })),
      limit: fc.option(fc.integer({ min: 0, max: 100000 }))
    })
  })

describe('print/parse roundtrip (property-based)', () => {
  test('any canonical AST survives print → parse unchanged', () => {
    fc.assert(fc.property(fc.oneof(queryArb, groupedQueryArb), query => {
      const printed = print(query)
      const { ast, errors } = parse(printed)
      if (errors) {
        throw new Error(`did not reparse: ${JSON.stringify(errors)}\n${printed}`)
      }
      expect(stripLoc(ast)).toEqual(query)
    }), { numRuns: 250 })
  })
})
