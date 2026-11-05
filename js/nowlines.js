// The "now" line of the OTT Club channels shown in the menu or search stays accurate (DEC-2026-10-26-now-refresh-2):
//  - a row on screen whose next programme is known here (a full or kept guide) turns over at its end by a
//    redraw alone, with no request;
//  - only the rows on screen ask the provider: a row whose programme ended since the last fresh answer that
//    NAMED it was asked for is due at once (an answer that leaves a row out confirms nothing for it); one the
//    provider still named after its end is re-asked NOW_RECHECK_MS after that answer, for as long as it keeps
//    naming it; one it had nothing for, NOW_MISSING_MS after it. While a menu or search is open the list is
//    also re-read NOW_OPEN_REREAD_MS after the last attempt (best effort, under the same gates);
//  - a row lingering on an ended programme is redrawn when the linger ends (its «(шла до HH:MM)» mark), with
//    no request, so a long outage marks it on time;
//  - a refresh is one request for the provider-fresh list (?t=), parsed when the TV is idle (no list rebuild,
//    no reorder, no guide downloads). A failed, empty or unusable answer changes nothing and is retried
//    NOW_RECHECK_MS later (due then, not merely allowed);
//  - gates: NOW_MIN_INTERVAL_MS after the previous answer, NOW_QUIET_MS after the last redraw (keys),
//    NOW_AFTER_LANDING_MS after a channel starts; never during a zap burst or a list load, never in the
//    background; a zap aborts it. The one exception: a launch list from the provider's cache is re-read at once.
//  - D9 (batch 5): that re-read, armed while hidden and seen by no one, is held on coming back to the front until the stream
//    in front has shown a first frame since then, in its current attempt, AND NOW_AFTER_FRONT_MS have passed; a programme surface the viewer opens
//    (a list watched, the banner asked for with INFO, the programme panel) releases it at once. Journaled when held and
//    released.
//   hooks: { onUpdate() }    watch(fn): fn() -> ids of the rows on screen (null: nothing watched)
var NowLines = (function () {
  var req = null, timer = null, flipTimer = null, visible = null, hooks = {};
  var at = 0;                  // when the last answer (or failure) came: the floor counts from it
  var sampled = Util.dict();   // id -> when the last usable fresh answer naming it was asked for (the launch list is not one)
  var retryAfter = 0;          // after a failed, empty or unusable answer: the next request is due then, not before
  var landedAt = 0, renderAt = 0;
  var asap = false;            // the channel list came from the provider's cache: re-read it now (DEC 2026-10-26 option b)
  var heldAt = 0, framedGen = 0;   // D9: the visible moment the re-read is held from (0: not held); the player attempt whose
                                   // first frame came since (0: none; a later failure or reopen makes it stale)

  function setHooks(h) { hooks = h; }
  function loaded() { at = Date.now(); sampled = Util.dict(); }   // the full list just brought "now" lines (not a fresh sample)
  // A request aborted (a zap, a list download, the background) would have re-armed the governor with its answer: it is
  // re-armed here, and its gates (list load, zap burst, background) hold the retry until it may go.
  function cancel() { var aborted = !!req; if (req) { req.abort(); req = null; } asap = false; unhold('(cancelled)'); if (aborted) arm(); }
  // A channel starting frees the bandwidth for its stream, except from the one re-read of a cached list.
  function landed() { if (!asap) cancel(); landedAt = Date.now(); arm(); }
  // Not counted toward the floor: the fresh answer is asked for right away (one request, parsed at idle).
  function cachedList() { at = 0; asap = true; arm(); }

  function watch(fn) { visible = fn; if (fn) unhold('(list)'); arm(); }

  // D9: the app came back to the front from the background (after the player rebuilt its stream; the caller tells only an
  // actual hidden → visible change). panel: the programme panel is open.
  function front(panel) {
    if (asap && !visible && !panel) { heldAt = Date.now(); framedGen = 0; LifeLog.add('now refresh held (front)'); }
    update();
  }
  // D9: a first frame of the stream in front (Player's onFirstFrame event; a detour's frame never reaches it). It counts only
  // while its attempt is the player's current one: a frame of an attempt that later failed keeps the hold.
  function frame() { if (heldAt) { framedGen = Player.attempt(); arm(); } }
  // D9: a programme surface the viewer opened ('(banner)', '(panel)') gets fresh data at once.
  function seen(why) { if (heldAt) { unhold(why); arm(); } }
  function holding() { return !!heldAt && (framedGen !== Player.attempt() || Date.now() < heldAt + CONFIG.NOW_AFTER_FRONT_MS); }
  function unhold(why) { if (heldAt) { heldAt = 0; LifeLog.add('now refresh released ' + why); } }

  // The earliest moment a refresh may be sent.
  function gate() {
    return Math.max(at + CONFIG.NOW_MIN_INTERVAL_MS, renderAt + CONFIG.NOW_QUIET_MS, landedAt + CONFIG.NOW_AFTER_LANDING_MS, retryAfter);
  }

  // One governor for every refresh: the earliest moment a row on screen needs the provider, and the earliest
  // moment one turns over by itself.
  function arm() {
    clearTimeout(timer); clearTimeout(flipTimer); timer = flipTimer = null;
    var now = Date.now();
    if (asap && !req) timer = setTimeout(run, heldAt ? Math.max(0, heldAt + CONFIG.NOW_AFTER_FRONT_MS - now) : 0);   // D9: re-armed by frame()
    if (!visible) return;
    var due = Infinity, flip = Infinity, ids = visible();
    for (var i = 0; i < ids.length; i++) {
      var p = EPG.at(ids[i], now), end = EPG.knownEnd(ids[i]);
      if (p) { if (EPG.at(ids[i], p.stop + 1000)) flip = Math.min(flip, p.stop); else due = Math.min(due, p.stop + CONFIG.NOW_SETTLE_MS); }
      else if (end > now) flip = Math.min(flip, EPG.nextStart(ids[i], now) || Infinity);   // known only from later on: the provider's gap
      else { due = Math.min(due, ended(ids[i], end, now)); flip = Math.min(flip, EPG.lingerEnd(ids[i], now) || Infinity); }
    }
    if (flip < Infinity) flipTimer = setTimeout(flipRows, Math.max(0, flip - now));
    if (asap || req) return;                               // its answer re-arms
    due = Math.min(due, at + CONFIG.NOW_OPEN_REREAD_MS);   // the open menu's re-read: rows scrolled into view are never older
    if (retryAfter) due = Math.min(due, retryAfter);       // a failed answer is asked again then
    timer = setTimeout(run, Math.max(0, Math.max(due, gate()) - now));
  }

  // A row with nothing on air: when it needs the provider (its last known programme ended at `end`; 0: none).
  function ended(id, end, now) {
    if (!end) return at + CONFIG.NOW_MISSING_MS;                         // the provider had nothing for it
    if (end > (sampled[id] || 0)) return now;                             // ended since a fresh answer last named it
    return at + CONFIG.NOW_RECHECK_MS;                                    // the provider still names the ended show
  }

  // A row whose next programme is known turns over with no request (the redraw re-arms).
  function flipRows() { flipTimer = null; if (!document.hidden && hooks.onUpdate) hooks.onUpdate(); }

  function run() {
    timer = null;
    if (Sources.mode() !== 'ott') return;
    if (document.hidden) return;                          // re-armed when the app is visible again (update)
    if (holding()) return;                                // D9: re-armed by the first frame
    unhold('(frame + ' + CONFIG.NOW_AFTER_FRONT_MS / 1000 + ' s)');
    if (!asap && Date.now() < gate()) { arm(); return; }  // a key or a channel start came after it was armed
    if (req || Sources.loading() || Zap.choosing()) { timer = setTimeout(run, CONFIG.NOW_BUSY_RETRY_MS); return; }
    var sent = Date.now();
    req = Net.get({ url: OttClub.freshUrl(), timeoutMs: CONFIG.LIST_TIMEOUT_MS }, function (err, text) {
      req = null; asap = false;
      at = Date.now();
      if (err) { failed(); return; }
      Util.idle(function () {
        var seeds = OttClub.seedsOf(text);
        if (!seeds) { failed(); return; }
        EPG.setSeeds(seeds); retryAfter = 0;
        for (var id in seeds) sampled[id] = sent;           // only the channels it named are confirmed
        if (hooks.onUpdate) hooks.onUpdate();
        arm();
      });
    });
  }
  // Nothing changes; the rows keep what they show and the provider is asked again later.
  function failed() { retryAfter = Date.now() + CONFIG.NOW_RECHECK_MS; arm(); }

  // Called after each render of the watched list: the rows on screen may have changed.
  function update() { renderAt = Date.now(); arm(); }

  return { setHooks: setHooks, loaded: loaded, cachedList: cachedList, cancel: cancel, landed: landed, watch: watch, update: update,
    front: front, frame: frame, seen: seen };
}());
