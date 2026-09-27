import moo from 'moo'

// ---- keywords ----------------------------------------------------------
// All keywords are case-insensitive. moo.keywords matches verbatim, so
// we lowercase the identifier before the keyword lookup; token.text keeps
// the original spelling.
function caseInsensitiveKeywords (map) {
  const transform = moo.keywords(map)
  return text => transform(text.toLowerCase())
}

const KEYWORDS = {
  kw_select: 'select',
  kw_from: 'from',
  kw_where: 'where',
  kw_limit: 'limit',
  kw_as: 'as',
  kw_having: 'having',
  kw_union: 'union',
  kw_all: 'all',
  kw_in: 'in',
  kw_and: 'and',
  kw_or: 'or',
  kw_not: 'not',
  kw_true: 'true',
  kw_false: 'false',
  kw_asc: 'asc',
  kw_desc: 'desc',
  kw_shot: 'shot', // the shot object; also the singular duration unit alias
  kw_rally: 'rally', // the rally object; also the to-rally-boundary duration
  kw_game: 'game',
  kw_me: 'me', // the querying user, a player root
  kw_player: 'player', // player("Name"), the player root for anyone by name
  unit_secs: ['secs', 'seconds', 'sec'], // aliases canonicalize to "secs"
  unit_shots: 'shots'
}

// A case-insensitive multi-word phrase: any whitespace between words. That
// whitespace can include newlines ("ORDER\nBY"), so the rule declares
// lineBreaks — otherwise moo's line/col accounting drifts for every token
// that follows.
function ciPhrase (phrase) {
  const source = phrase.split(' ').map(word =>
    word.split('').map(ch => `[${ch.toUpperCase()}${ch.toLowerCase()}]`).join('')
  ).join('\\s+')
  return { match: new RegExp(source + '\\b'), lineBreaks: true }
}

const lexer = moo.compile({
  whitespace: { match: /\s+/, lineBreaks: true },
  comment: /#.*?$/,
  // numbers are unsigned at the token level; negation is the unary - operator
  float: { match: /[0-9]+\.[0-9]+/, value: parseFloat },
  int: { match: /[0-9]+/, value: parseInt },
  // double-quoted, \" and \\ escapes, no newlines
  string: /"(?:\\["\\]|[^"\\\n])*"/,
  // multi-word section keywords (must precede the identifier rule)
  contextBefore: ciPhrase('CONTEXT BEFORE'),
  contextAfter: ciPhrase('CONTEXT AFTER'),
  groupBy: ciPhrase('GROUP BY'),
  orderBy: ciPhrase('ORDER BY'),
  leftParen: '(',
  rightParen: ')',
  leftBracket: '[',
  rightBracket: ']',
  dot: '.',
  comma: ',',
  // aliases <> and == are accepted and canonicalized by the grammar
  comparisonOperator: ['<=', '>=', '!=', '<>', '==', '=', '<', '>'],
  plus: '+',
  minus: '-',
  star: '*',
  slash: '/',
  // emit an error token instead of throwing so parse errors carry positions
  error: moo.error,
  identifier: {
    match: /[a-zA-Z_][a-zA-Z0-9_]*/,
    type: caseInsensitiveKeywords(KEYWORDS)
  }
})

// ignore comments and whitespace
const ignoredTokens = new Set(['comment', 'whitespace'])
lexer.next = (next => () => {
  let tok
  while ((tok = next.call(lexer)) && ignoredTokens.has(tok.type)) {
    // skip ignored tokens
  }
  return tok
})(lexer.next)

export default lexer
