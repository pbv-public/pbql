// One-call validation for hosts and LLM self-repair loops:
// lex + parse + analyze, returning every error found.
import { analyze } from './analyze/analyze.js'
import { parse } from './lang/parse.js'

/**
 * @param {string} text a PBQL query
 * @returns {{errors: Array, ast?: object}} errors is empty when the query
 *   is valid; ast is present whenever parsing succeeded
 */
export function validate (text) {
  const parsed = parse(text)
  if (parsed.errors) {
    return { errors: parsed.errors }
  }
  return { errors: analyze(parsed.ast).errors, ast: parsed.ast }
}
