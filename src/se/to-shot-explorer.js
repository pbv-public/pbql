// Builds Shot Explorer deep links. The explore page accepts a PBQL query
// directly via its q param, so sharing a query is just sharing a URL — no
// result translation needed. One link per pb.vision video named in FROM
// (other source strings — files, directories, globs — have no explore page).
import { parse } from '../lang/parse.js'
import { print } from '../lang/print.js'
import { parseVidSource } from '../sources/vid.js'

// The explore URL already names the video and session, so the encoded query
// carries only the body: the app substitutes its own FROM for whatever the
// page shows, in every branch of a UNION. Canonical form puts FROM alone on
// its own line, so it drops out cleanly; unparseable text is encoded as-is.
function queryBody (ast, source, names) {
  return print(renamePlayers(branchesReading(ast, source), names ?? {}))
    .split('\n')
    .filter(line => !line.startsWith('FROM '))
    .join('\n')
}

// A copy of the AST with each player name the query uses swapped for the
// one the page knows that player by: string literals (a name compared, an
// IN list entry, a taggedWith pattern) and player("...") roots alike. The page
// names players from its own game alone, so a host that named them across
// several games ("Unknown 3") must say what each one is called there.
function renamePlayers (node, names) {
  if (Array.isArray(node)) {
    return node.map(item => renamePlayers(item, names))
  }
  if (node === null || typeof node !== 'object') {
    return node
  }
  const copy = {}
  for (const [key, value] of Object.entries(node)) {
    copy[key] = renamePlayers(value, names)
  }
  const rename = value => typeof value === 'string' && Object.hasOwn(names, value)
    ? names[value]
    : value
  if (copy.kind === 'lit') {
    copy.value = rename(copy.value)
  } else if (copy.kind === 'in') {
    copy.list = copy.list.map(rename) // IN lists hold bare values
  } else if (copy.root === 'player') {
    copy.name = rename(copy.name)
  }
  return copy
}

// A link opens one game, so it keeps only the UNION branches that read
// that game: a branch written for another game would otherwise run here
// too, selecting this game's shots under the other game's conditions. A
// source no branch names keeps them all, as nothing narrower is right.
function branchesReading (ast, source) {
  if (ast.kind !== 'union') {
    return ast
  }
  const target = parseVidSource(source)
  const reads = ({ query }) => query.sources.some(branchSource => {
    const vidSource = parseVidSource(branchSource)
    return vidSource !== null && vidSource.vid === target.vid &&
      vidSource.sessionIdx === target.sessionIdx
  })
  const branches = ast.branches.filter(reads)
  if (branches.length === 0 || branches.length === ast.branches.length) {
    return ast
  }
  return branches.length === 1
    ? branches[0].query
    : { ...ast, branches, sources: [...new Set(branches.flatMap(b => b.query.sources))] }
}

/**
 * Builds ready-to-open explore deep links for a query.
 * @param {string} queryText the PBQL query
 * @param {Array<string>} sources the query's FROM sources (ast.sources)
 * @param {Object} [options]
 * @param {Object<string, Object<string, string>>} [options.playerNames]
 *   by source, each player name the query uses that the page calls
 *   something else, mapped to the page's name (e.g. "Unknown 3" to
 *   "Player 2"). Names are swapped exactly; a glob is left alone
 * @returns {Array<string>} one URL per vid-shaped source, in FROM order,
 *   each carrying only the part of the query that reads that game
 */
export function toShotExplorerURLs (queryText, sources, { playerNames } = {}) {
  const { ast, errors } = parse(queryText)
  const urls = []
  for (const source of sources) {
    const vidSource = parseVidSource(source)
    if (vidSource !== null) {
      const body = errors
        ? queryText
        : queryBody(ast, source, playerNames?.[source])
      urls.push(`https://pb.vision/video/${vidSource.vid}/` +
        `${vidSource.sessionIdx}/explore?q=${encodeURIComponent(body)}`)
    }
  }
  return urls
}
