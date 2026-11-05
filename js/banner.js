// The channel banner: name, number, what is on, progress and (once the picture is up) the stream's
// technical line. preview() shows a channel being zapped to before it plays. From the moment a stream
// opens until its picture is up (and again during a stall) it stays with a state line, so a black screen
// always says what is happening: «Подключение…», «Загрузка видео… N%», «Нет сигнала — повтор…».
var Banner = (function () {
  var techTimer = null, tech = '', techUntil = 0, techSel = -1;   // the latest landing's technical line, its window, its selection
  var state = '';              // the state line; while set the banner does not hide

  function setState(text) { state = text; if (Overlay.isNone()) show(false); }
  function connecting() { setState(I18n.t('b.connecting')); }
  function loading(pct) { setState(I18n.t('b.loading') + (pct >= 0 ? ' ' + Math.round(pct) + '%' : '')); }
  function retrying(n, delayMs) { setState(I18n.t('b.retry', Math.max(1, Math.round(delayMs / 1000)), n)); }
  // Playback is back after a stall: the line goes and the banner hides as usual.
  function resumed() { if (!state) return; state = ''; if (UI.bannerShown() && Overlay.isNone()) show(false); }

  // fetchGuide: also make sure the full guide is loaded (INFO, the first frame); off while zapping. The banner asked for
  // that way also releases a "now" re-read held after coming to the front (D9).
  // Inside a landing's tech window every redraw keeps that line («…» or the value) and the banner stays
  // until the window ends; outside it the line is what the player knows about the current stream.
  function show(fetchGuide) {
    var c = Playback.current();
    if (!c) return;
    if (fetchGuide) { EPG.ensure(c.id, onGuide); NowLines.seen('(banner)'); }
    if (techSel !== Playback.selection()) techUntil = 0;   // a newer choice (zap, archive, pause) ends the window
    var t = Playback.position(), archive = Playback.mode() !== 'live', left = techUntil - Date.now();
    var m = model(c, { t: t, extra: archive ? I18n.t('b.archive', Util.hhmm(new Date(t))) : '', tech: state ? '' : left > 0 ? tech : Player.streamInfo(false) });
    m.state = state;
    UI.banner(m, state ? UI.STICKY : Math.max(CONFIG.BANNER_MS, left));
  }

  // A channel (live or archive) shows its first frame: the banner at once with this stream's technical
  // line; "…" while the player has not described the stream yet (up to TECH_WAIT_MS), filled in as soon as
  // it has (a local read every TECH_POLL_MS, no request); the values then stay TECH_LINE_MS, so a stream the
  // player describes late still shows them (TV run: 232 BCU, 242, 372 had an empty line).
  function onFirstFrame() {
    clearTimeout(techTimer);
    techUntil = 0;
    state = '';
    if (!Overlay.isNone()) return;
    var sel = techSel = Playback.selection();
    tech = Player.streamInfo(false) || '…';
    techUntil = Date.now() + (tech === '…' ? CONFIG.TECH_WAIT_MS : CONFIG.TECH_LINE_MS);
    show(false);
    function tick() {
      if (sel !== Playback.selection()) { techUntil = 0; return; }
      if (Date.now() >= techUntil) { techUntil = 0; UI.bannerTech(''); return; }
      if (tech === '…') {
        var info = Player.streamInfo(true);
        if (info) { tech = info; techUntil = Date.now() + CONFIG.TECH_LINE_MS; if (Overlay.isNone()) show(false); else UI.bannerTech(info); }
      }
      techTimer = setTimeout(tick, tech === '…' ? CONFIG.TECH_POLL_MS : techUntil - Date.now());
    }
    techTimer = setTimeout(tick, tech === '…' ? CONFIG.TECH_POLL_MS : CONFIG.TECH_LINE_MS);
  }
  function preview(c) { UI.banner(model(c, { t: Date.now(), extra: '', tech: '' })); }

  // A guide that arrived refreshes a banner that is still on screen (it is never reopened by it).
  function onGuide(err) { if (!err && UI.bannerShown() && Overlay.isNone()) show(false); }

  // at: { t (moment shown), extra (after the name), tech (technical line) }
  function model(c, at) {
    var t = at.t, nn = EPG.nowNext(c.id, t), cur = nn.cur, next = nn.next;
    return {
      num: c.num, logo: c.logo, title: I18n.iso(c.name) + (at.extra ? '   ·   ' + at.extra : ''), tech: at.tech,
      // The same programme and text as the menu row (EPG.shown / EPG.label); an ended one keeps «(шла до HH:MM)».
      now: cur ? Util.span(cur.start, cur.stop) + '  ' + EPG.label(nn.shown) : '',
      next: next ? I18n.t('b.next', Util.hhmm(new Date(next.start)), I18n.iso(next.title)) : '',
      progress: cur ? (t - cur.start) / (cur.stop - cur.start) * 100 : 0
    };
  }

  return { show: show, preview: preview, onGuide: onGuide, onFirstFrame: onFirstFrame, setState: setState, connecting: connecting,
    loading: loading, retrying: retrying, resumed: resumed };
}());
