'use strict';
// Test harness: runs the real app scripts (ES5, unchanged) in a Node `vm` context with fakes for
// everything the TV provides — DOM, XMLHttpRequest, localStorage (with quota), timers + clock and
// Samsung AVPlay. Zero dependencies: Node 22 `node:test` + `node:assert` only.
//
// The scripts are the ones index.html lists, in its order (parsed from the <script src> tags), so a
// new module added to index.html is picked up without touching the harness.
//
// Every macrotask the app receives (a timer, an XHR completion, a key press, an AVPlay event) runs
// through `runTask`, which records its real duration (for long-task assertions) and catches what it
// throws (an uncaught error in a key handler is a test failure, as on the TV).

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');

// KINOZAL_ROOT points the harness at another copy of the app (used by mutation proofs, which must
// never edit the real js/ files).
const ROOT = path.resolve(process.env.KINOZAL_ROOT || path.join(__dirname, '..'));

// Remote-control key codes (Tizen). These are the app's input contract, not an implementation detail.
const KEYS = Object.freeze({
  LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, BACK_DESKTOP: 8,
  CH_UP: 427, CH_DOWN: 428, RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406,
  PLAY_PAUSE: 10252, PLAY: 415, PAUSE: 19, STOP: 413, REWIND: 412, FF: 417, INFO: 457, CH_LIST: 10073,
  PREV_CH: 10190
});

// 2026-10-25 20:00 in Israel (17:00 UTC): a fixed, ordinary evening.
const DEFAULT_NOW = Date.UTC(2026, 9, 25, 17, 0, 0);

// ---------------------------------------------------------------------------------------------
// index.html → ordered app scripts and the initial <body> markup
// ---------------------------------------------------------------------------------------------
function readIndex() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const scripts = [];
  const re = /<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[1].indexOf('$WEBAPIS') === 0) continue;        // the TV's own webapis.js: replaced by fakes
    scripts.push(m[1]);
  }
  const body = /<body[^>]*>([\s\S]*?)<script\b/.exec(html);
  return { scripts, bodyHtml: body ? body[1] : '' };
}

// ---------------------------------------------------------------------------------------------
// Minimal DOM: enough element behaviour for the app (ids, className, style, children, innerHTML)
// ---------------------------------------------------------------------------------------------
const VOID_TAGS = { img: 1, input: 1, br: 1, meta: 1, link: 1, hr: 1 };

class FakeElement {
  constructor(doc, tagName) {
    this.ownerDocument = doc;
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.className = '';
    this.value = '';
    this.muted = false;
    this.paused = true;
    this._attrs = {};
    this._text = '';
    this._html = '';
    this._listeners = {};
  }
  get id() { return this._attrs.id || ''; }
  // An image's src is its attribute, as in a browser; srcWrites counts every assignment (a picture load started).
  get src() { return this._attrs.src; }
  set src(v) {
    this._attrs.src = String(v); this.srcWrites = (this.srcWrites || 0) + 1;
    if (this.tagName === 'IMG' && this.ownerDocument.images) this.ownerDocument.images.load(this, String(v));
  }
  set id(v) { this._attrs.id = String(v); }
  get childNodes() { return this.children; }
  get textContent() {
    return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text;
  }
  set textContent(v) { this.children = []; this._text = v == null ? '' : String(v); }
  get innerHTML() { return this._html; }
  set innerHTML(html) {
    this._html = String(html);
    this.children = [];
    this._text = '';
    parseInto(this, this._html);
  }
  appendChild(el) { el.parentNode = this; this.children.push(el); return el; }
  removeChild(el) { this.children = this.children.filter((c) => c !== el); el.parentNode = null; return el; }
  setAttribute(k, v) {
    this._attrs[k] = String(v);
    if (k === 'class') this.className = String(v);
  }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; }
  removeAttribute(k) { delete this._attrs[k]; if (k === 'src' && this.tagName === 'IMG') { this._loading = null; this.complete = true; this.naturalWidth = 0; this.showing = null; } }
  addEventListener(type, fn) { (this._listeners[type] || (this._listeners[type] = [])).push(fn); }
  removeEventListener(type, fn) { this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn); }
  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null; }
  play() { this.paused = false; return undefined; }
  pause() { this.paused = true; }
}

