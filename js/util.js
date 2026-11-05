// Platform helpers: storage, DOM, time, dictionaries, idle scheduling.
// ES5 only: the Tizen 3.0 web engine (Chromium 47) has no let/const, arrow functions or fetch.
// This is the only file that touches localStorage.
var Util = (function () {
  var MIN_MS = 60000, DAY_MS = 86400000;
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  var HIDDEN = /(^|\s)hidden(\s|$)/, CLASS = {};
  var saveFailed = {};

  // A missing or unreadable value is null.
  function load(key) {
    var raw;
    try { raw = localStorage.getItem(key); } catch (e) { return null; }
    if (raw === null) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  // false when the value could not be kept (quota, private mode; recorded once per key) or when its
  // JSON is longer than maxChars (optional; serialised once, the length checked before writing).
  function save(key, value, maxChars) {
    var json;
    try { json = JSON.stringify(value); } catch (e) { return notSaved(key, e); }
    return saveJson(key, json, maxChars);
  }
  // The same for a value serialised already (a big one is serialised in a task of its own).
  function saveJson(key, json, maxChars) {
    if (maxChars && json.length > maxChars) { Diag.note('save.' + key, 'too big: ' + json.length + ' chars'); return false; }
    try { localStorage.setItem(key, json); return true; } catch (e) { return notSaved(key, e); }
  }
  function notSaved(key, e) {
    if (!saveFailed[key] && window.Diag) Diag.note('save.' + key, (e && e.name) || 'error');
    saveFailed[key] = true;
    return false;
  }

  // The same without a word in Diag: false when the storage refused it; the caller counts the refusal itself (LifeLog,
  // whose one-key-per-line ring would otherwise leave a note per slot).
  function store(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
  }

  function remove(key) {
    try { localStorage.removeItem(key); } catch (e) { if (window.Diag) Diag.note('remove.' + key, (e && e.name) || 'error'); }
  }

  // Opens a web page in the TV's browser (on the desktop, a new tab); fail(message) if it cannot.
  function openUrl(url, fail) {
    try {
      if (window.tizen && tizen.application) {
        tizen.application.launchAppControl(new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/view', url), null, null,
          function (e) { fail((e && e.message) || 'error'); });
      } else if (!window.open(url, '_blank')) fail('blocked');
    } catch (e) { fail((e && e.message) || String(e)); }
  }

  // v as an index into a list of n: 0 … n − 1 (the cursor of a list column or a grid).
  function clamp(v, n) { return Math.max(0, Math.min(n - 1, v)); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function hhmm(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  // A programme's time span «21:00–22:00» (start, stop: ms) as one piece: U+2060 word joiners keep it on one line when the
  // title after it wraps, the LRM marks keep it left to right in Hebrew (the banner's and the Basic list's "now" line).
  function span(start, stop) { return '\u200e' + hhmm(new Date(start)) + '\u2060–\u2060' + hhmm(new Date(stop)) + '\u200e'; }
  function $(id) { return document.getElementById(id); }

  // Toggles exactly the class "hidden"; other classes (even ones containing the word) are kept.
  function isHidden(el) { return HIDDEN.test(el.className); }
  function show(el, on) { cls(el, 'hidden', !on); }
  // Puts class `name` on el or takes it off; other classes (even ones containing the word) are kept.
  function cls(el, name, on) {
    var re = CLASS[name] || (CLASS[name] = new RegExp('(^|\\s)' + name + '(?=\\s|$)', 'g'));
    re.lastIndex = 0;
    var has = re.test(el.className);
    if (has === !!on) return;
    re.lastIndex = 0;
    el.className = on ? (el.className ? el.className + ' ' + name : name) : el.className.replace(re, '').trim();
  }

  // An <img>'s onerror: a picture that does not load (a 404, a dead host) is hidden by visibility — no broken-picture
  // icon, its box kept, so nothing moves (review 4, D10). Whoever sets the next picture shows it again.
  function hideBrokenImage() { this.style.visibility = 'hidden'; }

  function escChar(c) { return ESC[c]; }
  function esc(s) { return String(s).replace(/[&<>"]/g, escChar); }

  // A map keyed by provider text: no prototype, so "constructor" or "__proto__" are ordinary keys.
  function dict() { return Object.create(null); }

  // Runs fn when the main thread is idle (or soon, where requestIdleCallback is missing).
  function idle(fn, timeoutMs) {
    if (window.requestIdleCallback) window.requestIdleCallback(fn, { timeout: timeoutMs || 2000 });
    else setTimeout(fn, 1);
  }

  // Runs fn in a task after the next frame is painted (what the current task drew is on screen first); a plain next task
  // where animation frames are missing (the desktop test harness).
  function afterPaint(fn) {
    if (window.requestAnimationFrame) window.requestAnimationFrame(function () { setTimeout(fn, 0); });
    else setTimeout(fn, 0);
  }

  // Calendar arithmetic in local time, so a day across a DST change has 23 or 25 hours.
  function dayStart(t) { var d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
  function addDays(t, n) {
    var d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()).getTime();
  }

  // The one retry delay of the app. Attempt n (0-based) waits min(maxMs, minMs·2^n) plus up to 25 %
  // random spread, so retries never synchronise, not even at the cap. Below the cap a delay never shrinks
  // (one step's spread stays below the next step's base); at the cap it varies within [maxMs, 1.25·maxMs].
  function backoff(n, minMs, maxMs) {
    return Math.round(Math.min(maxMs, minMs * Math.pow(2, n)) * (1 + Math.random() / 4));
  }

  return {
    MIN_MS: MIN_MS, DAY_MS: DAY_MS,
    load: load, save: save, saveJson: saveJson, store: store, remove: remove, clamp: clamp, pad2: pad2, hhmm: hhmm, span: span, $: $, show: show, cls: cls, isHidden: isHidden, hideBrokenImage: hideBrokenImage, esc: esc, dict: dict,
    idle: idle, afterPaint: afterPaint, dayStart: dayStart, addDays: addDays, backoff: backoff, openUrl: openUrl };
}());
