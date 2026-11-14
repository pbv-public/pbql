// Every function name the language defines, in its canonical spelling.
// Function names are case-insensitive, as SQL's are: the parser rewrites
// SUM, Sum and sum to the spelling here, so nothing after parsing ever sees
// another. Method and property names stay case-sensitive. The analyzer's
// SCALAR_FNS and AGGREGATE_FNS give each one its arity; a test holds the
// two lists together.
export const FUNCTION_NAMES = [
  'count', 'sum', 'avg', 'min', 'max', 'abs', 'exists', 'kph', 'toMs',
  'toSecs', 'timecode', 'date'
]

const CANONICAL = new Map(FUNCTION_NAMES.map(name => [name.toLowerCase(), name]))

/**
 * @param {string} name a function name as written
 * @returns {string} its canonical spelling, or the name unchanged when the
 *   language has no such function (the analyzer reports it)
 */
export function canonicalFunctionName (name) {
  return CANONICAL.get(name.toLowerCase()) ?? name
}
