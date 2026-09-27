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
function queryBody (ast, source) {
  return print(branchesReading(ast, source)).split('\n')
    .filter(line => !line.startsWith('FROM '))
    .join('\n')
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
 * @returns {Array<string>} one URL per vid-shaped source, in FROM order,
 *   each carrying only the part of the query that reads that game
 */
export function toShotExplorerURLs (queryText, sources) {
  const { ast, errors } = parse(queryText)
  const urls = []
  for (const source of sources) {
    const vidSource = parseVidSource(source)
    if (vidSource !== null) {
      const body = errors ? queryText : queryBody(ast, source)
      urls.push(`https://pb.vision/video/${vidSource.vid}/` +
        `${vidSource.sessionIdx}/explore?q=${encodeURIComponent(body)}`)
    }
  }
  return urls
}