function parseInto(parent, html) {
  const doc = parent.ownerDocument;
  const stack = [parent];
  const re = /<\/([a-zA-Z0-9]+)\s*>|<([a-zA-Z0-9]+)((?:[^>"]|"[^"]*")*)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const top = stack[stack.length - 1];
    if (m[1]) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === m[1].toUpperCase()) { stack.length = i; break; }
      }
    } else if (m[2]) {
      const el = new FakeElement(doc, m[2]);
      const attrRe = /([a-zA-Z0-9_:-]+)(?:="([^"]*)")?/g;
      let a;
      while ((a = attrRe.exec(m[3])) !== null) el.setAttribute(a[1], a[2] === undefined ? '' : a[2]);
      top.appendChild(el);
      const selfClosing = /\/\s*$/.test(m[3]);
      if (!VOID_TAGS[m[2].toLowerCase()] && !selfClosing) stack.push(el);
    } else if (m[4] && m[4].trim()) {
      top._text += m[4];
    }
  }
}

function createDocument(bodyHtml) {
  const doc = {
    activeElement: null,
    hidden: false,
    _listeners: {},
    addEventListener(type, fn) { (this._listeners[type] || (this._listeners[type] = [])).push(fn); },
    removeEventListener(type, fn) { this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn); },
    createElement(tag) { return new FakeElement(doc, tag); },
    getElementById(id) { return findById(doc.body, id) || findById(doc.head, id); },
    querySelectorAll() { return []; }
  };
  doc.head = new FakeElement(doc, 'head');
  doc.body = new FakeElement(doc, 'body');
  doc.documentElement = new FakeElement(doc, 'html');
  doc.body.innerHTML = bodyHtml;
  return doc;
}

