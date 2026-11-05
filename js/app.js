// Boot, wiring of the modules' hooks, and the remote-control keys while watching.
(function () {
  var lastBack = 0, visibleAt = 0, guideNoticeShown = false, failures = 0;
  var away = false;                    // D9: hidden since the last 'visible' (Tizen also reports 'visible' at launch)

  // Optional platform setup: a throw is recorded and boot carries on (a TV refusing one of these calls
  // must never leave the screen black).
  function optional(name, fn) { try { fn(); } catch (e) { Diag.note('boot.' + name, (e && (e.code || e.message)) || String(e)); } }

  // Required steps first, then the list and the saved channel, then the optional platform setup.
  function boot() {
    LifeLog.start(lifeStatus, lifeUrgent);   // D7: first, so a boot that dies is on record
    UI.init();
    I18n.apply();                      // the interface language (RU by default) and its writing direction
    Overlay.onBeforeOpen(function () { NumEntry.cancel(); Zap.cancel(); });
    Player.init({
      // The state line on the banner while there is no picture (not over a zap burst's preview), at once; the big spinner
      // only when the wait is long (streamSpinner).
      onBuffering: function (on, phase) { streamSpinner(on, phase); if (!on) Banner.resumed(); else { if (!Zap.choosing()) Banner.connecting(); } },
      onLoading: function (pct) { if (!Zap.choosing()) Banner.loading(pct); },
      // The picture is up: the banner with this stream's technical line, at once.
      onFirstFrame: function () {
        UI.spinner(false); Playback.onFirstFrame(); NowLines.frame();
        Zap.onFirstFrame(); Util.idle(prepareMenu);   // menu laid out ahead, hidden
        if (!Zap.choosing()) Banner.onFirstFrame();
      },
      // The first three retries (≈3.5 s) are silent (a channel switch or a short hiccup is not "no signal"); none over a menu.
      // From the fourth, «no signal»: the menu is laid out ahead now (it would be at the first frame), so the viewer
      // reaching for it finds it ready. During the silent retries the stream keeps the bandwidth (logos) and the thread
      // (layout) to itself (review 4, P4-2).
      // The backoff wait shows no spinner: the banner says «Нет сигнала — повтор через N с» (review3 S-6).
      onError: function (n, delay) {
        failures = n;
        UI.spinner(false);
        if (n >= CONFIG.NO_SIGNAL_AFTER) { if (Overlay.isNone()) UI.toast(I18n.t('m.noSignal', n), delay + 500); Util.idle(prepareMenu); }
        if (!Zap.choosing()) Banner.retrying(n, delay);
      },
      onEnded: Playback.onEnded,
      onMutedStart: function () { UI.toast(I18n.t('m.soundAfterKey'), 6000); },
      onFrozen: function (on) { streamSpinner(on, 'rebuffer'); },
      retryTarget: Playback.retryTarget,
      detourTarget: Playback.detourTarget
    });
    Playback.setHooks({ onOpened: function () { Banner.show(false); Diag.mark('banner'); }, onBanner: function () { Banner.show(true); },
      onUnplayable: function () { UI.spinner(false); UI.toast(I18n.t('m.unplayable'), 5000); } });
    // A fresh "now" answer redraws what shows it: the open overlay, and the banner while it is up (D9).
    NowLines.setHooks({ onUpdate: function () { Banner.onGuide(null); Overlay.refreshQuiet(); } });
    Sources.setHooks({ onApplied: onListApplied, onFatal: UI.fatal, onSpinner: UI.spinner, onGuide: Overlay.refresh,
      onNotice: function (text) { UI.toast(text, 5000); } });
    EPG.setHooks({
      onGuide: function () { Banner.onGuide(null); Overlay.refresh(); },
      onXmltvFailed: function () { if (!guideNoticeShown) UI.toast(I18n.t('m.guideDown'), 5000); guideNoticeShown = true; }
    });
    document.addEventListener('keydown', function (e) {
      LifeLog.add('key ' + (inTextField(e) ? '(text field)' : e.keyCode) + (e.repeat === true ? ' repeat' : ''));
      Diag.key();
      if (Player.unmute()) UI.toast(I18n.t('m.soundOn'), 1200);
      onKey(e);
    });
    document.addEventListener('click', onClick);
    document.addEventListener('visibilitychange', onVisibility);
    optional('pagehide', function () {
      window.addEventListener('pagehide', function () { LifeLog.addNow('pagehide'); });
      window.addEventListener('unload', function () { LifeLog.addNow('unload'); });
    });
    var chosen = startSource();
    optional('fit', function () { UI.fitDesktop(); window.addEventListener('resize', UI.fitDesktop); });
    optional('hint', function () {
      if (chosen) UI.toast(I18n.t(window.webapis ? 'h.first' : 'h.firstDesktop'), 7000);
    });
    optional('network', Playback.watchNetwork);
    optional('control', function () { RemoteControl.listen({ 'play-behind': Playback.playBehind, 'stop-behind': Playback.stopBehind }); });
    optional('keys', Keys.register);   // right away: CH± and digits pressed in the first seconds must work
  }

  // At the first frame Zap has started Logos already; at the 4th failed attempt no picture competes for the network, so
  // the menu laid out ahead gets its page's logos too (fix batch 8 kept them waiting for a picture that never came).
  function prepareMenu() { if (Channels.count()) Logos.start(); Overlay.prepare('menu'); }

  // The big centre spinner of a stream (review3 S-1, S-6; owner 2026-10-27: the viewer must not keep seeing it, buffering
  // stays): an open shows it once buffering lasted SPINNER_GRACE_START_MS, a rebuffer SPINNER_GRACE_REBUFFER_MS; it goes
  // at once when playback moves. A retry after NO_SIGNAL_AFTER failures in a row shows none: «no signal» stays static.
  function streamSpinner(on, phase) {
    if (!on) { UI.spinner(false); return; }
    if (phase === 'open') failures = 0;
    if (phase === 'open' || phase === 'retry') {
      UI.spinner(false);
      if (failures < CONFIG.NO_SIGNAL_AFTER) UI.spinnerAfter(CONFIG.SPINNER_GRACE_START_MS);
    } else if (phase === 'rebuffer') UI.spinnerAfter(CONFIG.SPINNER_GRACE_REBUFFER_MS);
  }

  // The list loads and the saved channel starts (in its own task right after this one). With no source (a first launch:
  // nothing chosen or built in; or a source built into an older build only) «📡 Провайдеры» opens to choose it, with
  // nothing playing behind it (owner, 2026-10-27: «А если я первый раз установил плеер и запустил — мне он должен
  // предложить выбрать источник»); the choice starts the app on it, and from then on it opens the last source, group
  // and channel. false: the source is being chosen.
  function startSource() {
    if (Sources.firstLaunch()) { Overlay.open('sources', { first: true }); return false; }
    var mode = Sources.mode();
    Sources.start();
    setTimeout(function () {
      var last = Sources.lastChannel();
      if (!Playback.current() && last && last.key.indexOf(mode + ':') === 0 && Channels.adultAllowed(last)) Zap.pick(last);
    }, 0);
    return true;
  }

  // The list arrived: keep what is playing (with its fresh record), or start the first channel.
  function onListApplied(firstLoad) {
    var cur = Playback.current(), fresh = cur ? Channels.get(cur.key) : null;
    if (fresh) Playback.adopt(fresh);
    Zap.onListApplied();
    if (firstLoad && !Channels.isEligible(fresh)) startFirst();
    Overlay.refresh();
  }
  function startFirst() {
    var legacy = Util.load('lastUrl'), items = Channels.groups()[Channels.allIdx()].items, pickIdx = items[0];
    for (var i = 0; legacy && i < items.length; i++) if (Channels.at(items[i]).url === legacy) pickIdx = items[i];
    if (pickIdx !== undefined) Zap.pick(Channels.at(pickIdx));
  }

  // D8: coming to the front clears the exit confirmation and opens the Back guard (BACK_GUARD_MS). D9: an actual return from
  // the background is told to the "now" lines after the player rebuilt its stream; launch's 'visible' or a repeated one is not.
  function onVisibility() {
    var back = away && !document.hidden;
    away = document.hidden;
    LifeLog.pinNow('visibility', 'visibility ' + (document.hidden ? 'hidden' : 'visible'));
    if (document.hidden) { Zap.cancel(); NowLines.cancel(); } else { visibleAt = Date.now(); lastBack = 0; }
    Playback.onVisibility(document.hidden);
    if (back) NowLines.front(Overlay.mode() === 'panel'); else if (!document.hidden) NowLines.update();
  }
  function lifeStatus() { return (document.hidden ? 'hidden ' : 'front ') + Playback.mode() + (Playback.behind() ? ' behind' : ''); }
  // D7 (fix batch 2, R2): every journal line is written at once while hidden, for LIFE_SYNC_MS after coming to the front
  // and while the player fails or detours; otherwise it waits for the alive tick (nothing written in a zap's key task).
  function lifeUrgent() { return document.hidden || Date.now() - visibleAt < CONFIG.LIFE_SYNC_MS || Player.recovering(); }
  // R1: what is typed into a text field (the OTT key, a playlist URL with its password) never reaches the journal.
  function inTextField(e) {
    var el = e.target || document.activeElement;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true);
  }

  // ---------- keys ----------
  function onKey(e) {
    var k = e.keyCode;
    if (Overlay.onKey(k, e)) return;
    if (Keys.isDigit(k)) { NumEntry.digit(k - K.DIGIT_0); e.preventDefault(); return; }
    if (liveKey(k, e)) e.preventDefault();
  }

  // Returns true when the key was handled.
  function liveKey(k, e) {
    var c = Playback.current(), mode = Playback.mode();
    if (k === K.RIGHT || k === K.CH_UP) Zap.step(1);
    else if (k === K.LEFT || k === K.CH_DOWN) Zap.step(-1);
    // ▲ (or ⏪ ⏩) opens the archive slider; ⏪ ⏩ also take a first step.
    else if (k === K.UP || k === K.REWIND || k === K.FF) { if (c) openScrub(c, k); }
    else if (k === K.DOWN) { if (c) Overlay.open('panel'); }
    else if (k === K.INFO) Banner.show(true);
    else if (k === K.ENTER || k === K.CH_LIST) { if (Channels.count()) Overlay.open('menu'); }
    else if (k === K.PLAY_PAUSE || k === K.PAUSE) Playback.togglePause();
    else if (k === K.PLAY) { if (mode === 'paused') Playback.togglePause(); }
    else if (k === K.STOP) { if (c && mode !== 'live') Playback.goLive(); }
    else if (k === K.PREV_CH) Zap.previous();
    else if (k === K.RED) Playback.cycleAudio();
    else if (k === K.GREEN) UI.toast(I18n.t('m.screen', Player.cycleDisplay()));
    else if (k === K.BLUE) UI.toast(Player.streamInfo(true) || I18n.t('m.noStreamInfo'), 3000);
    else if (k === K.YELLOW) { if (c) ChannelView.toggleFav(c); }   // the playing channel's favourite; the zap group stays
    else if (Keys.isBack(k)) back(c, mode, e);
    else return false;
    return true;
  }

  function openScrub(c, k) {
    if (!Catchup.supported(c)) { Banner.show(true); UI.toast(I18n.t('m.noArchive')); return; }
    Overlay.open('scrub');
    if (k !== K.UP) Overlay.onKey(k, { preventDefault: function () {} });
  }

  // D8: a held Back (repeat keydowns) and a Back within BACK_GUARD_MS of coming to the front never count towards the exit (a
  // Back the dashboard was given may reach the player as it comes up); the exit takes two fresh accepted presses.
  function back(c, mode, e) {
    if (c && mode !== 'live' && mode !== 'idle') { Playback.goLive(); return; }
    var now = Date.now();
    if (e.repeat === true || now - visibleAt < CONFIG.BACK_GUARD_MS) {
      LifeLog.add('back ignored (' + (e.repeat === true ? 'repeat' : 'just visible') + ')');
      return;
    }
    if (now - lastBack < CONFIG.EXIT_CONFIRM_MS) { exit('double-back'); return; }
    lastBack = now;
    UI.toast(I18n.t('m.backAgain'));
  }
  // D4: the player's own exit stops the stream first (stop + close), then asks Tizen to end the app.
  function exit(path) {
    LifeLog.pinNow('exit', 'exit-js ' + path);
    Player.stop();
    LifeLog.flush();                     // the stop's AVPlay lines, before the app ends
    try { tizen.application.getCurrentApplication().exit(); } catch (e) { Diag.note('exit', (e && e.message) || String(e)); }
  }

  // ---------- mouse (desktop preview; the TV remote never produces clicks) ----------
  function onClick(e) {
    if (Player.unmute()) UI.toast(I18n.t('m.soundOn'), 1200);
    if (Overlay.mode() === 'setup') return;
    if (Overlay.isNone()) { if (Channels.count()) Overlay.open('menu'); return; }
    var el = e.target;
    while (el && el !== document.body && el.getAttribute && el.getAttribute('data-i') === null) el = el.parentNode;
    if (el && el !== document.body && el.getAttribute) Overlay.onClick(el);
  }

  // Boot runs in its own task after the load event, so the first page layout and the app's start-up
  // are never one long task.
  window.onload = function () { setTimeout(boot, 0); };
}());
