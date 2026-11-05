// Diagnostics: the redacted playback failure log (localStorage "failLog", read and reset by the TV
// scripts), counters and notes ("diag"). Written at most every DIAG_FLUSH_MS, when the TV is idle.
var Diag = (function () {
  var pending = [];            // failLog lines not yet written
  var recent = [];             // the same lines, kept in memory for snapshot()
  var counters = {}, notes = {};
  var attempts = [], lastKeyAt = 0;   // S-0: the timeline of the last DIAG_ATTEMPTS playback attempts (memory only)
  var flushTimer = null;

  // scheme://host/path only: no user:password, no query; the path masked as in the journal (uri()).
  function redact(url) {
    var s = String(url || '');
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? uri(s.split(/[?#]/)[0]) : '';
  }
  // The known places of credentials in a path: the OTT key, an Xtream user and password; and the Xtream short form
  // scheme://host/<user>/<pass>/<id> (fix batch 3, S1), masked by uri() like every unknown segment; learned only when
  // neither segment is a known word (fix batch 4, T1: …/hls/live/<id>.m3u8 must not teach "live") and the last one has the
  // shape of an Xtream stream id, <digits> or ch<digits>, maybe .ts / .m3u8 (batch 5, N1: …/news/first/index.m3u8 must not
  // teach "first").
  var KEY_PATH = /\/stream\/([^\/?#]+)\//, USER_PATH = /\/(live|movie|series|timeshift)\/([^\/?#]+)\/([^\/?#]+)\//;
  var SHORT_PATH = /^[a-z][a-z0-9+.-]*:\/\/[^\/?#]*\/([^\/?#]+)\/([^\/?#]+)\/([^\/?#]+)$/i;
  var STREAM_ID = /^([0-9]+|ch[0-9]+)([.](ts|m3u8))?$/;
  var SAFE_SEGMENT = /^(|\.\.?|stream|live|movie|series|timeshift|…|<(key|user|pass|cred)>)$/;
  function maskPath(p) { return p.replace(KEY_PATH, '/stream/<key>/').replace(USER_PATH, '/$1/<user>/<pass>/'); }
  // The credential values of a URI (no query), [] when none.
  function pathCredentials(p) {
    var k = KEY_PATH.exec(p), u = USER_PATH.exec(p), s = !k && !u ? SHORT_PATH.exec(p) : null;
    var shortForm = s && STREAM_ID.test(s[3]) && !SAFE_SEGMENT.test(s[1]) && !SAFE_SEGMENT.test(s[2]);
    return (k ? [k[1]] : []).concat(u ? [u[2], u[3]] : []).concat(shortForm ? [s[1], s[2]] : []);
  }
  // A URI as every stored record shows it (the life journal, failLog, the AVPlay event notes): no user info, no query or
  // fragment (only '?…' / '#…' says there was one), every path segment but the last masked ('…') unless it is a known word.
  function uri(t) {
    var q = t.search(/[?#]/), s = q < 0 ? t : t.substring(0, q), head = '';
    var m = /^((?:[a-z][a-z0-9+.-]*:)?\/\/)([^\/]*)/i.exec(s);
    if (m) { head = m[1] + m[2].replace(/^[^@]*@/, ''); s = s.substring(m[0].length); } else s = s.replace(/^[^\/]*@/, '');
    var parts = maskPath(s).split('/');
    for (var i = 0; i < parts.length - 1; i++) if (!SAFE_SEGMENT.test(parts[i])) parts[i] = '…';
    return head + parts.join('/') + (q < 0 ? '' : t.charAt(q) + '…');
  }

  // The archive moment a URL asks for (OTT Club archive=, shift utc=), or '': the query is dropped by
  // redact(), and without this a failed recording looked like a failed live stream (TV run: /147.m3u8).
  function archiveOf(url) {
    var m = /[?&](?:archive|utc)=(\d{9,})/.exec(String(url || ''));
    return m ? ' (archive from ' + new Date(+m[1] * 1000).toISOString() + ')' : '';
  }

  // f: { n, gen, reason, url } of one failed playback attempt.
  function fail(f) {
    var line = new Date().toISOString() + ' #' + f.n + ' ' + f.reason + ' ' + redact(f.url) + archiveOf(f.url);
    console.log('[player] fail #' + f.n + ' gen=' + f.gen + ' ' + f.reason);
    pending.push(line);
    recent.push(line);
    if (recent.length > CONFIG.DIAG_LOG_LINES) recent.shift();
    schedule();
  }

  function count(name, ms) {
    counters[name] = (counters[name] || 0) + 1;
    if (ms) counters[name + 'Ms'] = (counters[name + 'Ms'] || 0) + ms;
    schedule();
  }
  function note(name, value) { notes[name] = value; schedule(); }

  // S-0 (review3): where a channel change spends its time, on the TV's own clock (Date.now(), ms). key(): a remote key
  // was pressed; attempt(): the player starts an attempt (it carries the last key's moment); mark(): a step of the
  // latest attempt, its first moment only. Read by the TV probes through snapshot(); never written to storage.
  function key() { lastKeyAt = Date.now(); }
  function attempt(archive) {
    attempts.push({ key: lastKeyAt, archive: archive, marks: { key: lastKeyAt } });
    if (attempts.length > CONFIG.DIAG_ATTEMPTS) attempts.shift();
  }
  function mark(name) {
    var a = attempts[attempts.length - 1];
    if (a && a.marks[name] === undefined) a.marks[name] = Date.now();
  }
  // S-10: AVPlay's onevent (HTTP error codes, bitrate and resolution changes): counted per type, the latest data kept;
  // a URL in it is redacted (no key, no query). The player passes the data cleaned by LifeLog.clean, like failLog (N2).
  function avEvent(type, data) {
    var name = 'avEvent.' + type, text = String(data === undefined ? '' : data);
    count(name);
    note(name, /:\/\//.test(text) ? text.replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, redact) : text.substring(0, 80));
    mark('ev.' + type);
  }

  function schedule() {
    if (flushTimer) return;
    flushTimer = setTimeout(function () { Util.idle(flush); }, CONFIG.DIAG_FLUSH_MS);
  }

  // One read-merge-write of failLog: re-read first, so a reset to [] by the TV scripts is kept.
  function flush() {
    flushTimer = null;
    if (pending.length) {
      var log = Util.load('failLog');
      Util.save('failLog', (log instanceof Array ? log : []).concat(pending).slice(-CONFIG.DIAG_LOG_LINES));
      pending = [];
    }
    Util.save('diag', { counters: counters, notes: notes });
  }

  function snapshot() { return { counters: counters, notes: notes, recent: recent.slice(), attempts: attempts.slice() }; }

  // snapshot() is read from the Tizen inspector console (TV checks TV-4 and TV-9).
  return { fail: fail, count: count, note: note, snapshot: snapshot, key: key, attempt: attempt, mark: mark, avEvent: avEvent, redact: redact, uri: uri, pathCredentials: pathCredentials };
}());
