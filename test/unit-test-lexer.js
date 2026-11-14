import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import lexer from '../src/lang/lexer.js'

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

function lex (text) {
  lexer.reset(text)
  const tokens = []
  let token
  while ((token = lexer.next()) !== undefined) {
    tokens.push(token)
  }
  return tokens
}

const types = text => lex(text).map(t => t.type)

describe('pbql lexer', () => {
  test('skips whitespace and comments', () => {
    const tokens = lex('# a comment\n  \n42 # trailing comment')
    expect(tokens.map(t => t.type)).toEqual(['int'])
    expect(tokens[0].value).toBe(42)
  })

  test('numbers are unsigned tokens; minus is its own token', () => {
    const tokens = lex('1 -2 3.5')
    expect(tokens.map(t => t.type)).toEqual(['int', 'minus', 'int', 'float'])
    expect(tokens[2].value).toBe(2)
    expect(tokens[3].value).toBe(3.5)
  })

  test('keywords are case-insensitive but keep their spelling', () => {
    const tokens = lex('from FROM From WHERE where')
    expect(tokens.map(t => t.type))
      .toEqual(['kw_from', 'kw_from', 'kw_from', 'kw_where', 'kw_where'])
    expect(tokens.map(t => t.text)).toEqual(['from', 'FROM', 'From', 'WHERE', 'where'])
  })

  test('IS and NULL are keywords', () => {
    expect(types('is NULL Is null')).toEqual(['kw_is', 'kw_null', 'kw_is', 'kw_null'])
  })

  test('keywords only match whole identifiers', () => {
    // "me" is a player keyword but "method" must stay an identifier
    expect(types('method metadata hitters shotgun'))
      .toEqual(['identifier', 'identifier', 'identifier', 'identifier'])
  })

  test('unit aliases lex as the same token type', () => {
    expect(types('secs seconds SEC shots'))
      .toEqual(['unit_secs', 'unit_secs', 'unit_secs', 'unit_shots'])
  })

  test('comparison operators, including alias spellings, longest-match', () => {
    const tokens = lex('<= >= != <> == = < >')
    expect(tokens.map(t => t.type))
      .toEqual(Array(8).fill('comparisonOperator'))
    expect(tokens.map(t => t.text))
      .toEqual(['<=', '>=', '!=', '<>', '==', '=', '<', '>'])
  })

  test('arithmetic operators', () => {
    expect(types('+ - * /')).toEqual(['plus', 'minus', 'star', 'slash'])
  })

  test('strings support escaped quotes and backslashes', () => {
    const [s] = lex('"say \\"hi\\" \\\\ bye"')
    expect(s.type).toBe('string')
    expect(s.text).toBe('"say \\"hi\\" \\\\ bye"')
  })

  test('strings may be single-quoted, as in SQL, with \'\' for a quote', () => {
    const [s] = lex("'it''s \"fine\"'")
    expect(s.type).toBe('string')
    expect(s.text).toBe("'it''s \"fine\"'")
  })

  test('multi-word keywords allow flexible whitespace and any case', () => {
    expect(types('CONTEXT BEFORE Context\tAfter Order   By'))
      .toEqual(['contextBefore', 'contextAfter', 'orderBy'])
  })

  test('newlines inside multi-word keywords keep later positions right', () => {
    const tokens = lex('ORDER\nBY x')
    expect(tokens.map(t => t.type)).toEqual(['orderBy', 'identifier'])
    expect(tokens[1].line).toBe(2) // "x" is on line 2, column 4
    expect(tokens[1].col).toBe(4)
    const multi = lex('CONTEXT\n\nBEFORE 2secs')
    expect(multi.map(t => t.type)).toEqual(['contextBefore', 'int', 'unit_secs'])
    expect(multi[1].line).toBe(3)
    expect(multi[1].col).toBe(8)
  })

  test('me is the sole player-root keyword; relations lex as identifiers', () => {
    // "me" is case-insensitive like every keyword; hitter/teammate/opponent*
    // are ordinary identifiers reached by path navigation
    const tokens = lex('me ME hitter teammate opponentLHS opponent2')
    expect(tokens.map(t => t.type)).toEqual([
      'kw_me', 'kw_me', 'identifier', 'identifier', 'identifier', 'identifier'])
  })

  test('punctuation', () => {
    expect(types('( ) [ ] . ,')).toEqual([
      'leftParen', 'rightParen', 'leftBracket', 'rightBracket', 'dot', 'comma'])
  })

  test('unrecognized text becomes an error token with a position', () => {
    const tokens = lex('42 @oops')
    expect(tokens[0].type).toBe('int')
    expect(tokens[1].type).toBe('error')
    expect(tokens[1].line).toBe(1)
    expect(tokens[1].col).toBe(4)
  })

  test('lexes the demo query with no error tokens', () => {
    const text = fs.readFileSync(path.join(repoRoot, 'test', 'demo.pbql'), 'utf8')
    const tokens = lex(text)
    expect(tokens.length).toBeGreaterThan(100)
    expect(tokens.filter(t => t.type === 'error')).toEqual([])
  })
})