function findById(el, id) {
  if (!el) return null;
  if (el._attrs.id === id) return el;
  for (const c of el.children) {
    const hit = findById(c, id);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Clock and timers (virtual time). `autoTickMs` > 0 makes every clock read advance time, so code that
// slices work by "Date.now() - t0 > N ms" yields deterministically.
// ---------------------------------------------------------------------------------------------
function createClock(startMs, autoTickMs) {
  return {
    now: startMs,
    autoTick: autoTickMs || 0,
    read() { if (this.autoTick) this.now += this.autoTick; return this.now; }
  };
}

function createFakeDate(clock) {
  const RealDate = Date;
  function FakeDate(...args) {
    if (!(this instanceof FakeDate)) return new RealDate(clock.read()).toString();
    return args.length ? new RealDate(...args) : new RealDate(clock.read());
  }
  FakeDate.prototype = RealDate.prototype;
  FakeDate.now = () => clock.read();
  FakeDate.UTC = RealDate.UTC;
  FakeDate.parse = RealDate.parse;
  return FakeDate;
}

// ---------------------------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------------------------
function createApp(opts) {
  const o = Object.assign({
    now: DEFAULT_NOW,
    autoTickMs: 0,
    storage: {},                 // initial localStorage contents: { key: rawString }
    quotaChars: 5 * 1024 * 1024, // Chromium: ~5 M characters per origin
    config: {},                  // CONFIG overrides applied after config.js loads, before boot
    defaultLatencyMs: 50,
    avPrepareMs: 300,
    avSuspendState: 'PAUSED',    // state AVPlay reports after suspend(); the TV behaviour is unverified
    avPauseState: 'PAUSED',      // state AVPlay reports after pause(); the TV behaviour is unverified
    random: null,                // Math.random replacement (e.g. () => 0: the shortest jitter every time)
    platformThrows: [],          // paths of TV platform calls that throw, like the real TV can (see below)
    maxStepsPerAdvance: 300000,
    imageDelayMs: 100,           // a logo's download time
    imageStatus: null            // (url) -> HTTP status of a picture (default 200); 'hang': never answers
  }, opts || {});

  const clock = createClock(o.now, o.autoTickMs);
  const events = [];             // ordered log of everything observable: xhr, av, storage, keys
  let seq = 0, taskCount = 0, taskNo = 0;   // taskNo: the macrotask an event happened in (0: outside every task)
  function log(type, data) { const e = Object.assign({ seq: ++seq, at: clock.now, task: taskNo, type }, data); events.push(e); return e; }

  const errors = [];
  const tasks = [];
  function runTask(label, fn) {
    const outer = taskNo;
    taskNo = ++taskCount;
    const t0 = performance.now();
    try { fn(); } catch (e) { errors.push({ label, error: e }); }
    const ms = performance.now() - t0;
    taskNo = outer;
    tasks.push({ label, ms, at: clock.now });
    return ms;
  }

  // ----- timers -----
  let timerId = 0;
  const timers = new Map();
  function addTimer(fn, ms, repeat, label) {
    const id = ++timerId;
    const delay = Math.max(0, +ms || 0);
    timers.set(id, { id, at: clock.now + delay, every: repeat ? Math.max(1, delay) : 0, fn, label: label || 'timer' });
    return id;
  }
  function clearTimer(id) { timers.delete(id); }
  function nextDue(limit) {
    let best = null;
    for (const t of timers.values()) {
      if (t.at <= limit && (!best || t.at < best.at || (t.at === best.at && t.id < best.id))) best = t;
    }
    return best;
  }
  function advance(ms) {
    const target = clock.now + Math.max(0, ms);
    let steps = 0;
    for (;;) {
      const t = nextDue(target);
      if (!t) break;
      if (++steps > o.maxStepsPerAdvance) throw new Error('timer storm: more than ' + o.maxStepsPerAdvance + ' tasks in one advance()');
      clock.now = Math.max(clock.now, t.at);
      if (t.every) t.at = clock.now + t.every; else timers.delete(t.id);
      runTask(t.label, t.fn);
    }
    clock.now = Math.max(clock.now, target);
  }
  // Advance in small steps until `pred()` holds; returns true if it did within `maxMs`.
  function advanceUntil(pred, maxMs, stepMs) {
    const step = stepMs || 10;
    for (let waited = 0; waited <= maxMs; waited += step) {
      if (pred()) return true;
      advance(step);
    }
    return pred();
  }

  // ----- network -----
  const routes = [];
  const requests = [];
  function route(match, handler) { routes.push({ match, handler }); }
  function findRoute(url) {
    for (let i = routes.length - 1; i >= 0; i--) {
      const r = routes[i];
      if (typeof r.match === 'function' ? r.match(url) : r.match.test(url)) return r;
    }
    return null;
  }

  function FakeXHR() {
    this.readyState = 0;
    this.status = 0;
    this.responseText = '';
    this.timeout = 0;
    this.onreadystatechange = null;
    this.ontimeout = null;
    this.onerror = null;
    this.onload = null;
    this.onabort = null;
    this._req = null;
    this._timers = [];
  }
  FakeXHR.prototype.open = function (method, url) { this._method = method; this._url = String(url); this.readyState = 1; };
  FakeXHR.prototype.setRequestHeader = function () {};
  // A route's answer may carry headers: { headers: { 'Last-Modified': '…' } } (looked up case-insensitively).
  FakeXHR.prototype.getResponseHeader = function (name) {
    const h = this._headers || {}, k = Object.keys(h).find((x) => x.toLowerCase() === String(name).toLowerCase());
    return k === undefined ? null : String(h[k]);
  };
  FakeXHR.prototype.send = function () {
    const xhr = this;
    const req = { id: requests.length + 1, url: xhr._url, method: xhr._method, sentAt: clock.now, endedAt: null,
      aborted: false, outcome: 'pending', status: 0 };
    req.sendSeq = log('xhr-send', { url: req.url, id: req.id }).seq;
    requests.push(req);
    xhr._req = req;
    const r = findRoute(req.url);
    const res = r ? r.handler(req) : { status: 404, body: '' };
    xhr._headers = res.headers || null;
    const delay = res.delay == null ? o.defaultLatencyMs : res.delay;
    if (xhr.timeout > 0) {
      xhr._timers.push(addTimer(function () { finish(xhr, 'timeout', 0, ''); }, xhr.timeout, false, 'xhr-timeout ' + req.url));
    }
    if (res.hang) return;
    if (res.error) {
      xhr._timers.push(addTimer(function () { finish(xhr, 'error', 0, ''); }, delay, false, 'xhr-error ' + req.url));
      return;
    }
    xhr._timers.push(addTimer(function () { finish(xhr, 'load', res.status == null ? 200 : res.status, res.body || ''); },
      delay, false, 'xhr-load ' + req.url));
  };
  FakeXHR.prototype.abort = function () {
    if (!this._req || this._req.endedAt !== null) return;
    this._req.aborted = true;
    finish(this, 'abort', 0, '');
  };
  function finish(xhr, outcome, status, body) {
    const req = xhr._req;
    if (!req || req.endedAt !== null) return;
    xhr._timers.forEach(clearTimer);
    req.endedAt = clock.now;
    req.outcome = outcome;
    req.status = status;
    req.endSeq = log('xhr-end', { url: req.url, id: req.id, outcome }).seq;
    xhr.readyState = 4;
    xhr.status = status;
    xhr.responseText = body;
    // Same order as a browser: readystatechange first, then the specific event.
    if (xhr.onreadystatechange) xhr.onreadystatechange();
    if (outcome === 'timeout' && xhr.ontimeout) xhr.ontimeout();
    if (outcome === 'error' && xhr.onerror) xhr.onerror();
    if (outcome === 'abort' && xhr.onabort) xhr.onabort();
    if (outcome === 'load' && xhr.onload) xhr.onload();
  }

  const net = {
    route,
    requests: (filter) => (filter ? requests.filter(filter) : requests.slice()),
    // Highest number of matching requests in flight at any moment after event `fromSeq` up to `toSeq`.
    // Events up to and including fromSeq are history: a request that ended at or before fromSeq is not
    // counted (decision FP-2026-10-25, NC-2: the window starts after the triggering event).
    maxInflight(filter, fromSeq, toSeq) {
      const to = toSeq == null ? Infinity : toSeq;
      let live = 0;
      let max = 0;
      let entered = false;
      for (const e of events) {
        if (e.type !== 'xhr-send' && e.type !== 'xhr-end') continue;
        const req = requests[e.id - 1];
        if (!filter(req)) continue;
        if (e.seq > to) break;
        if (!entered && e.seq > fromSeq) { entered = true; max = live; }
        live += e.type === 'xhr-send' ? 1 : -1;
        if (entered) max = Math.max(max, live);
      }
      return entered ? max : live;
    }
  };

  // ----- localStorage with quota -----
  const store = new Map(Object.entries(o.storage));
  const reads = new Map();       // key → number of getItem calls
  function used() { let n = 0; for (const [k, v] of store) n += k.length + v.length; return n; }
  const localStorage = {
    getItem(k) {
      const key = String(k);
      reads.set(key, (reads.get(key) || 0) + 1);
      return store.has(key) ? store.get(key) : null;
    },
    setItem(k, v) {
      const key = String(k);
      const val = String(v);
      const before = store.has(key) ? key.length + store.get(key).length : 0;
      if (used() - before + key.length + val.length > o.quotaChars) {
        log('storage-quota', { key, size: val.length });
        const err = new Error('The quota has been exceeded.');
        err.name = 'QuotaExceededError';
        err.code = 22;
        throw err;
      }
      store.set(key, val);
      log('storage-write', { key, size: val.length, value: val });
    },
    removeItem(k) { store.delete(String(k)); log('storage-remove', { key: String(k) }); },
    clear() { store.clear(); },
    key(i) { return Array.from(store.keys())[i] || null; },
    get length() { return store.size; }
  };

  // ----- AVPlay -----
  const av = {
    state: 'NONE',
    url: null,
    listener: null,
    currentTime: 0,
    prepareMs: o.avPrepareMs,
    prepareFails: false,         // true, or (url) -> true: that stream's prepareAsync fails (CONNECTION_FAILED)
    prepareHangs: null,          // (url) -> true: that stream's prepareAsync never answers
    suspendState: o.avSuspendState,
    pauseState: o.avPauseState,
    paused: false,
    suspended: false,
    stalled: false,              // true: the stream is stuck — play time stops advancing
    streamInfo: null,            // (url) -> AVPlay stream-info list for that stream (null: none)
    calls: []
  };
  function avCall(fn, args) { const e = log('av', { fn, args }); av.calls.push(e); return e; }
  const avplay = {
    open(url) { avCall('open', [url]); av.url = url; av.state = 'IDLE'; av.currentTime = 0; av.suspended = false; av.paused = false; },
    close() { avCall('close', []); av.state = 'NONE'; },
    stop() { avCall('stop', []); if (av.state !== 'NONE') av.state = 'IDLE'; },
    setDisplayRect(...a) { avCall('setDisplayRect', a); },
    setDisplayMethod(...a) { avCall('setDisplayMethod', a); },
    setStreamingProperty(...a) { avCall('setStreamingProperty', a); },
    setBufferingParam() {},
    setListener(l) { av.listener = l; },
    prepareAsync(ok, err) {
      avCall('prepareAsync', []);
      const openedUrl = av.url;
      if (av.prepareHangs && av.prepareHangs(openedUrl)) return;
      addTimer(function () {
        if (av.url !== openedUrl) return;
        if (av.prepareFails === true || (typeof av.prepareFails === 'function' && av.prepareFails(openedUrl))) { if (err) err('PLAYER_ERROR_CONNECTION_FAILED'); return; }
        av.state = 'READY';
        if (ok) ok();
      }, av.prepareMs, false, 'av-prepare');
    },
    prepare() { avCall('prepare', []); av.state = 'READY'; },
    play() { avCall('play', []); av.paused = false; av.state = 'PLAYING'; },
    pause() { avCall('pause', []); av.paused = true; av.state = av.pauseState; },
    suspend() { avCall('suspend', []); av.suspended = true; if (av.suspendState) av.state = av.suspendState; },
    restore(url, resumeTime, prepare) {
      avCall('restore', [url, resumeTime, prepare]); av.url = url; av.state = 'PLAYING'; av.suspended = false; av.currentTime = resumeTime || 0;
    },
    seekTo(ms, ok) { avCall('seekTo', [ms]); av.currentTime = ms; if (ok) addTimer(ok, 0, false, 'av-seek'); },
    jumpForward(ms, ok) { avCall('jumpForward', [ms]); av.currentTime += ms; if (ok) addTimer(ok, 0, false, 'av-seek'); },
    jumpBackward(ms, ok) { avCall('jumpBackward', [ms]); av.currentTime = Math.max(0, av.currentTime - ms); if (ok) addTimer(ok, 0, false, 'av-seek'); },
    getState() { return av.state; },
    getCurrentTime() { return av.currentTime; },
    getDuration() { return 0; },
    getTotalTrackInfo() { return []; },
    getCurrentStreamInfo() { avCall('getCurrentStreamInfo', []); return av.streamInfo ? av.streamInfo(av.url) : []; },
    setSelectTrack() {}
  };
  av.emit = function (name, arg) {
    runTask('av-' + name, function () { if (av.listener && av.listener[name]) av.listener[name](arg); });
  };
  // Like AVPlay: while a stream plays (and is not suspended or stuck) the play time advances and is
  // reported every 500 ms through oncurrentplaytime.
  const AV_TICK_MS = 500;
  addTimer(function () {
    if (av.state !== 'PLAYING' || av.suspended || av.stalled || av.paused) return;
    av.currentTime += AV_TICK_MS;
    if (av.listener && av.listener.oncurrentplaytime) av.listener.oncurrentplaytime(av.currentTime);
  }, AV_TICK_MS, true, 'av-clock');
  av.calledAfter = (fn, seq0) => av.calls.filter((c) => c.fn === fn && c.seq > seq0);

  // ----- the vm context -----
  const index = readIndex();
  const netListeners = [];
  const ports = {};               // message port name -> listeners (tizen.messageport)
  const document = createDocument(index.bodyHtml);
  // Pictures, as the TV's engine (Chromium 47) loads them: every <img> / Image() src is a download unless this page already
  // loaded that URL (the memory cache: complete at once, no request); two elements asking for one URL share one download;
  // a failed picture is not cached (asked again, it is downloaded again). requests: every download started, { url, at }.
  // el.showing: the URL whose picture the element paints — a new src keeps painting the previous picture until the new
  // one has arrived (removeAttribute('src') drops it at once); a failed picture paints nothing.
  const images = document.images = {
    requests: [], loaded: new Set(), inflight: new Map(),
    load(el, url) {
      el._loading = url; el.complete = false;
      if (images.loaded.has(url)) { images.finish(el, url, true); return; }
      if (!images.inflight.has(url)) {
        images.requests.push({ url, at: clock.now });
        images.inflight.set(url, []);
        const status = o.imageStatus ? o.imageStatus(url) : 200;
        if (status !== 'hang') addTimer(function () {      // 'hang': a dead host never answers; the elements wait
          const ok = status === 200, els = images.inflight.get(url);
          images.inflight.delete(url);
          if (ok) images.loaded.add(url);
          els.forEach((e) => images.finish(e, url, ok));
        }, o.imageDelayMs, false, 'image');
      }
      images.inflight.get(url).push(el);
    },
    finish(el, url, ok) {
      if (el._loading !== url) return;              // the element was given another picture meanwhile
      el._loading = null; el.complete = true; el.naturalWidth = ok ? 120 : 0; el.showing = ok ? url : null;
      addTimer(function () { const fn = ok ? el.onload : el.onerror; if (fn) fn.call(el, {}); }, 0, false, 'image-event');
    }
  };
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    navigator: { userAgent: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 3.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/47.0.2526.69 TV Safari/537.36' },
    document,
    localStorage,
    XMLHttpRequest: FakeXHR,
    setTimeout: (fn, ms) => addTimer(fn, ms, false, 'setTimeout'),
    clearTimeout: clearTimer,
    setInterval: (fn, ms) => addTimer(fn, ms, true, 'setInterval'),
    clearInterval: clearTimer,
    Date: createFakeDate(clock),
    innerWidth: 1920,
    innerHeight: 1080,
    location: { reload() { log('reload', {}); } },
    webapis: {
      avplay,
      network: { addNetworkStateChangeListener(fn) { netListeners.push(fn); }, NetworkState: { GATEWAY_CONNECTED: 4, GATEWAY_DISCONNECTED: 5 } },
      productinfo: { getVersion: () => 'T-KTMDEUC-1250.4', getFirmware: () => 'T-KTMDEUC-1250.4', getModel: () => 'UE50MU7000', getRealModel: () => 'UE50MU7000' },
      tvinfo: { getVersion: () => '3.0', isTvsPicSizeResized: () => false }
    },
    tizen: {
      tvinputdevice: { getSupportedKeys: () => [{ name: 'ColorF0Red' }, { name: 'MediaPlayPause' }, { name: 'ChannelUp' }], registerKey() {} },
      application: { getCurrentApplication: () => ({ exit() { log('exit', {}); } }),
        launchAppControl(ctl, id, ok, err) { log('appcontrol', { operation: ctl.operation, uri: ctl.uri }); } },
      ApplicationControl: function (operation, uri) { this.operation = operation; this.uri = uri; },
      systeminfo: { getCapability: () => '3.0', getPropertyValue(name, ok) { if (ok) ok({}); } },
      // Local message ports by name; another app's message is delivered with app.message(port, data).
      messageport: { requestLocalMessagePort(name) {
        return { messagePortName: name, addMessagePortListener(fn) { (ports[name] || (ports[name] = [])).push(fn); return 1; } };
      } }
    },
    Image: function () { return document.createElement('img'); },
    _winListeners: {},
    addEventListener(type, fn) { (sandbox._winListeners[type] || (sandbox._winListeners[type] = [])).push(fn); }
  };
  sandbox.window = sandbox;
  // The real TV throws WebAPIException objects (not Error instances), e.g. { code: 18, name:
  // 'SecurityError' } for a privilege the package lacks. Each listed path throws one on every call.
  const thrown = [];
  for (const p of o.platformThrows) {
    const parts = p.split('.'), name = parts.pop();
    const owner = parts.reduce((x, k) => x && x[k], sandbox);
    if (!owner || typeof owner[name] !== 'function') throw new Error('platformThrows: no such call ' + p);
    owner[name] = function () {
      thrown.push(p);
      log('platform-throw', { path: p });
      throw { code: 18, name: 'SecurityError', message: 'The application does not have the privilege to call this method.' };
    };
  }
  vm.createContext(sandbox);
  const ctxJSON = vm.runInContext('JSON', sandbox);
  const jsonParses = [];
  if (o.random) {
    const ctxMath = vm.runInContext('Math', sandbox);
    sandbox.Math = Object.assign(Object.create(ctxMath), { random: o.random });
  }
  sandbox.JSON = {
    parse(text, reviver) { jsonParses.push({ length: text == null ? 0 : String(text).length, text, at: clock.now }); return ctxJSON.parse(text, reviver); },
    stringify: ctxJSON.stringify
  };

  for (const src of index.scripts) {
    const file = path.join(ROOT, src);
    vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
    // The tests written for the Detailed menu run it unless they ask for the shipped default: MENU_BASIC_DEFAULT: true.
    if (/(^|\/)config\.js$/.test(src) && sandbox.CONFIG) Object.assign(sandbox.CONFIG, { MENU_BASIC_DEFAULT: false }, o.config);
  }

  function dispatchDoc(type, event) {
    for (const fn of (document._listeners[type] || []).slice()) fn(event);
  }

  const app = {
    ctx: sandbox, clock, events, errors, tasks, net, av, document, jsonParses, thrown, images,
    storage: { raw: store, used, reads, writes: () => events.filter((e) => e.type === 'storage-write') },
    seq: () => seq,
    advance, advanceUntil, runTask, log,
    boot() { runTask('onload', function () { sandbox.onload(); }); advance(0); return app; },
    // extra: more fields of the key event, e.g. { repeat: true } (the key held down).
    press(keyCode, gapMs, extra) {
      log('key', { keyCode });
      runTask('key ' + keyCode, function () {
        dispatchDoc('keydown', Object.assign({ keyCode, key: '', preventDefault() {}, stopPropagation() {} }, extra || {}));
      });
      advance(gapMs == null ? 0 : gapMs);
    },
    setHidden(hidden) {
      document.hidden = hidden;
      runTask('visibilitychange', function () { dispatchDoc('visibilitychange', {}); });
    },
    text(id) { const el = document.getElementById(id); return el ? el.textContent : null; },
    visible(id) { const el = document.getElementById(id); return !!el && !/(^|\s)hidden(\s|$)/.test(el.className); },
    // Visible rows of a virtualised list column: their text, top to bottom.
    // Visible rows with their classes and cell texts: [{ text, classes: [..], cells: [num, logo, title, sub] }].
    rowsDetailed(containerId) {
      const el = document.getElementById(containerId);
      return el ? el.children.filter((r) => r.style.visibility !== 'hidden')
        .map((r) => ({ text: r.textContent, classes: r.className.split(/\s+/).filter(Boolean),
          cells: r.children.map((c) => c.textContent) })) : [];
    },
    // Text of the highlighted row of a list column ('focus' or 'sel'), or null.
    cursorRow(containerId) {
      const hit = app.rowsDetailed(containerId).find((r) => r.classes.indexOf('focus') >= 0 || r.classes.indexOf('sel') >= 0);
      return hit ? hit.text : null;
    },
    // Types into a text field the way the on-screen keyboard does (value, then the input event).
    type(id, text) {
      const el = document.getElementById(id);
      runTask('type ' + id, function () { el.value = text; if (el.oninput) el.oninput({}); });
    },
    // The TV's network listener: 'GATEWAY_CONNECTED' | 'GATEWAY_DISCONNECTED'.
    network(state) {
      const v = sandbox.webapis.network.NetworkState[state];
      runTask('network ' + state, function () { netListeners.forEach((fn) => fn(v)); });
    },
    // Another app sends data ([{ key, value }]) to this app's local message port `port`, in its own task.
    message(port, data) {
      log('message', { port });
      runTask('message ' + port, function () { (ports[port] || []).forEach((fn) => fn(data, null)); });
    },
    // A window event the page receives (e.g. 'pagehide', 'unload'), in its own task.
    windowEvent(type) {
      log('window-event', { type });
      runTask('window ' + type, function () { (sandbox._winListeners[type] || []).slice().forEach((fn) => fn({ type })); });
    },
    rows(containerId) {
      const el = document.getElementById(containerId);
      return el ? el.children.filter((r) => r.style.visibility !== 'hidden').map((r) => r.textContent) : [];
    },
    longestTask(fromIndex) { return tasks.slice(fromIndex || 0).reduce((m, t) => Math.max(m, t.ms), 0); }
  };
  return app;
}

module.exports = { createApp, KEYS, DEFAULT_NOW, ROOT, readIndex };
