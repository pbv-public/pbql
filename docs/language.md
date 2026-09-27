# The PBQL Language

PBQL selects shots from pickleball games analyzed by PB Vision. This document
is the normative spec. Property-by-property details live in the generated
[Data Dictionary](data-dictionary.md).

## 1. Overall shape

```sql
[SELECT expr [AS "label"] [, ...]]
FROM "source" [, ...]
WHERE condition
[GROUP BY expr [, ...]]
[CONTEXT BEFORE duration]
[CONTEXT AFTER duration]
[ORDER BY expr [ASC|DESC] [, ...]]
[LIMIT n]

[UNION [ALL] <another whole query>] ...
```

A query conceptually builds one row per **shot** across all games named by
`FROM`, keeps the rows where `WHERE` evaluates to `true`, widens each kept
shot's video window per `CONTEXT` (a one-shot lead-in and lead-out by default;
§6.3), sorts, limits, and outputs. Without
`SELECT`, the output is the selected shots themselves, as clips; with
`SELECT`, it is one projected row per shot,
or a single row if any selected expression uses an aggregate. A projection
returns rows, not clips, so `CONTEXT` applies only to shot-list queries.
`GROUP BY` (§6.7) changes the output to one row per group; it requires
`SELECT` and, like any projection, excludes `CONTEXT`.


### 1.1 UNION

Two or more whole queries joined by `UNION` produce one result. Each branch
keeps its own `SELECT`, `FROM`, `WHERE`, `ORDER BY` and `LIMIT`; the branches
are evaluated independently and their outputs concatenated in order.

- Every branch must be the same **shape**: all of them project with `SELECT`,
  or none of them do. Mixing rows and clips is an error
  (`PBQL_UNION_SHAPE`).
- Projecting branches must select the same **number of columns**
  (`PBQL_UNION_WIDTH`). Column names come from the first branch, so later
  branches need no aliases.
- `UNION ALL` keeps duplicates. A bare `UNION` drops rows (or shots) already
  produced by an earlier branch.
- A branch is restricted to the games its own `FROM` names. A branch naming a
  directory or glob is not restricted, because those expand outside the engine
  into games it cannot name.

`UNION` earns its place when the branches genuinely differ. One example shot
from each of two games is not expressible any other way, because a single
query has one `LIMIT` over the whole result:

```sql
FROM "gameA" WHERE shot.errors.faults.net LIMIT 1
UNION ALL
FROM "gameB" WHERE shot.errors.faults.out.direction = "long" LIMIT 1
```

When the branches differ only by a predicate over the same sources, a single
query says it better: `GROUP BY` the property whose values are the categories,
or give each condition its own aggregate column.

## 2. Lexical structure

- **Keywords** are case-insensitive (`FROM` ≡ `from` ≡ `From`). Canonical
  form is UPPERCASE for clause keywords and lowercase for everything else.
  Multi-word keywords (`CONTEXT BEFORE`, `CONTEXT AFTER`, `GROUP BY`,
  `ORDER BY`) allow any whitespace between the words.
- **Identifiers** (property names, function names) are case-sensitive:
  `shot.isVolley`, not `shot.isvolley`.
- **Numbers**: integer (`42`) and decimal (`3.5`) literals, always
  non-negative at the token level; negation is the unary `-` operator.
- **Strings**: double-quoted; `\"` and `\\` are the only escapes; no
  newlines inside strings.
- **Booleans**: `true`, `false`.
- **Comments**: `#` to end of line.
- **Reserved words may still be used as property names**: keywords are
  allowed as path segments after a `.` (`shot.from.x` works even though
  `FROM` is a keyword).

### Aliases (accepted and canonicalized, never printed)

| You may write | Canonical |
|---|---|
| `<>` | `!=` |
| `==` | `=` |
| `sec`, `secs`, `seconds` | number agreement: `1sec`, `2secs` |
| `shot`, `shots` (duration unit) | number agreement: `1 shot`, `2 shots` |

## 3. Operators and precedence

Highest to lowest; comparisons do not chain (`a < b < c` is an error).

1. property access / indexing / calls — `shot[-1].speed`, `x.f(y)`, `f(y)`
2. unary minus — `-x`
3. `*`, `/`
4. `+`, `-`
5. comparisons — `=`, `!=`, `<`, `<=`, `>`, `>=`, `IN (v, ...)`
6. `NOT`
7. `AND`
8. `OR`

