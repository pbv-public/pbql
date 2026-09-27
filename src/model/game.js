// Wraps one (video, session)'s insights JSON plus host-supplied metadata
// into the indexed, memoized shape the engine evaluates against.
//
// Supported input: PB Vision insights, latest major version (4.x), augmented
// field names. Older majors are rejected — callers skip the game and warn
// (reprocessing the video brings it up to the current major).

export const SUPPORTED_MAJOR = 4

export class UnsupportedInsightsError extends Error {
  constructor (version) {
    super(`unsupported insights version "${version}" (supported: ${SUPPORTED_MAJOR}.x); ` +
      'reprocess the video to query it')
    this.name = 'UnsupportedInsightsError'
    this.code = 'PBQL_UNSUPPORTED_VERSION'
    this.version = version
  }
}

export class InvalidInsightsError extends Error {
  constructor (detail) {
    super(`malformed insights JSON (${detail}); ` +
      'is this really a PB Vision insights file?')
    this.name = 'InvalidInsightsError'
    this.code = 'PBQL_INVALID_INSIGHTS'
  }
}

function validateInsights (insights) {
  if (insights === null || typeof insights !== 'object' ||
      Array.isArray(insights)) {
    throw new InvalidInsightsError('expected an object')
  }
}

function validateRallies (insights) {
  if (!Array.isArray(insights.rallies)) {
    throw new InvalidInsightsError('"rallies" is missing or not an array')
  }
  insights.rallies.forEach((rally, rallyIdx) => {
    if (rally === null || typeof rally !== 'object') {
      throw new InvalidInsightsError(`rallies[${rallyIdx}] is not an object`)
    }
    if (rally.shots !== undefined && !Array.isArray(rally.shots)) {
      throw new InvalidInsightsError(`rallies[${rallyIdx}].shots is not an array`)
    }
    // every shot is read property by property, so a shot that is not an
    // object makes the whole game unqueryable rather than merely unknown
    const shots = rally.shots ?? []
    shots.forEach((shot, shotIdx) => {
      if (shot === null || typeof shot !== 'object') {
        throw new InvalidInsightsError(
          `rallies[${rallyIdx}].shots[${shotIdx}] is not an object`)
      }
    })
  })
}

export class Game {
  /**
   * @param {object} args
   * @param {string} args.vid the video ID
   * @param {number} args.sessionIdx 0-based session index within the video
   * @param {object} args.insights parsed insights JSON (augmented names)
   * @param {object} [args.meta] host-supplied metadata: players
   *   ([{uid?, name?, addr?}] by player index), myPlayerIdx, videoName,
   *   gameEpoch (when the game was played, in epoch seconds), tz (the
   *   IANA zone date() renders in — e.g. the signed-in user's — else
   *   the process's own local zone)
   */
  constructor ({ vid, sessionIdx, insights, meta }) {
    validateInsights(insights)
    const version = insights.version ?? insights.serverMetadata?.version
    const major = parseInt(version)
    if (isNaN(major) || major !== SUPPORTED_MAJOR) {
      throw new UnsupportedInsightsError(version)
    }
    validateRallies(insights)
    this.vid = vid
    this.sessionIdx = sessionIdx
    this.insights = insights
    this.meta = meta ?? {}
    // one flat entry per shot, in video order — the engine's iteration unit
    this.shotRefs = []
    insights.rallies.forEach((rally, rallyIdx) => {
      (rally.shots ?? []).forEach((shot, shotIdx) => {
        this.shotRefs.push({ game: this, rally, rallyIdx, shot, shotIdx })
      })
    })
  }

  get rallies () {
    return this.insights.rallies
  }

  // when the ball was struck (ms); trajectory timing is the precise source,
  // shot.start_ms the fallback (same fallback the web app uses)
  hitMs (shot) {
    return shot.resulting_ball_movement?.trajectory?.start?.ms ?? shot.start_ms
  }

