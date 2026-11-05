// The life journal (D7, COMMON-DECISION player-behind 2026-11-05): what the app did, kept in localStorage, so the last thing
// it did before the TV ended it is on record (read from the TV with the inspector or sdb).
//   'lifeLog'       { boot, version, at }: this launch.
//   'lifeLog.<n>'   a ring of LIFE_LINES slots, one line each: '<boot> #<seq> <ISO time> <text>'. A line costs one small
//                   write, never the whole ring.
//   'lifeAlive'     overwritten every LIFE_ALIVE_MS, front or behind, independently of the player's retries.
//   'lifePins'      the last line of each named event (visibility, control, frame, fail, exit): the context of a behind
//                   cycle that hours of failures in the ring have pushed out.
//   'lifeLogPrev'   the previous launch's head, alive, pins and last LIFE_PREV_LINES lines, copied at boot before anything
//                   is overwritten.
// When a line reaches storage (fix batch 2, R2): a routine line (add, pin: keys, opens, AVPlay calls that succeed, the first
// frame) waits in memory and is written with the others on the alive tick, at most LIFE_FLUSH_CHUNK writes per task (fix
// batch 3, S3), so zapping and navigating write nothing in the key's task. It is written at once while the start's
// urgent() says so (hidden, the first LIFE_SYNC_MS in front, a failing or detouring player). addNow / pinNow (visibility,
// pagehide, unload, control, failure, a throwing AVPlay call, detour, probe, exit) write everything waiting at once.
// No credential reaches a line (R1): the OTT key and the credentials of every journaled URL anywhere in the text; key=value
// pairs of credential names; in every URI, absolute or relative, the user info and the query, and every path segment but
// the last that is not a known word (stream, live …) — the known places of a key, user and password are named (<key>,
// <user>, <pass>), the rest is '…'. The whole text is cleaned first, then cut to LIFE_TEXT_MAX. A key typed into a text
// field is journaled without its code (app.js).
// A write the storage refuses is counted (snapshot().refused) and said in the next line that is written.
var LifeLog = (function () {
  var HEAD = 'lifeLog', SLOT = 'lifeLog.', ALIVE = 'lifeAlive', PINS = 'lifePins', PREV = 'lifeLogPrev';
  var CRED = '(user(?:name)?|login|pass(?:word)?|pwd|token|auth|key|sig(?:nature)?|secret)';   // credential names
  var LINE_RE = /^(\S+) #(\d+) /, TOKEN_RE = /[^\s"'<>\\]*[\/?@][^\s"'<>\\]*/g, PAIR_RE = new RegExp('\\b' + CRED + '=[^\\s&"\',;]*', 'gi');
  var CRED_QUERY = new RegExp('^' + CRED + '$', 'i');
  var LEARNED_MAX = 8, MIN_SECRET = 4;
  var boot = '', seq = 0, pins = {}, refused = 0, unsaid = 0, recent = [], status = null, urgent = null;
  var pending = [], pinsDirty = false, learned = [], chunkTimer = null;

  // statusFn() -> a short state for the alive record ('front live', 'hidden live behind'); urgentFn() -> true while every
  // line must reach storage at once.
  function start(statusFn, urgentFn) {
    status = statusFn; urgent = urgentFn;
    keepPrevious();
    boot = Date.now().toString(36) + '-' + Math.floor(Math.random() * 46656).toString(36);
    write(HEAD, { boot: boot, version: CONFIG.VERSION, at: new Date().toISOString() });
    write(PINS, pins);
    addNow('boot ' + boot + ' v' + CONFIG.VERSION + ' ' + CONFIG.BUILD);
    setInterval(alive, CONFIG.LIFE_ALIVE_MS);
  }

  // The previous launch's records, newest LIFE_PREV_LINES of its ring, in order.
  function keepPrevious() {
    var head = Util.load(HEAD);
    if (!head || !head.boot) return;
    var lines = [];
    for (var i = 0; i < CONFIG.LIFE_LINES; i++) {
      var l = Util.load(SLOT + i), m = typeof l === 'string' ? LINE_RE.exec(l) : null;
      if (m && m[1] === head.boot) lines.push({ seq: +m[2], line: l });
    }
    lines.sort(function (a, b) { return a.seq - b.seq; });
    var out = [];
    for (var j = Math.max(0, lines.length - CONFIG.LIFE_PREV_LINES); j < lines.length; j++) out.push(lines[j].line);
    write(PREV, { boot: head.boot, version: head.version, at: head.at, alive: Util.load(ALIVE), pins: Util.load(PINS), lines: out });
  }

  function add(text) { return put(clean(text)); }
  function addNow(text) { var line = add(text); flush(); return line; }
  // A line that also stays the last of its kind in 'lifePins'.
  function pin(name, text) { pins[name] = add(text); pinsDirty = true; if (isUrgent()) flush(); }
  function pinNow(name, text) { pins[name] = add(text); pinsDirty = true; flush(); }

  // text: already clean.
  function put(text) {
    var line = boot + ' #' + seq + ' ' + new Date().toISOString() + ' ' + text;
    pending.push({ slot: seq % CONFIG.LIFE_LINES, line: line });
    if (pending.length > CONFIG.LIFE_LINES) pending.shift();   // its slot is overwritten by a newer line anyway
    seq++;
    recent.push(line);
    if (recent.length > CONFIG.LIFE_LINES) recent.shift();
    if (isUrgent()) flush();
    return line;
  }
  function isUrgent() { try { return !!(urgent && urgent()); } catch (e) { return true; } }

  // Everything waiting at once, one write per line, the pins once (the synchronous points, and while urgent()).
  function flush() {
    clearTimeout(chunkTimer); chunkTimer = null;
    writeLines(pending.length);
    writePins();
  }
  // The alive tick (fix batch 3, S3): at most LIFE_FLUSH_CHUNK writes per task, the rest in the next tasks (setTimeout 0),
  // so a key pressed meanwhile waits behind LIFE_FLUSH_CHUNK writes at most, never behind the whole ring.
  function alive() {
    write(ALIVE, new Date().toISOString() + ' ' + boot + ' ' + clean(status ? status() : ''));
    if (!chunkTimer && (pending.length || pinsDirty)) chunkTimer = setTimeout(flushChunk, 0);
  }
  function flushChunk() {
    chunkTimer = null;
    var n = Math.min(pending.length, CONFIG.LIFE_FLUSH_CHUNK);
    writeLines(n);
    if (!pending.length && n < CONFIG.LIFE_FLUSH_CHUNK) writePins();
    if (pending.length || pinsDirty) chunkTimer = setTimeout(flushChunk, 0);
  }
  // The n oldest lines waiting.
  function writeLines(n) {
    var lines = pending.splice(0, n);
    for (var i = 0; i < lines.length; i++) {
      var note = unsaid ? ' [storage refused ' + unsaid + ']' : '';
      if (write(SLOT + lines[i].slot, lines[i].line + note)) unsaid = 0;
    }
  }
  function writePins() { if (pinsDirty) { pinsDirty = false; write(PINS, pins); } }

  function write(key, value) {
    if (Util.store(key, value)) return true;
    refused++; unsaid++;
    Diag.count('lifeLogRefused');
    return false;
  }

  function clean(text) { return sanitize(text).substring(0, CONFIG.LIFE_TEXT_MAX); }
  function sanitize(text) {
    var s = String(text);
    (s.match(TOKEN_RE) || []).forEach(learn);
    s = s.replace(TOKEN_RE, Diag.uri).replace(PAIR_RE, '$1=…');
    var secrets = known();
    for (var i = 0; i < secrets.length; i++) s = s.split(secrets[i].value).join(secrets[i].name);
    return s;
  }
  function known() {
    var k = '';
    try { k = OttClub.key() || ''; } catch (e) { k = ''; }
    return (k.length >= MIN_SECRET ? [{ value: k, name: '<key>' }] : []).concat(learned);
  }
  // The credentials of a URI (its user info, credential query values, /stream/<key>/, /live/<user>/<pass>/, the short form
  // scheme://host/<user>/<pass>/<id>) are scrubbed from every later line too: a provider's answer may carry them bare.
  function learn(t) {
    var m = /^[a-z][a-z0-9+.-]*:\/\/([^@\/?#]*)@/i.exec(t);
    if (m) remember(m[1].split(':'), '<cred>');
    var q = t.indexOf('?');
    if (q >= 0) t.substring(q + 1).split(/[&;#]/).forEach(function (p) {
      var kv = p.split('=');
      if (kv.length > 1 && CRED_QUERY.test(kv[0])) remember([decodeSafe(kv[1])], '<cred>');
    });
    remember(Diag.pathCredentials(t.split(/[?#]/)[0]), '<cred>');
  }
  function remember(values, name) {
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      if (!v || v.length < MIN_SECRET || v === '<key>' || v === '<user>' || v === '<pass>') continue;
      for (var j = 0; j < learned.length && learned[j].value !== v; j++) { /* look it up */ }
      if (j < learned.length) continue;
      learned.push({ value: v, name: name });
      if (learned.length > LEARNED_MAX) learned.shift();
    }
  }
  function decodeSafe(v) { try { return decodeURIComponent(v); } catch (e) { return v; } }
  // Supporting evidence only (D7): one bounded GET of the live playlist that keeps failing — its HTTP status, content type
  // and first 80 characters, of the answer to an HTTP error too; the whole answer is cleaned before it is cut.
  function probe(url) {
    addNow('probe ' + url);
    Net.get({ url: url, timeoutMs: CONFIG.PROBE_TIMEOUT_MS, maxBytes: CONFIG.PROBE_MAX_BYTES }, function (err, text, meta) {
      var type = /^[\w.+-]+\/[\w.+-]+/.exec((meta && meta.type) || '');   // the media type only: nothing else of the header
      put(clean('probe result ' + (meta ? meta.status : '?')) + ' ' + (type ? type[0] : '-') + clean(err ? ' ' + err : '') + ' ' +
        JSON.stringify(sanitize(text || '').substring(0, 80)));
      flush();
    });
  }

  function snapshot() { return { boot: boot, lines: recent.slice(), refused: refused, pins: pins }; }

  return { start: start, add: add, addNow: addNow, pin: pin, pinNow: pinNow, flush: flush, probe: probe, clean: clean, snapshot: snapshot };
}());
