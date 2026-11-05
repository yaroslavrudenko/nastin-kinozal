// Native Samsung AVPlay (hardware decoding) with a self-healing watchdog; an HTML <video> element off
// the TV, for desktop checks. Every attempt has a generation: a callback of an older attempt does nothing.
//   hooks: { onBuffering(on, phase: 'open' | 'retry' | 'wait' (before the first frame) | 'rebuffer'), onLoading(pct: -1 none),
//            onFirstFrame(), onStable(), onError(n, delayMs), onEnded(), onMutedStart(), onFrozen(on) (FREEZE_AS_BUFFERING),
//            retryTarget() -> { url, archive } | null (archive: a fresh URL at the position shown),
//            detourTarget() -> { url } | null (D6: another channel's live stream, played for a moment) }
// Each attempt's steps are marked in Diag (S-0, review3): Diag.snapshot().attempts on the TV; the life journal (LifeLog, D7)
// records every attempt, AVPlay call (the setting calls of an attempt as one pair, N3), first frame and failure.
var Player = (function () {
  var av = null, video = null, hooks = null;
  var gen = 0, url = null, archive = false;
  var lastTime = -1, lastTimeAt = 0, bufferingSince = 0, bufferStartAt = 0, mediaMs = 0;
  var firstFrame = false, streakFrom = 0, stable = false, info = '', bufferPct = -1, frozen = false;
  var FAST_STORE = 'fastSwitch';
  var retries = 0, retryTimer = null, retryPending = false, restartOnPlay = false, paused = false, suspended = false, WATCHDOG_MS = 1000;
  var attemptAt = 0;                     // when the current attempt started (D6: the absolute first-frame deadline)
  // D6 (COMMON-DECISION player-behind 2026-11-05): live failures of the channel in a row, counted apart from the retry
  // backoff; the failure count at which the next detour is due; a detour waiting in the retry slot; the detour playing
  // ({ url, timer, done }) or null.
  var xFails = 0, nextDetourAt = 0, detourDue = false, detour = null;

  function init(h) {
    hooks = h;
    newEpisode();
    var fast = Util.load(FAST_STORE);
    CONFIG.AV_REUSE_NO_CLOSE = typeof fast === 'boolean' ? fast : CONFIG.FAST_SWITCH_DEFAULT;
    try { av = (window.webapis && window.webapis.avplay) || null; } catch (e) { av = null; Diag.note('avplay', (e && e.message) || String(e)); }
    video = Util.$('html-player');
    if (!av) HtmlVideo.init(video, {
      current: function (my) { return my === gen; },
      playing: function (t) { if (!firstFrame) advanced(t); },
      waiting: bufferingStarted,
      progress: function () { if (bufferingSince) bufferingSince = Date.now(); },   // <video> reports bytes, not a percentage
      time: function (t) { if (bufferingSince && firstFrame) bufferingEnded(); advanced(t); },
      ended: ended, fail: fail, mutedStart: function () { hooks.onMutedStart(); }
    });
    setInterval(tick, WATCHDOG_MS);
  }

  // o: { url, archive, rebuild } — archive: a finite recording, slower to prepare, and it ends; rebuild: the same stream
  // opened again by the app's lifecycle (back from the background, playing behind, a resume), not a choice.
  // A choice (a channel, an archive moment) starts a new failure episode; a rebuild keeps it (D6, fix batch 2 R3).
  function open(o) {
    var reuse = !o.rebuild && healthySwitch();   // D2: decided before the attempt state below is reset
    cancelDetour();
    url = o.url;
    archive = !!o.archive;
    retries = 0;
    paused = false;
    suspended = false;
    restartOnPlay = false;
    if (!o.rebuild) newEpisode();
    start(reuse);
  }
  // D2 (fix batch 2, R6): only a channel change away from established playback in front — its first frame shown, not paused,
  // not buffering — may reuse the stopped player (the fast switch). A retry, a reconnect, the first start, a zap during
  // preparation or behind, a rebuild and a detour always close it first.
  function healthySwitch() {
    return !!url && !document.hidden && firstFrame && !paused && !bufferingSince && !suspended && !retryPending && !restartOnPlay &&
      !detour && retries === 0;
  }
  // D6: X's failures counted from zero, the first detour after DETOUR_AFTER of them, the playlist probed once.
  function newEpisode() { xFails = 0; nextDetourAt = CONFIG.DETOUR_AFTER; }

  // reuse: the stopped player may be opened again without close() (healthySwitch, and the fast switch on).
  function start(reuse) {
    clearTimeout(retryTimer);
    retryPending = false;
    var my = ++gen;
    lastTime = -1; lastTimeAt = Date.now(); bufferingSince = Date.now(); bufferStartAt = 0; mediaMs = 0; bufferPct = -1;
    firstFrame = false; streakFrom = 0; stable = false; info = ''; frozen = false; attemptAt = Date.now();
    Diag.attempt(archive);
    Diag.mark('start');
    LifeLog.add('open ' + (archive ? 'archive ' : 'live ') + url + (retries ? ' (retry ' + retries + ')' : ''));
    hooks.onBuffering(true, retries ? 'retry' : 'open');
    // AVPlay opens in this task, after the hook has updated the banner. BANNER_BEFORE_TEARDOWN (S-3, experiment) waits for the
    // banner's frame first: on the TV that cost +144 ms key→playing (parity probe, 2026-10-28), so it is off.
    if (!av) HtmlVideo.start(my, url);
    else if (CONFIG.BANNER_BEFORE_TEARDOWN) Util.afterPaint(function () { if (my === gen) startAv(my, url, !!reuse, listener(my)); });
    else startAv(my, url, !!reuse, listener(my));
  }

  function listener(my) {
    return {
      onbufferingstart: function () { if (my === gen) { Diag.mark('bufStart'); bufferingStarted(); } },
      onbufferingprogress: function (pct) { if (my === gen) bufferingProgress(pct); },
      onbufferingcomplete: function () { if (my === gen) { Diag.mark('bufDone'); bufferingEnded(); } },
      oncurrentplaytime: function (t) { if (my === gen) { Diag.mark('firstTime'); advanced(t); } },
      // A recording that reaches its end is not an error: the app continues with what follows it.
      onstreamcompleted: function () { if (my === gen) ended(my); },
      onerror: function (e) { fail(my, String(e)); },
      // HTTP error codes, bitrate and resolution changes: recorded only, for now (S-10); cleaned like failLog (batch 5, N2).
      onevent: function (type, data) { if (my === gen) Diag.avEvent(type, LifeLog.clean(data === undefined ? '' : data)); }
    };
  }

  // src: the stream this attempt opens; l: its AVPlay listener.
  function startAv(my, src, reuse, l) {
    Diag.mark('stop');
    avStop();
    Diag.mark('close');
    if (reuse && reusable()) LifeLog.add('av.close skipped (fast switch)'); else avClose();
    try {
      Diag.mark('open');
      native('open', function () { av.open(src); });
      Diag.mark('setup');
      var done = [];
      LifeLog.add('av.setup');
      setting(function () { av.setDisplayRect(0, 0, 1920, 1080); }, 'displayRect', done);
      setting(function () { av.setDisplayMethod(AvTracks.displayMode()); }, 'displayMode', done);
      // The first rendition AVPlay picks (HIGHEST: the best the bandwidth allows; it drops to a lower one rather than
      // stall). An experiment flag (S-4): the TV A/B decides.
      setting(function () { av.setStreamingProperty('ADAPTIVE_INFO', 'STARTBITRATE=' + CONFIG.START_BITRATE); }, 'adaptive', done);
      setting(function () { av.setBufferingParam('PLAYER_BUFFER_FOR_PLAY', 'PLAYER_BUFFER_SIZE_IN_SECOND', CONFIG.BUFFER_PLAY_S); }, 'bufferPlay', done);
      setting(function () { av.setBufferingParam('PLAYER_BUFFER_FOR_RESUME', 'PLAYER_BUFFER_SIZE_IN_SECOND', CONFIG.BUFFER_RESUME_S); }, 'bufferResume', done);
      if (CONFIG.AV_BUFFERING_TIMEOUT_S !== null) setting(function () { av.setTimeoutForBuffering(CONFIG.AV_BUFFERING_TIMEOUT_S); }, 'bufferTimeout', done);
      LifeLog.add('av.setup ok ' + done.join(','));
      native('setListener', function () { av.setListener(l); });
      Diag.mark('prepare');
      native('prepareAsync', function () {
        av.prepareAsync(function () {
          LifeLog.add('av.prepared' + (my === gen ? '' : ' (stale)'));
          if (my !== gen || paused) return;        // paused while preparing: play() starts it later
          Diag.mark('prepared');
          Diag.mark('play');
          try { native('play', function () { av.play(); }); } catch (e) { fail(my, 'play: ' + (e.message || e)); }
        }, function (e) { LifeLog.add('av.prepareAsync failed ' + e); fail(my, String(e)); });
      });
      Diag.mark('prepareCalled');
    } catch (e) {
      fail(my, e.message || String(e));
    }
  }
  function avStop() { try { native('stop', function () { av.stop(); }); } catch (e) { Diag.count('avStopIgnored'); } }
  function avClose() { try { native('close', function () { av.close(); }); } catch (e) { Diag.count('avCloseIgnored'); } }
  // D7: an AVPlay call is journaled before it is made and after it returned (or threw), so a call the TV never returned from
  // is the last line on record; one that threw is written at once, with every line waiting (fix batch 3, S2).
  function native(name, fn) {
    LifeLog.add('av.' + name);
    try { fn(); } catch (e) { refused(name, e); throw e; }
    LifeLog.add('av.' + name + ' ok');
  }
  function refused(name, e) { LifeLog.addNow('av.' + name + ' error ' + ((e && (e.name || e.message)) || e)); }
  // AV_REUSE_NO_CLOSE (S-5, experiment): a stopped player in IDLE is opened again without close().
  function reusable() {
    if (!CONFIG.AV_REUSE_NO_CLOSE) return false;
    try { return av.getState() === 'IDLE'; } catch (e) { return false; }
  }

  // N3 (batch 5): the setting calls of one attempt are journaled as one pair — 'av.setup' before the first (a call the TV never
  // returns from leaves it the last line on record), 'av.setup ok <names>' after the last — not a pair each. One that throws
  // is written at once as 'av.<name> error …' (S2) and listed as '<name>!'. done: the names so far.
  function setting(fn, name, done) {
    try { fn(); done.push(name); } catch (e) {
      done.push(name + '!');
      refused(name, e);
      Diag.count('settingsRejected'); Diag.note('setting.' + name, (e && e.message) || String(e));
    }
  }

  // ---- events shared by both backends ----
  function bufferingStarted() {
    bufferingSince = Date.now(); bufferPct = -1;
    streakFrom = 0; stable = false;      // stability has to be earned again after a rebuffer
    if (firstFrame) { bufferStartAt = Date.now(); Diag.count('rebuffer'); }
    hooks.onBuffering(true, firstFrame ? 'rebuffer' : 'wait');
    hooks.onLoading(-1);
  }
  // Only real progress (a higher percentage) restarts the buffering timeout.
  function bufferingProgress(pct) {
    if (!bufferingSince || !(+pct > bufferPct)) return;
    bufferPct = +pct;
    bufferingSince = Date.now();
    hooks.onLoading(bufferPct);
  }
  function bufferingEnded() {
    if (bufferStartAt) Diag.count('rebufferDone', Date.now() - bufferStartAt);
    bufferingSince = 0; bufferStartAt = 0;
    lastTimeAt = Date.now();             // the stall clock restarts when playback resumes
    hooks.onBuffering(false);
  }
  // t: media time in ms. The first advance after play() is the first frame. STABLE_MS of uninterrupted
  // advancing playback (no rebuffer, no stall, no pause in between) resets the retry backoff.
  function advanced(t) {
    if (detour) { detourEnded('frame'); return; }   // the HTML <video> backend: the detour's first frame
    if (t === lastTime) return;
    var now = Date.now();
    if (!streakFrom || now - lastTimeAt > CONFIG.STALL_TIMEOUT_MS) streakFrom = now;
    lastTime = t; lastTimeAt = now; mediaMs = t;
    unfreeze();
    if (!firstFrame) {
      firstFrame = true; bufferingSince = 0;
      hooks.onBuffering(false);
      Diag.mark('ffRead0');
      info = readInfo();
      if (av) Diag.note('variants', AvTracks.variantCount(av));
      Diag.mark('ffRead1');
      LifeLog.pin('frame', 'first frame ' + (archive ? 'archive' : 'live'));
      hooks.onFirstFrame();
    } else if (!stable && !bufferingSince && now - streakFrom >= CONFIG.STABLE_MS) {
      stable = true; retries = 0;
      newEpisode();                      // D6: a stable stream ends the failure episode
      if (hooks.onStable) hooks.onStable();
    }
  }
  function ended(my) { if (archive) hooks.onEnded(); else fail(my, 'stream ended'); }

  // Growing delays (Util.backoff): 0.5 s, 1 s, 2 s … up to MAX_BACKOFF_MS, retried forever.
  // A failure while paused waits for play(); nothing reopens behind a pause.
  function fail(my, reason) {
    if (my !== gen) return;
    if (detour) { detourEnded('error ' + reason); return; }
    gen++;                               // every remaining callback of the failed attempt is inert
    var delay = Util.backoff(retries, CONFIG.RETRY_MIN_MS, CONFIG.MAX_BACKOFF_MS);
    retries++;
    Diag.fail({ n: retries, gen: gen, reason: LifeLog.clean(reason), url: url });   // S1: failLog, cleaned like the journal
    LifeLog.pinNow('fail', 'fail #' + retries + ' ' + reason);
    countLiveFailure();
    clearTimeout(retryTimer);
    bufferingSince = 0;
    if (paused) { restartOnPlay = true; return; }
    hooks.onError(retries, delay);
    retryPending = true;
    retryTimer = setTimeout(retry, delay);
  }
  // The URL and the mode change together (a live stream resumed after a pause retries as archive).
  function retry() {
    var target = hooks.retryTarget();
    if (target) { url = target.url; archive = target.archive; }
    restartOnPlay = false;
    if (detourDue) { detourDue = false; if (startDetour()) return; }
    start(false);
  }

  // ---- D6: the detour (COMMON-DECISION player-behind 2026-11-05) ----
  // Same-URL retries never cleared the TV's stuck state; a zap to another channel and back did (Q2). After DETOUR_AFTER
  // live failures of X one other channel Y is played for a moment through the same pipeline; X stays the channel (the
  // playback record, the banner, the landing bookkeeping are untouched: Y's frame reaches only detourEnded). X opens again
  // in the next task after Y's first frame, Y's error, or DETOUR_MAX_MS. The next detour comes only after DETOUR_EVERY
  // further failures; a stable X or a new choice (open) starts over; a choice, a pause, the background or a stop cancels it.
  // An archive never detours.
  function countLiveFailure() {
    if (archive) return;
    xFails++;
    if (xFails === CONFIG.DETOUR_AFTER) LifeLog.probe(url);
    if (xFails >= nextDetourAt) detourDue = true;   // cancelled before it runs: due again at the next failure
  }
  function startDetour() {
    nextDetourAt = xFails + CONFIG.DETOUR_EVERY;   // the budget is spent by a detour that starts, not by one that was due
    var y = hooks.detourTarget ? hooks.detourTarget() : null;
    if (!y || !y.url || y.url === url) { LifeLog.addNow('detour: no other channel'); return false; }
    var my = ++gen, d = { url: y.url, done: false, timer: null };
    d.timer = setTimeout(function () { if (detour === d) detourEnded('deadline'); }, CONFIG.DETOUR_MAX_MS);
    detour = d;
    bufferingSince = 0; firstFrame = false;     // the watchdog sleeps during a detour: its own deadline bounds it
    LifeLog.addNow('detour start ' + y.url + ' after ' + xFails + ' failures');
    if (!av) HtmlVideo.start(my, y.url);
    else startAv(my, y.url, false, detourListener(my));
    return true;
  }
  function detourListener(my) {
    function ends(why) { return function () { if (my === gen) detourEnded(why); }; }
    function none() {}
    return { onbufferingstart: none, onbufferingprogress: none, onbufferingcomplete: none, onevent: none,
      oncurrentplaytime: ends('frame'), onstreamcompleted: ends('ended'),
      onerror: function (e) { if (my === gen) detourEnded('error ' + e); } };
  }
  function detourEnded(why) {
    var d = detour;
    if (!d || d.done) return;
    d.done = true;
    gen++;                               // Y's remaining callbacks are inert
    LifeLog.addNow('detour result ' + why);
    setTimeout(function () { if (detour === d) { cancelDetour(); start(false); } }, 0);
  }
  function cancelDetour() {
    detourDue = false;
    if (!detour) return;
    clearTimeout(detour.timer);
    if (!detour.done) LifeLog.add('detour cancelled');
    detour = null;
  }

  function tick() {
    if (!url || paused || suspended || retryPending || detour) return;
    var now = Date.now(), state;
    // An unreadable state is counted as unknown (the buffering timeout still applies). Buffering is timed from
    // its last progress. A player left IDLE/NONE while visible (released by the TV or another app) never plays again.
    if (av) { try { state = av.getState(); } catch (e) { state = ''; Diag.count('getStateFailed'); } } else state = video.paused ? 'PAUSED' : 'PLAYING';
    var limit = archive ? CONFIG.ARCHIVE_BUFFER_TIMEOUT_MS : CONFIG.BUFFER_TIMEOUT_MS, released = !!av && !document.hidden && (state === 'IDLE' || state === 'NONE');
    // D6: buffering progress keeps postponing the buffering timeout; a live attempt still gets an absolute first-frame deadline.
    if (!archive && !firstFrame && now - attemptAt > CONFIG.LIVE_FIRST_FRAME_MS) { fail(gen, 'no first frame in ' + Math.round((now - attemptAt) / 1000) + ' s'); return; }
    if (bufferingSince) { if (now - bufferingSince > limit) fail(gen, 'buffering timeout ' + Math.round((now - bufferingSince) / 1000) + ' s'); return; }
    if (CONFIG.FREEZE_AS_BUFFERING && !frozen && firstFrame && state === 'PLAYING' && now - lastTimeAt > CONFIG.FREEZE_MS) { frozen = true; hooks.onFrozen(true); }
    if ((state === 'PLAYING' || released) && now - lastTimeAt > CONFIG.STALL_TIMEOUT_MS) fail(gen, released ? 'player released (' + state + ')' : 'stalled');
  }

  // FREEZE_AS_BUFFERING (S-2, experiment): the frozen picture's indicator goes when time moves again or on a pause; the
  // stall timeout above still decides a reconnect.
  function unfreeze() { if (frozen) { frozen = false; hooks.onFrozen(false); } }

  // ---- control ----
  // A pause also holds a pending retry: it runs on play(), not behind the pause.
  function pause() {
    var inDetour = !!detour;
    paused = true;
    streakFrom = 0; stable = false;
    unfreeze();
    cancelDetour();
    if (inDetour) {                      // the detour's stream is not the channel: it stops, and play() opens X again
      gen++; restartOnPlay = true;
      if (av) avStop(); else HtmlVideo.pause();
      return;
    }
    if (retryPending) { clearTimeout(retryTimer); retryPending = false; restartOnPlay = true; }
    try { if (av) native('pause', function () { av.pause(); }); else HtmlVideo.pause(); } catch (e) { Diag.note('pause', (e && e.message) || String(e)); }
  }
  // Resumes a native pause; a failure goes through the normal retry (archive: at the shown position).
  function play() {
    if (!url) return;                    // stopped: an unplayable channel (stop)
    paused = false;
    lastTimeAt = Date.now(); attemptAt = Date.now();
    if (restartOnPlay) { retry(); return; }
    if (!av) { HtmlVideo.play(); return; }
    try { native('play', function () { av.play(); }); } catch (e) { fail(gen, 'resume: ' + (e.message || e)); }
  }
  // The app goes to the background: the pipeline is released with stop + close, never AVPlay's suspend() (D1, COMMON-DECISION
  // player-behind 2026-11-05: a native session kept across the background is a candidate for the TV ending the app); the
  // app reopens explicitly on return.
  function suspend() {
    suspended = true;
    gen++;                               // callbacks of the suspended attempt are inert
    clearTimeout(retryTimer);
    retryPending = false;
    cancelDetour();
    if (av) { avStop(); avClose(); } else HtmlVideo.pause();
  }
  // A channel the TV cannot play (M3U.unplayable, review3 F-S12): the stream on screen stops and nothing opens or retries
  // until the next open.
  function stop() {
    gen++;                               // callbacks of the stopped attempt are inert
    url = null; retries = 0; paused = false; suspended = false; restartOnPlay = false; bufferingSince = 0; firstFrame = false;
    clearTimeout(retryTimer);
    retryPending = false;
    cancelDetour();
    if (av) { avStop(); avClose(); } else HtmlVideo.pause();
  }
  // Network restored: the same path as a retry, so an archive resumes at the position shown (D2: close → open).
  function reconnect() { if (url && !paused && !suspended) { cancelDetour(); retries = 0; retry(); } }
  function mediaTimeMs() { return mediaMs; }
  // D7 (fix batch 2, R2): failing or detouring — the journal is written at once meanwhile.
  function recovering() { return retries > 0 || !!detour; }

  // Technical line for the banner: read once per attempt at its first frame ('' before it).
  // fresh = true re-reads it (BLUE key, «⚙ Настройки»: the bitrate may have changed).
  function streamInfo(fresh) {
    if (fresh && firstFrame) info = readInfo();
    return firstFrame ? info : '';
  }
  function readInfo() { return av ? AvTracks.streamInfo(av) : HtmlVideo.info(); }
  function audioTracks() { return av ? AvTracks.audioTracks(av) : []; }
  function selectAudio(index) { return !!av && AvTracks.selectAudio(av, index); }
  function cycleDisplay() { return AvTracks.cycleDisplay(av); }
  function setFullScreen(on) { return AvTracks.setFullScreen(av, on); }
  // «Быстрое переключение каналов»: a channel change reuses the stopped player (no close(), S-5); saved, used from the next zap.
  function fastSwitch() { return CONFIG.AV_REUSE_NO_CLOSE; }
  function setFastSwitch(on) { CONFIG.AV_REUSE_NO_CLOSE = on; Util.save(FAST_STORE, on); }

  return {
    init: init, open: open, stop: stop, pause: pause, play: play, suspend: suspend, reconnect: reconnect, recovering: recovering,
    mediaTimeMs: mediaTimeMs, streamInfo: streamInfo, audioTracks: audioTracks, selectAudio: selectAudio,
    cycleDisplay: cycleDisplay, fullScreen: AvTracks.fullScreen, setFullScreen: setFullScreen,
    fastSwitch: fastSwitch, setFastSwitch: setFastSwitch, unmute: function () { return !av && HtmlVideo.unmute(); },
    attempt: function () { return gen; }   // D9: the current attempt's generation (a failure, reopen or stop moves it on)
  };
}());
