@{%
  const pbqlLexer = require("./lexer.js");

  function loc (tok) {
    return { line: tok.line, col: tok.col }
  }

  // AND/OR are n-ary in the AST: nested same-kind junctions flatten
  function junction (kind, lhs, rhs) {
    const args = []
    for (const side of [lhs, rhs]) {
      if (side.kind === kind) {
        args.push(...side.args)
      } else {
        args.push(side)
      }
    }
    return { kind, args }
  }

  // accepted alias spellings canonicalize in the AST
  const CANON_OPS = { '<>': '!=', '==': '=' }

  function unescapeString (tok) {
    return tok.text.slice(1, -1).replace(/\\(["\\])/g, '$1')
  }

  const ZERO_DUR = () => ({ kind: 'dur', unit: 'secs', value: 0 })
  const ONE_SHOT = () => ({ kind: 'dur', unit: 'shots', value: 1 })

  // Resolve the CONTEXT window from the (possibly absent) BEFORE/AFTER clauses.
  // A shot-list query (no SELECT/GROUP BY) with NO context clause defaults to a
  // one-shot lead-in AND lead-out (±1), so a plain clip query needs no CONTEXT.
  // Writing either clause puts the author in control: the side they left out is
  // zero. Projections (SELECT/GROUP BY) return rows, not clips, so their
  // context stays at the zero default.
  function resolveContext (select, groupBy, before, after) {
    if (select === null && groupBy === null && before === null && after === null) {
      return { before: ONE_SHOT(), after: ONE_SHOT() }
    }
    return { before: before ?? ZERO_DUR(), after: after ?? ZERO_DUR() }
  }
%}
@lexer pbqlLexer
@preprocessor module

# A query is one SELECT, or several joined by UNION. The branches stay
# whole queries rather than becoming a special kind of clause, because
# what the model wants from UNION is precisely the per-branch parts: its
# own FROM, its own WHERE, its own LIMIT. "one net fault from game 1 and
# one long fault from game 2" is not expressible any other way -- an OR
# over both sources shares a single LIMIT and can return two from the
# same game.
main -> query {% d => d[0] %}
      | unionQuery {% d => d[0] %}

unionQuery -> query unionTail:+
  {% d => {
       const branches = [
         { query: d[0], all: true },
         ...d[1].map(([all, query]) => ({ query, all }))
       ]
       return {
         kind: 'union',
         // UNION dedupes, UNION ALL keeps duplicates; a mix of spellings
         // dedupes only where ALL was left out, branch by branch
         branches,
         // every host reads ast.sources to decide which games to load, so
         // a union carries the union of its branches' sources (in order,
         // without repeats) and hosts need to know nothing about branches
         sources: [...new Set(branches.flatMap(b => b.query.sources))]
       }
     } %}

unionTail -> %kw_union %kw_all:? query {% d => [d[1] !== null, d[2]] %}

query -> select:? from where groupBy:? having:? ctxBefore:? ctxAfter:? orderBy:? limit:?
  {% d => ({
       kind: 'query',
       select: d[0],
       sources: d[1],
       where: d[2],
       groupBy: d[3],
       having: d[4],
       context: resolveContext(d[0], d[3], d[5], d[6]),
       orderBy: d[7],
       limit: d[8]
     }) %}

# ---- SELECT ---------------------------------------------------------------
select ->
    %kw_select selectList {% d => d[1] %}
  | %kw_select %star      {% () => 'star' %}
selectList ->
    selectItem                    {% d => [d[0]] %}
  | selectList %comma selectItem  {% d => [...d[0], d[2]] %}
selectItem ->
    expr                 {% d => ({ expr: d[0], label: null }) %}
  | expr %kw_as string   {% d => ({ expr: d[0], label: d[2] }) %}

# ---- FROM ----------------------------------------------------------------
# sources are opaque quoted strings; each host decides what they name (the
# CLI resolves video ids, files, directories, and globs; see docs §6.1)
from -> %kw_from sourceList {% d => d[1] %}
sourceList ->
    string                    {% d => [d[0]] %}
  | sourceList %comma string  {% d => [...d[0], d[2]] %}

# ---- WHERE ---------------------------------------------------------------
where -> %kw_where expr {% d => d[1] %}

# ---- expressions, loosest to tightest binding -----------------------------
expr -> orExpr {% id %}
orExpr ->
    orExpr %kw_or andExpr {% d => junction('or', d[0], d[2]) %}
  | andExpr               {% id %}
andExpr ->
    andExpr %kw_and notExpr {% d => junction('and', d[0], d[2]) %}
  | notExpr                 {% id %}
notExpr ->
    %kw_not notExpr {% d => ({ kind: 'not', arg: d[1] }) %}
  | cmpExpr         {% id %}
# comparisons do not chain: both sides are additive expressions
cmpExpr ->
    addExpr %comparisonOperator addExpr
    {% d => ({
         kind: 'cmp',
         op: CANON_OPS[d[1].text] ?? d[1].text,
         lhs: d[0],
         rhs: d[2],
         loc: loc(d[1])
       }) %}
  | addExpr %kw_in %leftParen literalList %rightParen
    {% d => ({ kind: 'in', lhs: d[0], list: d[3], loc: loc(d[1]) }) %}
  | addExpr {% id %}
literalList ->
    inLiteral                    {% d => [d[0]] %}
  | literalList %comma inLiteral {% d => [...d[0], d[2]] %}
# IN lists admit signed numbers ("IN (-1, 2)"), matching "= -1" legality;
# everywhere else negation stays the unary - operator on expressions
inLiteral ->
    literal        {% id %}
  | %minus number  {% d => -d[1] %}
addExpr ->
    addExpr addOp mulExpr {% d => ({ kind: 'arith', op: d[1], lhs: d[0], rhs: d[2] }) %}
  | mulExpr               {% id %}
addOp -> %plus {% () => '+' %} | %minus {% () => '-' %}
mulExpr ->
    mulExpr mulOp unaryExpr {% d => ({ kind: 'arith', op: d[1], lhs: d[0], rhs: d[2] }) %}
  | unaryExpr               {% id %}
mulOp -> %star {% () => '*' %} | %slash {% () => '/' %}
unaryExpr ->
    %minus unaryExpr {% d => ({ kind: 'neg', arg: d[1] }) %}
  | postfix          {% id %}
postfix ->
    literalNode                  {% id %}
  | propExpr                     {% id %}
  | callExpr                     {% id %}
  | %leftParen expr %rightParen  {% d => d[1] %}

# ---- properties, methods, functions ---------------------------------------
# object[.seg[.seg…]][(args)] — args make the last segment a method call
propExpr -> objectRef segs callArgs:?
  {% (d, _, reject) => {
       if (d[2] && d[1].length === 0) {
         return reject  // an object is not callable: shot("x") is an error
       }
       const node = { kind: 'prop', base: d[0], path: d[1], loc: d[0].loc }
       if (d[2]) {
         node.args = d[2]
       }
       return node
     } %}
# object roots: shot/rally (with optional relative index), game, and the
# player roots `me` and `player("Name")`. `hitter`, `teammate`, `opponent*`
# are ordinary path segments (segName), so player navigation like
# `shot.hitter.opponentLHS` is just a base plus a path — see docs §5.4.
objectRef ->
    %kw_shot index:?  {% d => ({ object: 'shot', offset: d[1] ?? 0, loc: loc(d[0]) }) %}
  | %kw_rally index:? {% d => ({ object: 'rally', offset: d[1] ?? 0, loc: loc(d[0]) }) %}
  | %kw_game          {% d => ({ object: 'game', loc: loc(d[0]) }) %}
  | %kw_me            {% d => ({ object: 'player', root: 'me', loc: loc(d[0]) }) %}
  | %kw_player %leftParen string %rightParen
    {% d => ({ object: 'player', root: 'player', name: d[2], loc: loc(d[0]) }) %}
index -> %leftBracket %minus:? int %rightBracket
  {% d => d[1] ? -d[2] : d[2] %}
segs ->
    null                {% () => [] %}
  | segs %dot segName   {% d => [...d[0], d[2]] %}
# keywords are legal property names after a dot: moo carves keywords out of
# identifiers, so the grammar re-admits them as path segments
segName ->
    %identifier {% d => d[0].text %}
  | %kw_select  {% d => d[0].text %}
  | %kw_from    {% d => d[0].text %}
  | %kw_where   {% d => d[0].text %}
  | %kw_limit   {% d => d[0].text %}
  | %kw_as      {% d => d[0].text %}
  | %kw_having  {% d => d[0].text %}
  | %kw_in      {% d => d[0].text %}
  | %kw_and     {% d => d[0].text %}
  | %kw_or      {% d => d[0].text %}
  | %kw_not     {% d => d[0].text %}
  | %kw_true    {% d => d[0].text %}
  | %kw_false   {% d => d[0].text %}
  | %kw_asc     {% d => d[0].text %}
  | %kw_desc    {% d => d[0].text %}
  | %kw_shot    {% d => d[0].text %}
  | %kw_rally   {% d => d[0].text %}
  | %kw_game    {% d => d[0].text %}
  | %kw_me      {% d => d[0].text %}
  | %kw_player  {% d => d[0].text %}
  | %unit_secs  {% d => d[0].text %}
  | %unit_shots {% d => d[0].text %}
callExpr -> %identifier callArgs
  {% d => ({ kind: 'call', name: d[0].text, args: d[1], loc: loc(d[0]) }) %}
callArgs ->
    %leftParen %rightParen          {% () => [] %}
  | %leftParen argList %rightParen  {% d => d[1] %}
argList ->
    expr                 {% d => [d[0]] %}
  | argList %comma expr  {% d => [...d[0], d[2]] %}

# ---- CONTEXT (positive magnitudes; min/max take the smaller/larger) -------
ctxBefore -> %contextBefore duration {% d => d[1] %}
ctxAfter -> %contextAfter duration   {% d => d[1] %}
duration ->
    number %unit_secs  {% d => ({ kind: 'dur', unit: 'secs', value: d[0] }) %}
  | int shotsUnit      {% d => ({ kind: 'dur', unit: 'shots', value: d[0] }) %}
  | %kw_rally          {% () => ({ kind: 'dur', unit: 'rally' }) %}
  | %identifier %leftParen duration %comma duration %rightParen
    {% (d, _, reject) => {
         const fn = d[0].text.toLowerCase()
         if (fn !== 'min' && fn !== 'max') {
           return reject
         }
         return { kind: 'durfn', fn, args: [d[2], d[4]] }
       } %}
# the singular "shot" is an accepted alias for the shots unit
shotsUnit -> %unit_shots {% id %} | %kw_shot {% id %}

# ---- HAVING (filters grouped rows; validated against GROUP BY) ------------
having -> %kw_having expr {% d => d[1] %}

# ---- GROUP BY --------------------------------------------------------------
# grouped output is one row per key tuple; the analyzer holds SELECT and
# ORDER BY expressions to aggregates or group keys (docs §6.7)
groupBy -> %groupBy groupList {% d => d[1] %}
groupList ->
    expr                  {% d => [d[0]] %}
  | groupList %comma expr {% d => [...d[0], d[2]] %}

# ---- ORDER BY / LIMIT ------------------------------------------------------
orderBy -> %orderBy orderList {% d => d[1] %}
orderList ->
    orderItem                    {% d => [d[0]] %}
  | orderList %comma orderItem   {% d => [...d[0], d[2]] %}
orderItem -> expr sortDir:? {% d => ({ expr: d[0], dir: d[1] ?? 'asc' }) %}
sortDir -> %kw_asc {% () => 'asc' %} | %kw_desc {% () => 'desc' %}
limit -> %kw_limit int {% d => d[1] %}

# ---- literals ---------------------------------------------------------------
literalNode -> literal {% d => ({ kind: 'lit', value: d[0] }) %}
literal ->
    number  {% id %}
  | string  {% id %}
  | boolean {% id %}
number -> int {% id %} | float {% id %}
int -> %int      {% d => d[0].value %}
float -> %float  {% d => d[0].value %}
string -> %string {% d => unescapeString(d[0]) %}
boolean -> %kw_true {% () => true %} | %kw_false {% () => false %}
