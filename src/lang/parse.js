import nearley from 'nearley'

import { canonicalFunctionName } from './functions.js'
import grammar from './grammar-generated.js'
import lexer from './lexer.js'

function locOfEnd (text) {
  const lines = text.split('\n')
  return { line: lines.length, col: lines[lines.length - 1].length + 1 }
}

function feed (text) {
  const parser = new nearley.Parser(nearley.Grammar.fromCompiled(grammar))
  parser.feed(text)
  return parser.results
}

// Every query needs a WHERE, and leaving it out is the commonest way a
// whole-game query goes wrong (SELECT count() FROM "g" GROUP BY ...). The
// grammar only sees the clause that came next, so it would report
// `unexpected "GROUP BY"` or an unexpected end, neither of which mentions
// WHERE. If putting WHERE true where parsing stopped makes the query
// parse, that is what it was missing.
function missingWhere (text, offset) {
  try {
    return feed(`${text.slice(0, offset)} WHERE true ${text.slice(offset)}`)
      .length > 0
  } catch {
    return false
  }
}

// The last token before `offset`, comments and whitespace skipped: text
// the parser already lexed without error on its way to `offset`.
function tokenBefore (text, offset) {
  lexer.reset(text.slice(0, offset))
  let last
  for (let token = lexer.next(); token; token = lexer.next()) {
    last = token
  }
  return last
}

// `player.name`: a player root with no name, which a query reaches for to
// go over every player and the grammar reports only as `unexpected "."`
const PLAYER_NEEDS_NAME = {
  code: 'PBQL_PLAYER_NEEDS_NAME',
  message: 'player needs a name, as in player("Ray").team; to go over ' +
    'every player, use shot.hitter (GROUP BY shot.hitter.name)'
}

// `x = NULL` (or != NULL): NULL is not a value here, as it is never
// usefully one in SQL either; what was meant is a test for a missing value
const NULL_VALUE = {
  code: 'PBQL_NULL_VALUE',
  message: 'NULL is not a value: to test for a missing value write ' +
    'x IS NULL, and for a present one x IS NOT NULL'
}

const MISSING_WHERE = {
  code: 'PBQL_MISSING_WHERE',
  message: 'every query needs a WHERE clause after FROM; when no filter ' +
    'is wanted, write WHERE true'
}

// Function names are case-insensitive: every call takes its canonical
// spelling here, so the analyzer, the engine and the printer see one name.
function canonicalizeCalls (node) {
  if (Array.isArray(node)) {
    node.forEach(canonicalizeCalls)
    return
  }
  if (node === null || typeof node !== 'object') {
    return
  }
  if (node.kind === 'call') {
    node.name = canonicalFunctionName(node.name)
  }
  Object.values(node).forEach(canonicalizeCalls)
}

/**
 * Parses PBQL query text.
 * @param {string} text the query
 * @returns {{ast: object}|{errors: Array<{code: string, message: string,
 *   line: number, col: number, length: number}>}} the AST, or one or more
 *   errors with 1-indexed positions
 */
export function parse (text) {
  let results
  try {
    results = feed(text)
  } catch (err) {
    const { token } = err
    /* istanbul ignore next -- nearley attaches the offending token to every
       error it or the lexer's error token can produce */
    if (!token) {
      throw err
    }
    const isLexError = token.type === 'error'
    const at = { line: token.line, col: token.col, length: token.text.length }
    if (!isLexError && missingWhere(text, token.offset)) {
      return { errors: [{ ...MISSING_WHERE, ...at }] }
    }
    if (token.type === 'kw_null') {
      return { errors: [{ ...NULL_VALUE, ...at }] }
    }
    if (token.text === '.' &&
      tokenBefore(text, token.offset)?.type === 'kw_player') {
      return { errors: [{ ...PLAYER_NEEDS_NAME, ...at }] }
    }
    return {
      errors: [{
        code: isLexError ? 'PBQL_LEX_ERROR' : 'PBQL_PARSE_ERROR',
        message: isLexError
          ? 'unrecognized text'
          : `unexpected "${token.text}"`,
        ...at
      }]
    }
  }
  if (results.length === 0) {
    const { line, col } = locOfEnd(text)
    const at = { line, col, length: 0 }
    if (missingWhere(text, text.length)) {
      return { errors: [{ ...MISSING_WHERE, ...at }] }
    }
    return {
      errors: [{
        code: 'PBQL_UNEXPECTED_END',
        message: 'query ended unexpectedly (incomplete statement)',
        ...at
      }]
    }
  }
  /* istanbul ignore next -- the grammar is unambiguous; the test corpus
     exists to keep it that way */
  if (results.length > 1) {
    return {
      errors: [{
        code: 'PBQL_AMBIGUOUS',
        message: `grammar bug: query has ${results.length} parses`,
        line: 1,
        col: 1,
        length: 0
      }]
    }
  }
  canonicalizeCalls(results[0])
  return { ast: results[0] }
}