  // when the shot's flight ended (ms)
  endMs (shot) {
    return shot.resulting_ball_movement?.trajectory?.end?.ms ?? shot.end_ms
  }

  // the given player's court position when the shot was hit, or undefined
  playerPosAtShot (shot, playerIdx) {
    return shot.player_positions?.[playerIdx] ?? undefined
  }

  // whether this player slot is occupied (singles leave slots 1 and 3 empty)
  playerExists (playerIdx) {
    const playerData = this.insights.player_data
    if (Array.isArray(playerData)) { // absent (or null) falls back below
      return playerData[playerIdx] !== null && playerData[playerIdx] !== undefined
    }
    return this.insights.session?.num_players === 2
      ? playerIdx === 0 || playerIdx === 2
      : true
  }

  // the tagged name, else the insights default, else "Player N" — every
  // existing player is queryable by the name the UI shows for them
  playerName (playerIdx) {
    if (!this.playerExists(playerIdx)) {
      return undefined
    }
    return this.meta.players?.[playerIdx]?.name ??
      this.insights.player_data?.[playerIdx]?.name ??
      `Player ${playerIdx + 1}`
  }

  // Every player listed under `name`, exactly as playerName gives it (so
  // an untagged "Player 3" is found by that name too)
  playersNamed (name) {
    this.namedPlayers ??= new Map()
    if (!this.namedPlayers.has(name)) {
      this.namedPlayers.set(name, [0, 1, 2, 3].filter(playerIdx =>
        this.playerName(playerIdx) === name))
    }
    return this.namedPlayers.get(name)
  }

  // player("Name"): the one player of that name, or undefined when the game
  // has none or several (the query warns which)
  playerNamed (name) {
    const players = this.playersNamed(name)
    return players.length === 1 ? players[0] : undefined
  }

  playerTeam (playerIdx) {
    // convention: players 0-1 are team 0, players 2-3 are team 1
    return this.insights.player_data?.[playerIdx]?.team ?? (playerIdx < 2 ? 0 : 1)
  }

  // The player's handedness, when the serving layer augmented the insights
  // with it (player_data[p].handedness, from the tagged user's profile;
  // bucket-fetched insights lack it). Only "left"/"right" are usable —
  // "both" (or anything unexpected) cannot orient a stroke, so it reads as
  // unknown here.
  playerHandedness (playerIdx) {
    const handedness = this.insights.player_data?.[playerIdx]?.handedness
    return handedness === 'left' || handedness === 'right' ? handedness : undefined
  }

  // One of the player's ratings for THIS game
  // (player_data[p].trends.ratings — the single-game summary, not a career
  // rating). It is constant across every shot of the game, like a game
  // property, so avg() over a game returns the rating itself and GROUP BY
  // game gives one point per game.
  //
  // Unknown for a slot the game does not have, for a player the engine did
  // not rate, and for insights carrying no trends at all — never coerced,
  // since an unrated game must not read as a rating of zero.
  playerRating (playerIdx, key) {
    if (!this.playerExists(playerIdx)) {
      return undefined
    }
    const rating = this.insights.player_data?.[playerIdx]?.trends?.ratings?.[key]
    return Number.isFinite(rating) ? rating : undefined
  }

  // The host's "me" slot, when it names a player at all: anything else (no
  // tag, or a null one) reads as untagged, so `me` conditions are unknown
  // and the query reports why (PBQL_ME_NOT_TAGGED).
  get myPlayerIdx () {
    const idx = this.meta.myPlayerIdx
    return Number.isInteger(idx) ? idx : undefined
  }

  // The whole video's duration (ms), when the serving layer augmented the
  // insights with it (session.videoDurationMs; bucket-fetched insights
  // lack it). Values that cannot bound a video (non-numbers, non-finite,
  // <= 0) read as absent.
  get videoDurationMs () {
    const ms = this.insights.session?.videoDurationMs
    return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : undefined
  }
}
