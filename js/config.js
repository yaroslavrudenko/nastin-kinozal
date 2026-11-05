// Build-time settings and every tuning number of the app (SSOT). build.sh fills the three '__…__'
// placeholders from build.local.env (never committed).
// OTT_KEY set -> channels come from the OTT Club API; otherwise PLAYLIST_URL (any M3U) is used.
var CONFIG = {
  OTT_SERVER: 'myott.top',
  OTT_SCHEME: 'http',          // the provider serves keys and streams over http; https is unverified on the TV
  OTT_KEY: '__OTT_KEY__',
  PLAYLIST_URL: '__PLAYLIST_URL__',
  EPG_URL: '',                 // empty = use url-tvg from the playlist header
  VERSION: '1.9.4',            // must equal config.xml's version
  BUILD: '__BUILD__',          // filled by build.sh: commit and date
  // «📡 Провайдеры» (owner, 2026-10-27: a source is a provider; inside it the channels are grouped as the
  // provider gives them; a provider that gives separate playlists is a source of playlists): OTT Club (key),
  // the free iptv-org provider with its playlists (its whole public list first, ~11 000 channels; it can never
  // be removed) and the viewer's own providers (an M3U link each).
  FREE_PROVIDERS: [
    { id: 'iptvorg', playlists: [                       // names: I18n 'p.<id>' / 'pl.<id>'
      { id: 'all', url: 'https://iptv-org.github.io/iptv/index.m3u' },
      { id: 'il', url: 'https://iptv-org.github.io/iptv/countries/il.m3u' },
      { id: 'ua', url: 'https://iptv-org.github.io/iptv/countries/ua.m3u' },
      { id: 'rus', url: 'https://iptv-org.github.io/iptv/languages/rus.m3u' },
      { id: 'eng', url: 'https://iptv-org.github.io/iptv/languages/eng.m3u' },
      { id: 'news', url: 'https://iptv-org.github.io/iptv/categories/news.m3u' },
      { id: 'kids', url: 'https://iptv-org.github.io/iptv/categories/kids.m3u' },
      { id: 'music', url: 'https://iptv-org.github.io/iptv/categories/music.m3u' },
      { id: 'movies', url: 'https://iptv-org.github.io/iptv/categories/movies.m3u' },
      { id: 'documentary', url: 'https://iptv-org.github.io/iptv/categories/documentary.m3u' },
      { id: 'sports', url: 'https://iptv-org.github.io/iptv/categories/sports.m3u' }
    ] }
  ],

  // channel list
  PLAYLIST_REFRESH_MS: 3600 * 1000,   // the channel list and its groups, every provider (owner 2026-10-27: «Нужно сделать раз в час»; was 6 h)
  SWITCH_PAINT_MS: 300,        // «Провайдеры»: the switch message is painted before the app starts again
  LIST_TIMEOUT_MS: 20000,
  LIST_RETRY_MIN_MS: 10000,
  LIST_RETRY_MAX_MS: 300000,
  SNAPSHOT_MAX_CHARS: 2500000, // offline copy of the list; bigger lists are not kept
  // "now" lines (DEC-2026-10-26-now-refresh-2)
  NOW_SETTLE_MS: 1000,         // a visible row's "now" is re-read this long after its programme ends
  NOW_MIN_INTERVAL_MS: 10000,  // from one "now" answer (or failure) to the next request
  NOW_RECHECK_MS: 60000,       // an ended show the provider still named, or a failed answer, is re-asked after this
  NOW_QUIET_MS: 1000,          // no "now" request until the menu has not been redrawn (keys) for this long
  NOW_OPEN_REREAD_MS: 60000,  // while a menu or search is open the whole list is re-read this often, so a row scrolled into view is never older (owner 2026-10-26: accuracy over the 5-min saving)
  NOW_MISSING_MS: 300000,      // rows the provider had nothing for, and the open menu's whole list, are re-asked after this
  NOW_STALE_MS: 60000,         // an answer naming a show that ended this long before it arrived came from a stale cache
  NOW_LINGER_MS: 900000,       // the provider still names an ended programme up to this long (seen: 7+ min at 03:00)
  NOW_AFTER_LANDING_MS: 5000,  // no refresh this soon after a channel starts (the stream has the bandwidth)
  NOW_BUSY_RETRY_MS: 1000,     // a refresh held back (zap, list loading) is tried again after this
  OVERLAY_QUIET_MS: 1500,      // background data redraws an open menu only after this long without a key
  GUIDE_KEEP_AFTER_EVICT: 3,   // programmes kept (from now on) when a full guide leaves the cache

  // per-channel guide (OTT Club) and XMLTV (M3U)
  ARCHIVE_DAYS: 7,
  ARCHIVE_EDGE_MARGIN_MS: 600000,   // nothing older than ARCHIVE_DAYS minus this is opened (or retried)
  ARCHIVE_SPAN_MS: 14400000,        // one archive request covers at most 4 h (OTT Club answers 404 past 24–48 h); the player continues
  ARCHIVE_MIN_SPAN_MS: 300000,      // a programme's last minutes are asked for together with the next one (a few-second recording ended at once: F-S8)
  ARCHIVE_DAYS_UNDECLARED: 3,       // a playlist declaring catch-up without days: its window is assumed this long, not ARCHIVE_DAYS (F-S13)
  GUIDE_TIMEOUT_MS: 15000,
  GUIDE_FRESH_MS: 3600000,
  GUIDE_RETRY_MIN_MS: 30000,
  GUIDE_RETRY_MAX_MS: 600000,
  GUIDE_CACHE_CHANNELS: 24,    // full guides kept in memory; older ones fall back to the "now" line
  XMLTV_TIMEOUT_MS: 60000,
  XMLTV_MAX_BYTES: 30 * 1024 * 1024,
  XMLTV_REFRESH_MS: 12 * 3600 * 1000,
  XMLTV_RETRY_MIN_MS: 60000,
  XMLTV_RETRY_MAX_MS: 30 * 60000,
  SLICE_MS: 8,                 // longest piece of parsing per task, so a key press never waits


  // player
  BUFFER_PLAY_S: 5,
  BUFFER_RESUME_S: 10,
  BUFFER_TIMEOUT_MS: 15000,    // live: stuck in buffering this long (no progress) -> reconnect
  ARCHIVE_BUFFER_TIMEOUT_MS: 30000,   // archive recordings take longer to open
  STALL_TIMEOUT_MS: 8000,      // playing but time not advancing this long -> reconnect
  RETRY_MIN_MS: 500,
  MAX_BACKOFF_MS: 15000,
  STABLE_MS: 20000,            // the retry backoff resets only after this much advancing playback
  LIVE_SNAP_MS: 120000,        // archive within 2 min of live plays live instead
  // The big centre spinner (review3 F-S1/F-S2; owner 2026-10-27: buffering stays, the viewer must not keep seeing it).
  // The banner's state line («Подключение…», «Загрузка видео… N%», «Нет сигнала — повтор…») is not delayed.
  SPINNER_GRACE_START_MS: 1600,     // an open shows it only once buffering lasted this long (96 % of opens move by 1.8 s on the TV)
  SPINNER_GRACE_REBUFFER_MS: 1000,  // a rebuffer: this long (the measured ones lasted 0.04–0.4 s)
  NO_SIGNAL_AFTER: 4,          // from this many failures in a row: «Нет сигнала» toast and no spinner on further retries
  // Experiments (review3 S-2/S-4/S-5/S-7/S-8): the defaults are the measured behaviour; a value changes only after a TV A/B.
  // Read at each open, so a TV probe may set them at runtime (CONFIG.START_BITRATE = 'AVERAGE').
  START_BITRATE: 'HIGHEST',    // ADAPTIVE_INFO STARTBITRATE: 'HIGHEST' | 'AVERAGE' | 'LOWEST' (S-4)
  AV_REUSE_NO_CLOSE: false,    // true: a channel change skips close() when the stopped player is IDLE (S-5); set at boot from
                               // the «Быстрое переключение каналов» setting (Player.setFastSwitch), a probe may still override it
  FAST_SWITCH_DEFAULT: true,   // that setting's value until the viewer changes it (TV: −40…−100 ms per zap; 203-zap soak: 0 failures)
  BANNER_BEFORE_TEARDOWN: false,   // true: AVPlay's stop/close/open wait for the banner's frame to be painted (S-3; TV: +144 ms key→playing)
  AV_BUFFERING_TIMEOUT_S: null,   // a number: AVPlay setTimeoutForBuffering (seconds); null: AVPlay's own 20 s (S-8)
  FREEZE_AS_BUFFERING: false,  // true: a picture frozen for FREEZE_MS shows the spinner (after the rebuffer grace) (S-2)
  FREEZE_MS: 2000,
  ARCHIVE_LONG_CONTINUATION: false,   // true: an archive request asks for ARCHIVE_SPAN_MS, not one programme (S-7)
  HLS_JS_URL: 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js',
  HLS_JS_SRI: 'sha384-9v3HcdYrO3D+OPDTjZ40RXocgE4GtXVCd3/mCS62JsM93JXgI1afJVuwjFvsu6ni',

  // zapping and screens
  ZAP_SETTLE_MS: 350,          // inside a burst of presses only the channel stopped on is opened
  ZAP_IDLE_MS: 1000,           // a press this long after the previous one opens at once
  ZAP_BUSY_MS: 3000,
  LANDING_SAVE_MS: 1000,       // a channel is remembered once it has played this long
  BANNER_MS: 5000,
  TECH_LINE_MS: 5000,          // the stream's technical line shows this long after a channel opens
  TECH_POLL_MS: 500,           // re-read while the player has not described the stream yet
  TECH_WAIT_MS: 15000,         // «…» waits this long for the player's description; the TECH_LINE_MS window starts when it arrives
  TOAST_MS: 2500,
  NUMBER_ENTRY_MS: 1800,
  EXIT_CONFIRM_MS: 2000,
  VISIBLE_ROWS: 13,
  // «Вид меню» (owner 2026-10-28): «Подробный» (Advanced, the groups and channels side by side) or «Крупный» (Basic, for
  // poor eyesight: big group cards, then a big full-screen channel list)
  MENU_BASIC_DEFAULT: true,    // the layout until the viewer chooses one: Basic, the large menu (owner 2026-10-28)
  BASIC_COLS: 3,               // Basic: cards per row (a 15-letter Russian group name stays whole at 60 px)
  BASIC_CARD_ROWS: 3,          // Basic: rows of cards on screen; the window moves one row at a time
  BASIC_ROWS: 8,               // Basic: the list's rows (the pool): 7 one-line rows fit whole, wrapped ones fewer (owner 2026-10-28)
  LOGO_STARTS_PER_SLOT: 3,     // logo downloads started in one idle slot (never in a key's task)
  LOGO_SLOT_MIN_MS: 8,         // an idle slot shorter than this starts none (it waits for the next)
  LOGO_PUTS_PER_FRAME: 4,      // pictures that arrived together go into rows at most this many per frame
  LOGO_AHEAD_ROWS: 26,         // a list asks for this many rows ahead of its page the way the cursor moves (every list,
  LOGO_BEHIND_ROWS: 13,        // whatever its rows on screen: Basic's 5-row page keeps Advanced's look-ahead, P-1) and this many behind
  LOGO_ZAP_PAUSE_MS: 3000,     // after a zap / stream start the group trickle waits this long (the stream first)
  LOGO_GROUP_MAX: 400,         // the zap group's / highlighted group's logos loaded in the background, at most (= LOGO_KEEP)
  LOGO_PARALLEL: 6,            // logo downloads at a time (Chromium 47 opens at most 6 per host)
  LOGO_KEEP: 400,              // loaded logos kept in memory (the whole OTT Club list); beyond it the least recently shown go
  LOGO_EVICT: 50,              // how many of the least recently shown go at once when LOGO_KEEP is passed
  LOGO_TIMEOUT_MS: 8000,       // a logo download not answered by then is given up (its slot freed); asked again at the next hourly list
  SEARCH_ROWS: 9,
  SEARCH_LIMIT: 60,
  DIAG_FLUSH_MS: 30000,
  DIAG_LOG_LINES: 40,
  DIAG_ATTEMPTS: 20,           // playback attempts whose timeline Diag.snapshot() keeps (S-0; memory only, never stored)

  // After hours behind the dashboard (COMMON-DECISION player-behind, 2026-11-05)
  BACK_GUARD_MS: 1500,         // D8: Back this soon after the player comes to the front never counts towards the double-Back exit
  LIVE_FIRST_FRAME_MS: 30000,  // D6: a live attempt with no first frame by then fails, whatever its buffering progress says
  DETOUR_AFTER: 3,             // D6: live failures of a channel in a row before one other channel is played for a moment
  DETOUR_EVERY: 20,            // D6: further failures before the next such detour
  DETOUR_MAX_MS: 15000,        // D6: the other channel is left at the latest this long after it was opened
  LIFE_LINES: 200,             // D7: lines in the life journal's ring (localStorage lifeLog.<n>)
  LIFE_PREV_LINES: 60,         // D7: the previous launch's last lines kept at boot (lifeLogPrev)
  LIFE_ALIVE_MS: 5000,         // D7: the alive record (lifeAlive), front or behind; routine lines waiting in memory are written with it
  LIFE_FLUSH_CHUNK: 20,        // D7 (fix batch 3, S3): journal writes in one task of the alive tick's flush; the rest in the next tasks
  LIFE_SYNC_MS: 10000,         // D7 (fix batch 2, R2): every line is written at once this long after the player comes to the front
  LIFE_TEXT_MAX: 200,          // D7: a line's text (cleaned first), at most this many characters
  PROBE_TIMEOUT_MS: 8000,      // D7: the one GET of a failing live playlist
  PROBE_MAX_BYTES: 65536
};