`AND`/`OR` are left-associative; parentheses group as usual. `x IN (a, b, c)`
is exactly `x = a OR x = b OR x = c` — including the Kleene rules of §4
(any element matching → `true`; otherwise any unknown comparison → unknown).
The list holds literal values only; numeric elements may be signed
(`shot.pitch IN (0, -1)`), just as `= -1` is legal.

## 4. Types and unknown

Values are **numbers**, **strings**, **booleans**, **players**, **positions**
(objects with coordinate properties), and **unknown**.

The insights data omits anything the AI could not determine, so missing data
is a first-class concept with SQL-style three-valued logic:

- A property whose underlying data is absent — the field is missing, or
  present as an explicit `null` — evaluates to **unknown**; so does any
  out-of-range reference (`shot[-1]` on a rally's first shot).
- Non-finite numbers never surface as values: data that smuggles in
  `Infinity` or `NaN` (e.g. a JSON `1e400`) evaluates to unknown.
- Any comparison or arithmetic with an unknown operand is unknown.
- Kleene logic — unknown means "could be either," so negating it stays
  unknown: `NOT unknown = unknown`; `unknown AND false = false`;
  `unknown AND true = unknown`; `unknown OR true = true`;
  `unknown OR false = unknown`.
- `WHERE` keeps a shot only if the condition is **true** (not unknown).
- `exists(expr)` is `true`/`false`, never unknown: `true` when `expr`
  evaluates to an actual value, `false` when it would be unknown (absent
  data, out-of-range reference).

Consequence worth memorizing: `NOT shot.isVolley` does *not* match shots
where volley-ness is unknown; write `NOT exists(shot.isVolley) OR NOT
shot.isVolley` if you want them too.

One deliberate exception: the rule-fault flags (`shot.errors.faults.net`,
`shot.errors.faults.short`) and the presence flags `shot.hasError` /
`shot.hasFault` are **never unknown**. The insights data records a fault
flag only when the fault happened, so an absent flag means `false` — `NOT
shot.errors.faults.net` genuinely selects the shots the net didn't stop,
no `exists()` guard needed.

Comparisons require matching types (comparing a number to a string is a
validation error, not `false`). Method arguments are held to their declared
type the same way (`shot.taggedWith(5)` is a validation error). Strings
compare case-sensitively with `=` and `!=` only. Players compare with
`=`/`!=` by identity (`shot.hitter = me`).

String properties with an enumerated value set (the quoted alternatives in
the [Data Dictionary](data-dictionary.md)'s unit column, e.g.
`shot.winnerType`'s `"clean"|"forced_fault"`) accept **only** those values:
comparing one (`=`, `!=`, `IN`) with a string literal outside its set — or
passing such a literal to an enum-typed method argument like
`inHighlight(kind)` — is a validation error, since production data can
never hold it. The team properties work the same way with numbers:
`rally.winner`, `game.winner` and a player's `team` are only ever `0` or
`1`, so `rally.winner = 3` is a validation error (compare with a team
instead: `rally.winner = me.team`). Non-literal comparisons
(`shot.from.zone = shot.to.zone`) are allowed.

## 5. Objects

### 5.1 `shot`, and relative shots `shot[k]`

The shot being tested. `shot[-1]`/`shot[2]` are the shots k earlier/later
**within the same rally**; beyond the rally's bounds every property of the
reference is unknown. `shot` ≡ `shot[0]`.

Time properties (`shot.hitTime`, `shot.endTime`) are **seconds** (float)
into the video. Distances are **feet**, speeds **mph**, angles **degrees**,
quality/confidence **0–1**.

Positions: `shot.from` (where the ball was struck), `shot.to` (where its
flight ended), `shot.peak` (apex). Each has:

- hitter-relative coordinates `x`/`y`/`z`, mirrored so the hitter's own
  baseline is `y = 0`, the net is `y = 22`, and `x` grows toward the
  hitter's right (0–20);
- raw court coordinates `absX`/`absY`/`absZ` (origin at the far-left corner
  relative to the camera).

`shot.from.zone` / `shot.to.zone` give the depth zone:
`"deep"|"mid"|"short"|"kitchen"` for `from.zone`, plus `"net"|"out"` for
`to.zone` only (a flight can end at the net or out, but strikes always
happen from a court zone).

### 5.2 `rally`, and relative rallies `rally[k]`

The rally containing the current shot; `rally[-1]`/`rally[1]` are neighbors
within the same game (unknown beyond the game). `rally.num` is 1-based.

### 5.3 `game`

The session (one game of a possibly multi-game video) containing the shot.
There is no relative game access.

### 5.4 Players

Players are **values you navigate to**, then either read a scalar from or
compare by identity.

**Roots** (a path segment yields a player):

- `me` — the querying user (resolved by the host application; unknown if the
  user isn't tagged in the game).
- `shot.hitter` — the player who hit that shot. Because `hitter` is a
  property of a shot, it composes with relative shots: `shot[1].hitter`
  targets the *next* shot's hitter, `shot[-1].hitter` the previous one.

**Relations** (player → player) step from any player to another:

- `teammate` — the partner (`me.teammate`, `shot.hitter.teammate`).
- `opponent1` / `opponent2` — the opposing players in player-id order.
- `opponentLHS` / `opponentRHS` — the opponents by their relative court position at the moment of the
  shot the player was reached through: LHS is the opponent who is on the left of their side of the court (so the RHS is to their right). If positions are unknown at that moment, these
  are unknown. So if I'm playing a mixed doubles match against Ben Johns and Anna Leigh Waters, `me.opponentLHS` is typically going to be Ben Johns (unless they've switched their usual sides which happens some rallies).

Relations chain: `shot.hitter.opponentLHS.teammate` is legal (each hop lands
on a player). In **singles**, `teammate` and `opponent2` are unknown, and
the lone opponent is addressable as `opponent1` or `opponentLHS` or `opponentRHS`.

**Ending a path.** A path that ends *at* a player (no scalar segment after
it) is that player's **identity**, for `=`/`!=` only:
`shot.hitter = me`, `shot.hitter != shot[-2].hitter`,
`me.opponentLHS = shot[1].hitter`. Add a scalar segment to read a value
instead — each measured at the moment of the shot the player was reached
through:

- `id`, `team`, `name`
- position: `pos.x`/`pos.y` in the player's own frame, `pos.absX`/`pos.absY`
  raw
- derived distances: `feetToKitchen`, `feetToNet`, …
- ratings for **this game**: `rating.overall`, `rating.serve`,
  `rating.return`, `rating.offense`, `rating.defense`, `rating.agility`,
  `rating.consistency`

`taggedWith(pattern)` is a method (§5.6).

A rating is one value per game rather than per shot, so it repeats on every
shot of that game and `avg()` over a game returns the rating itself. That is
what makes an area-by-area breakdown a single query:

```sql
SELECT game.name AS "game", avg(me.rating.offense) AS "offense"
FROM "83gyqyc10y8f"
WHERE true
GROUP BY game.vid, game.sessionNum, game.name
```

A game the engine did not rate is unknown, never 0 (§4), so an unrated area
is skipped by `avg()` rather than reading as a collapse to zero.

### 5.5 Calling conventions

- **Zero-argument derived values are plain properties**:
  `shot.hitter.feetToKitchen`.
- **Predicates about one subject take arguments as methods**:
  `shot.taggedWith("Alex*")`, `shot.inHighlight("atp")`.
- **Subject-less utilities are functions**:
  - `min(a, b)` / `max(a, b)`
  - `exists(x)`
  - `abs(x)`
  - unit conversions: `kph(x)` (mph → km/h), `toMs(x)` (seconds → ms),
    `toSecs(x)` (ms → seconds)
  - `timecode(secs)` — a time in seconds as an `"m:ss"` string (minutes
    unpadded, seconds floored and 2-padded: `timecode(222.9)` is `"3:42"`).
    `timecode(secs, true)` appends a 0-based 2-padded frame counter
    (`"m:ss:ff"`), counted at the game's own frame rate (from the insights
    camera data); frames are unknown when the game has no usable fps.
    Negative times are unknown, and the result is a string: it supports
    `=`/`!=` but not ordering comparisons.
  - `date(epoch)` — an epoch-seconds moment as a `"YYYY-MM-DD"` calendar
    date, rendered in the game's host-supplied timezone (`meta.tz`, an
    IANA zone — typically the signed-in user's) or, absent one, the
    process's own local zone. Its intended subject is `game.epoch`
    (`date(game.epoch)` labels each game with the day it was played; to
    order games chronologically, `ORDER BY game.epoch`). Epochs beyond
    what a date can represent are unknown — as is an unrecognized zone,
    never a date in silently the wrong place — and like `timecode()` the
    string result supports `=`/`!=` but not ordering comparisons.

### 5.6 `taggedWith(pattern)`

Matches against the host's player-tagging data. On a shot,
it tests the hitter (`shot.taggedWith(…)`); on a player, that player
(`shot.hitter.taggedWith(…)`, `me.teammate.taggedWith(…)`). If `pattern`
contains `@` it is an email and must match exactly (case-insensitive);
otherwise it is a name pattern, case-insensitive, where `*` matches any run
of characters (`"Alex*"`). Unknown when the game has no tag data.

## 6. Clauses

### 6.1 FROM

```sql
FROM "83gyqyc10y8f", "jhc3t8h8b5cj:2", "games/*.json"
```

`FROM` takes one or more **quoted strings**. The strings are opaque to the
language: each host interprets them (the pb.vision app queries the
video/session it is showing; the [CLI](cli.md) accepts video ids, local
files, directories, and globs). PBQL only requires that each source
resolve to whole games of insights data.

### 6.2 WHERE

Any boolean-valued expression per §3–§5. Required (use `WHERE true` for
everything).

### 6.3 CONTEXT

```sql
CONTEXT BEFORE min(1 shot, 2secs)
CONTEXT AFTER 3secs
CONTEXT BEFORE rally
```

Each selected shot has a video window. A **shot-list query with no `CONTEXT`
clause** frames each clip with a one-shot lead-in and lead-out (as if
`CONTEXT BEFORE 1 shot` / `CONTEXT AFTER 1 shot` were written) — this is the
default, so a normal clip query needs no `CONTEXT`. A written `CONTEXT` clause
overrides that default; durations are **positive magnitudes** (direction comes
from BEFORE/AFTER):

- `N shots` — include the N previous (or following) shots **in the same
  rally**; those shots also join the result marked as context. Clamped to
  the rally: on a rally's second shot, `BEFORE 5 shots` includes only one.
- `X secs` — stretch the window by exactly X seconds of video time,
  crossing rally boundaries freely. Windows are clamped at 0 at the video's
  start, and at the video's end when the insights carry the video duration
  (`session.videoDurationMs`, §7).
- `rally` — to the rally's boundary.
- `min(a, b)` / `max(a, b)` — resolve each alternative **per shot** to a
  concrete magnitude, then take the smaller or larger. Same meaning for
  BEFORE and AFTER.

Worked example: the selected shot is hit at 90.0s; the previous shot starts
at 86.5s. `BEFORE min(1 shot, 2secs)`: the candidates are the durations
3.5s (to include the previous shot) and 2.0s; `min` picks 2.0s, so the
window opens at 88.0s and no context shot is added (the previous shot isn't
fully included). `BEFORE max(1 shot, 2secs)` picks 3.5s: the window opens
at 86.5s and the previous shot joins as context. Note `min`/`max` compare
the durations, not the resulting start times — for `BEFORE`, the smaller
duration is the *later* start.

**Defaults.**

- Writing either `CONTEXT` clause opts a shot-list out of the ±1 default:
  the side you write is used and the side you omit falls to `0` (the bare
  flight, `hitTime`…`endTime`). So `CONTEXT BEFORE 0secs` on its own means
  no lead-in *or* lead-out.
- A projection (`SELECT` or `GROUP BY`) returns rows, not clips, so its
  context defaults to `0` on both sides and an explicit clause is an error.

### 6.4 ORDER BY

```sql
ORDER BY shot.speed DESC, shot.hitTime
```

Stable sort across all games; `ASC` is the default; unknown values sort
last regardless of direction. Without `ORDER BY`, results keep video order
(by game, rally, shot). With `GROUP BY`, `ORDER BY` sorts the grouped rows
instead.

### 6.5 LIMIT

`LIMIT n` keeps the first n rows after ordering, across all games (with
`GROUP BY`, the first n grouped rows).

### 6.6 SELECT

```sql
SELECT shot.hitter.name, shot.speed AS "mph", shot.type
```

One row per selected shot; `AS "label"` names the output column (labels are
purely cosmetic — units never change). `SELECT *` (alone, and never with
`GROUP BY`) lists every scalar column of the shot, its rally, and the game
— the whole dictionary as a table. Aggregates `count()`, `sum(x)`,
`avg(x)`, `min(x)`, `max(x)` collapse the result to a single row; mixing an
aggregate with a per-shot property is a validation error unless the per-shot
expressions are `GROUP BY` keys (§6.7). Aggregates coerce their inputs
to numbers and skip unknowns:

- **booleans fold to 1/0** — so `sum(<condition>)` counts matches and
  `avg(<condition>)` is a rate, e.g. `avg(rally.winner = me.team)`;
- finite numbers pass through;
- anything else (strings, …) is unknown and skipped.

An aggregate is an ordinary operand: it may sit anywhere inside a larger
expression, so a rate can be charted as a percentage and two aggregates can
be combined.

```sql
SELECT avg(rally.winner = me.team) * 100 AS "win %",
       max(shot.speed) - min(shot.speed) AS "speed spread"
```

The unknown rules of §4 still apply — an aggregate with nothing to fold
(no shots, or every input unknown) is unknown, and unknown times 100 stays
unknown, never 0. Aggregates never nest (`avg(count())` is a validation
error), and they exist only in `SELECT`, `HAVING`, and a grouped
`ORDER BY` — never in `WHERE` or a `GROUP BY` key, which are evaluated one
shot at a time.

`count()` counts selected shots. PBQL's underlying rows are shots, so rally
and game properties repeat on every selected shot. To calculate a result per
rally, filter to one shot per rally, commonly with `shot.num = 1`.

### 6.7 GROUP BY

```sql
SELECT shot.type, avg(shot.speed) AS "average speed (mph)"
FROM "83gyqyc10y8f"
WHERE shot.hitter = me AND exists(shot.type)
GROUP BY shot.type
```

`GROUP BY expr [, ...]` partitions the `WHERE`-selected shots by the tuple
of key-expression values and outputs **one row per group** instead of
shots. A shot whose key value is unknown is never dropped: it joins the
group whose key is null for that component (the key outputs as null).

Because grouped output is rows, not shots:

- `SELECT` is required, and every `SELECT` and `ORDER BY` expression must
  be built from aggregates, group keys (matched structurally), and
  constants — `avg(shot.speed) * 2` and `count() / rally.num` are fine,
  a bare per-shot property is not. `ORDER BY` aggregates need not appear
  in `SELECT`.
- `CONTEXT BEFORE`/`AFTER` cannot be combined with `GROUP BY`.

Aggregates evaluate per group — `count()` counts the group's shots and
`avg(<condition>)` is a per-group rate, with the same coercion rules as
§6.6. Group keys are constant within their group and evaluate once per
group. Keys may not themselves contain aggregates.

`HAVING <condition>` (written after `GROUP BY`) filters the grouped rows
before `ORDER BY`/`LIMIT`. Aggregates and group keys combine freely in
the condition — `HAVING count() >= 4`, `HAVING rally.num >= 2 AND
avg(shot.speed) > 25`, `HAVING avg(shot.speed) * 1.609 > 50` — but a bare
per-shot property is a validation error (it has no single value within a
group). A group whose condition is unknown (say, an aggregate over
all-unknown inputs) is dropped, like `WHERE`.

Row order: `ORDER BY` sorts the rows by its aggregate/key expressions
(unknown/null values last regardless of direction) and `LIMIT` keeps the
first n rows. Without `ORDER BY`, rows are in a stable ascending order by
group key.

## 7. Data requirements

The engine evaluates PB Vision **augmented insights** JSON, latest major
version (4.x). Older or malformed files are skipped and reported.

Regular (non-augmented) insights JSON is accepted too, but it lacks the
user-context fields augmentation adds, so the properties they power stay
unknown:

- `player_data[p].handedness` (`"left"|"right"|"both"`, from the tagged
  player's profile) powers `shot.strokeType` — without it (or for
  `"both"`-handed players) `strokeType` is unknown; `shot.strokeSide`
  always works.
- `session.videoDurationMs` (the whole video's length) powers
  `game.videoDuration` and lets `secs` context windows clamp at the
  video's end (§6.3).

Player names, the identity of `me`, and tag data come from the host
application — they are not part of the insights file. Queries never
reference raw insights field names; the
[Data Dictionary](data-dictionary.md) is the complete public surface.
