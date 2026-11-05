// What is playing and from where: one mode, the archive position from the player's media clock (so
// buffering is not counted as watched), pause, going live, and a selection token every command bumps
// (a delayed zap compares it before opening, so it can never override a later choice).
var Playback = (function () {
  var mode = 'idle';           // 'idle' | 'live' | 'archive' | 'paused'
  var ch = null;               // the playing channel's record; stays valid when a refresh drops the channel
  var anchorWallMs = 0, anchorMediaMs = null, frozenMs = 0, pausedAt = 0;   // anchorMediaMs null: until the first frame
  var pipelineLost = false, hiddenMs = null, behind = false, selection = 0, audioIdx = 0, hooks = {};   // behind: playing behind the dashboard

  // hooks: { onOpened(ch) } — a new stream started (banner, landing bookkeeping); onUnplayable() — a channel the TV
  // cannot play was chosen; onBanner().
  function setHooks(h) { hooks = h; }

  // rebuild: the same stream opened again by the lifecycle, not a choice (the player keeps its failure episode, D6).
  function live(c, rebuild) {
    selection++;
    ch = c; mode = 'live'; pipelineLost = false; audioIdx = 0;
    open({ url: c.url, archive: false, rebuild: !!rebuild });
  }

  // Plays channel c's archive from fromMs; near the live edge it plays live instead.
  function archive(c, fromMs, rebuild) {
    if (!Catchup.supported(c)) { UI.toast(I18n.t('m.noArchiveHere')); return; }
    var now = Date.now();
    fromMs = Math.max(Catchup.earliest(c, now), fromMs);
    // Close to the live edge the archive would only arrive in short pieces: switch to live instead.
    if (fromMs >= now - CONFIG.LIVE_SNAP_MS) { ch = c; goLive(rebuild); return; }
    selection++;
    ch = c; mode = 'archive'; pipelineLost = false; audioIdx = 0;
    anchorWallMs = fromMs; anchorMediaMs = null;
    open({ url: archiveUrl(c, fromMs), archive: true, rebuild: !!rebuild });
  }
  // The playing channel's stream. A format the TV cannot play (dead at parse, review3 F-S12) is never opened, so it is
  // never retried: the stream on screen stops and the viewer is told once.
  function open(o) {
    if (ch.dead) Player.stop(); else Player.open(o);
    hooks.onOpened(ch);
    if (ch.dead) hooks.onUnplayable();
  }
  // From fromMs to the programme's end. Its last ARCHIVE_MIN_SPAN_MS are asked for with the next programme: a recording a
  // few seconds long ended at once and opened again (review3 F-S8); no next one known: ARCHIVE_SPAN_MS (0). The
  // ARCHIVE_LONG_CONTINUATION experiment (S-7) always asks for ARCHIVE_SPAN_MS.
  function archiveUrl(c, fromMs) {
    var p = CONFIG.ARCHIVE_LONG_CONTINUATION ? null : EPG.at(c.id, fromMs), end = p ? p.stop : 0;
    if (end && end - fromMs < CONFIG.ARCHIVE_MIN_SPAN_MS) { var next = EPG.at(c.id, end); end = next && next.stop - fromMs >= CONFIG.ARCHIVE_MIN_SPAN_MS ? next.stop : 0; }
    return Catchup.url(c, fromMs, end ? end - fromMs : 0);
  }

  // Wall-clock moment on screen.
  function position() {
    if (mode === 'archive') return anchorMediaMs === null ? anchorWallMs : anchorWallMs + (Player.mediaTimeMs() - anchorMediaMs);
    if (mode === 'paused') return frozenMs;
    return Date.now();
  }

  // The player retries a failed archive at the position actually shown, not at the recording start.
  // { url, archive } change together: a live stream resumed after a pause continues as archive.
  function retryTarget() {
    if (mode !== 'archive') return null;
    var pos = Math.max(position(), Catchup.earliest(ch, Date.now()));   // past the window's edge: move forward
    anchorWallMs = pos; anchorMediaMs = null;
    return { url: archiveUrl(ch, pos), archive: true };
  }

  function togglePause() {
    if (!ch) return;
    if (mode === 'paused') { resume(); return; }
    if (mode === 'live' && !Catchup.supported(ch)) { UI.toast(I18n.t('m.noPause')); return; }
    selection++;
    frozenMs = position(); pausedAt = Date.now(); mode = 'paused';
    Player.pause();
    UI.toast(I18n.t('m.paused'), UI.STICKY);
  }

  // A short pause resumes in place (the native pipeline kept the picture); a long one, or one whose
  // pipeline was released (Home), reopens the archive at the paused moment.
  function resume() {
    UI.toast('▶', 800);
    if (pipelineLost || Date.now() - pausedAt >= CONFIG.LIVE_SNAP_MS) { archive(ch, frozenMs, true); return; }
    selection++;
    mode = 'archive';
    anchorWallMs = frozenMs; anchorMediaMs = Player.mediaTimeMs();
    Player.play();
  }

  // The single home of "back to live": STOP, BACK in the archive, the slider at the live edge; rebuild: a resume that snapped to
  // live keeps the failure episode (fix batch 3, S4).
  function goLive(rebuild) {
    if (mode !== 'live') live(ch, rebuild); else if (hooks.onBanner) hooks.onBanner();
    UI.toast(I18n.t('m.live'));
  }

  // The app went to the background (hidden = true) or came back.
  // D3 (COMMON-DECISION player-behind 2026-11-05): a stream that played behind the dashboard is never kept in front — it is
  // released and opened again at the moment on screen (close → open), whether or not 'stop-behind' arrived; hiddenMs stays
  // null, so the next hide suspends it again.
  function onVisibility(hidden) {
    if (hidden) { suspendHidden(); return; }
    var wasBehind = behind;
    behind = false;                      // in front again: playing as usual
    if (wasBehind && hiddenMs === null && (mode === 'live' || mode === 'archive')) {
      var now = position();
      Player.suspend();
      reopen(now);
      return;
    }
    if (hiddenMs === null) return;       // Tizen reports "visible" right after launch too
    var at = hiddenMs;
    hiddenMs = null;
    if (mode === 'paused') return;       // stays paused; resuming reopens at the paused moment
    reopen(at);
  }
  // Every app in front of the player stops it (the owner: «я не могу ютуб смотреть и плеер слушать»).
  function suspendHidden() {
    if (mode === 'idle' || hiddenMs !== null) return;
    hiddenMs = position();
    selection++;                         // nothing pending (a zap, a probe) acts while in the background
    if (mode === 'paused') pipelineLost = true;
    Player.suspend();
  }
  // The same stream again from the moment it was left: live, or the archive at that moment.
  function reopen(at) { if (mode === 'live') live(ch, true); else archive(ch, at, true); }

  // Our Home Dashboard is in front (RemoteControl 'play-behind', owner 2026-10-30: «чтобы дэшборд был поверх и не перебивал
  // музыку»): a stream suspended by it plays on behind it. Paused or nothing playing: nothing. Returns whether it resumed.
  function playBehind() {
    if (hiddenMs === null || (mode !== 'live' && mode !== 'archive')) return false;
    var at = hiddenMs;
    hiddenMs = null;
    behind = true;
    reopen(at);
    return true;
  }
  // The dashboard went away ('stop-behind'): suspended again exactly as by any other app; back in front, it resumes.
  function stopBehind() {
    if (!behind) return false;
    behind = false;
    suspendHidden();
    return true;
  }

  // End of an archive recording: carry on from that moment (the next show), or live if it is now.
  function onEnded() { archive(ch, position()); }

  // A recording's first frame: the clock is anchored to the media time the player reports there. A
  // continuation's stream may start its clock ~50 s in (TV test D2); the requested moment is what shows.
  function onFirstFrame() { if (mode === 'archive' && anchorMediaMs === null) anchorMediaMs = Player.mediaTimeMs(); }

  // RED: the next audio track of the stream (the choice starts over with every new stream).
  function cycleAudio() {
    var tracks = Player.audioTracks();
    if (tracks.length < 2) { UI.toast(tracks.length ? I18n.t('m.soundOne', tracks[0].label) : I18n.t('m.soundOnlyOne')); return; }
    var next = (audioIdx + 1) % tracks.length;
    if (!Player.selectAudio(tracks[next].index)) { UI.toast(I18n.t('m.soundFail')); return; }
    audioIdx = next;
    UI.toast(I18n.t('m.sound', tracks[audioIdx].label));
  }

  // Network lost / restored (TV only): a toast, and a reconnect that resumes where the picture was.
  // Optional: some TVs refuse the listener (error 18 on the owner's TV); that is recorded, never fatal.
  function watchNetwork() {
    try {
      var net = window.webapis && webapis.network;
      if (!net || !net.addNetworkStateChangeListener) return;
      net.addNetworkStateChangeListener(function (v) {
        if (v === net.NetworkState.GATEWAY_CONNECTED) { UI.toast(I18n.t('m.netBack')); Player.reconnect(); Sources.onNetwork(); }
        if (v === net.NetworkState.GATEWAY_DISCONNECTED) UI.toast(I18n.t('m.netDown'), 5000);
      });
    } catch (e) { Diag.note('network', (e && (e.code || e.message)) || String(e)); }
  }

  // D6: the channel a detour plays for a moment — the next eligible channel of the whole list whose stream is another URL
  // (a channel the TV cannot play is skipped); null in an archive, or when there is none.
  function detourTarget() {
    if (mode !== 'live' || !ch) return null;
    var key = ch.key;
    for (var i = 0, n = Channels.count(); i < n; i++) {
      key = Channels.nextVisible(key, 1, Channels.allIdx());
      var y = key ? Channels.get(key) : null;
      if (!y || y.key === ch.key) return null;
      if (!y.dead && y.url && y.url !== ch.url) return { url: y.url };
    }
    return null;
  }

  // A refreshed list holds the playing channel again: its fresher record replaces the old one.
  function adopt(c) { if (ch && c && c.key === ch.key) ch = c; }

  return {
    setHooks: setHooks, live: live, archive: archive, position: position, retryTarget: retryTarget, togglePause: togglePause,
    goLive: goLive, onVisibility: onVisibility, playBehind: playBehind, stopBehind: stopBehind, onFirstFrame: onFirstFrame, watchNetwork: watchNetwork, onEnded: onEnded, adopt: adopt, cycleAudio: cycleAudio,
    detourTarget: detourTarget,
    current: function () { return ch; }, mode: function () { return mode; }, selection: function () { return selection; }, behind: function () { return behind; }
  };
}());
