import nearley from 'nearley'

import grammar from './grammar-generated.js'

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

const MISSING_WHERE = {
  code: 'PBQL_MISSING_WHERE',
  message: 'every query needs a WHERE clause after FROM; when no filter ' +
    'is wanted, write WHERE true'
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
  return { ast: results[0] }
}
