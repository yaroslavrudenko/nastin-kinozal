'use strict';
// COMMON DECISION batch 5, D9 (2026-11-05): the "now" re-read of a cached list (NowLines asap, armed by an hourly catalog
// download while the app was hidden: sources.js:189) is unseen work. On coming back to the front it is held until a first
// frame of the stream in front has come since that moment (the event, never Player's firstFrame flag) AND
// NOW_AFTER_FRONT_MS (15 s) have passed. A programme surface the viewer opens gets fresh data at once: a watched list (the
// Advanced menu, the Basic channel list, search), the banner asked for with INFO, the programme panel; a fresh answer
// redraws the banner on screen. Journaled: «now refresh held (front)», «now refresh released <why>».
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { KEYS } = require('./harness');
const f = require('./fixtures');

const SEC = 1000, MIN = 60 * SEC;
const ev = (app, js) => vm.runInContext(js, app.ctx);
const fresh = (app, from) => app.net.requests((r) => f.isList(r.url) && r.url.indexOf('?t=') > 0 && r.sentAt >= from);
const sentAfter = (app, from) => fresh(app, from).map((r) => r.sentAt - from);
const nowLines = (app) => Array.from(ev(app, 'LifeLog.snapshot().lines')).map((l) => l.split(' ').slice(3).join(' ')).filter((t) => /^now refresh/.test(t));

// An OTT app whose catalog answers come from a cache 3 min past the end of every show (a stale cached list: the fresh
// re-read is armed), playing; then an hour in the background, so the hourly catalog arms the re-read while hidden.
// opts.storage; opts.before(app): run in front before hiding; opts.behind: the hour is spent playing behind the dashboard.
function hiddenAnHour(opts) {
  const o = opts || {};
  const app = f.ottApp({ channels: 30, boot: false, storage: o.storage });
  const base = JSON.parse(app.fixture.list.body);
  const body = (title, from, to) => {
    const d = JSON.parse(JSON.stringify(base));
    for (const id in d) Object.assign(d[id], { name: title, time: Math.floor(from / 1000), time_to: Math.floor(to / 1000) });
    return JSON.stringify(d);
  };
  app.net.route((u) => f.isList(u), () => ({ body: body('Вечерние новости', app.clock.now - 33 * MIN, app.clock.now - 3 * MIN), delay: 300 }));
  app.net.route((u) => f.isList(u.split('?')[0]) && u.indexOf('?') > 0,
    () => ({ body: body('Ночной эфир', app.clock.now - 10 * MIN, app.clock.now + 50 * MIN), delay: SEC }));
  app.boot();
  f.untilPlaying(app);
  app.advance(10 * SEC);
  if (o.before) o.before(app);
  app.setHidden(true);
  if (o.behind) { app.advance(SEC); app.message('kinozal.control', [{ key: 'cmd', value: 'play-behind' }]); }
  app.advance(61 * MIN);
  return app;
}
// Back to the front; returns the visible moment.
function front(app) { const t0 = app.clock.now; app.setHidden(false); return t0; }
// The last first frame of a live stream in the journal, in ms after t0.
function lastFrameAt(app, t0) {
  const frames = Array.from(ev(app, 'LifeLog.snapshot().lines')).filter((l) => /first frame live$/.test(l));
  return Date.parse(frames[frames.length - 1].split(' ')[2]) - t0;
}

test('D9: back in front with the re-read armed while hidden — the picture comes at once, the request goes at 15 s, not before; journaled', () => {
  const app = hiddenAnHour();
  const t0 = front(app);
  app.advance(15 * SEC - 1);
  assert.deepEqual(sentAfter(app, t0), [], 'a request before 15 s');
  app.advance(5 * SEC);
  assert.deepEqual(sentAfter(app, t0), [15 * SEC]);
  assert.deepEqual(nowLines(app), ['now refresh held (front)', 'now refresh released (frame + 15 s)']);
});

test('D9: no first frame in front — no request at 15 s nor at 20 s; the frame at 20 s sends it at once', () => {
  const app = hiddenAnHour();
  app.av.stalled = true;                                      // the rebuilt stream shows no picture
  const t0 = front(app);
  app.advance(20 * SEC);
  assert.deepEqual(sentAfter(app, t0), [], 'a request without a first frame in front');
  app.av.stalled = false;
  app.advance(2 * SEC);
  const frameAt = lastFrameAt(app, t0);
  const sent = sentAfter(app, t0);
  assert.ok(frameAt >= 20 * SEC, 'the frame came at ' + frameAt + ' ms');
  assert.deepEqual(sent, [frameAt], 'requests vs the frame at ' + frameAt + ' ms');
});

test('D9 (stale flag): a stream that played behind the dashboard has shown frames before the return — that does not release it; only a frame in front does', () => {
  const app = hiddenAnHour({ behind: true });
  assert.equal(app.av.state, 'PLAYING', 'not playing behind');
  assert.ok(ev(app, 'Playback.behind()'), 'not behind');
  app.av.stalled = true;                                      // the rebuild in front (D3) shows no picture
  const t0 = front(app);
  app.advance(25 * SEC);
  assert.deepEqual(sentAfter(app, t0), []);
  assert.deepEqual(nowLines(app), ['now refresh held (front)']);
});

for (const [name, storage, open, screen] of [
  ['the Advanced menu (OK)', { menuBasic: 'false' }, (app) => app.press(KEYS.ENTER, 0), 'guide'],
  ['the Basic channel list (OK)', { menuBasic: 'true' }, (app) => app.press(KEYS.ENTER, 0), 'clist'],
  ['search', {}, (app) => ev(app, "Overlay.open('search')"), 'search']
]) {
  test('D9: ' + name + ' opened 3 s after coming back sends the held request at once', () => {
    const app = hiddenAnHour({ storage });
    const t0 = front(app);
    app.advance(3 * SEC);
    assert.deepEqual(sentAfter(app, t0), []);
    open(app);
    app.advance(10);
    assert.ok(app.visible(screen), screen + ' is not open');
    assert.deepEqual(sentAfter(app, t0), [3 * SEC]);
    assert.deepEqual(nowLines(app), ['now refresh held (front)', 'now refresh released (list)']);
  });
}

test('D9: INFO 3 s after coming back sends the held request at once, and the fresh answer redraws the banner on screen', () => {
  const app = hiddenAnHour();
  const t0 = front(app);
  app.advance(3 * SEC);
  app.press(KEYS.INFO, 0);
  app.advance(10);
  assert.deepEqual(sentAfter(app, t0), [3 * SEC]);
  assert.deepEqual(nowLines(app), ['now refresh held (front)', 'now refresh released (banner)']);
  ev(app, 'window.__bannerDraws = 0; (function (b) { UI.banner = function () { window.__bannerDraws++; return b.apply(UI, arguments); }; })(UI.banner)');
  app.advance(2 * SEC);                                       // the answer (1 s) and its parse at idle
  assert.ok(ev(app, 'UI.bannerShown()'), 'the banner is no longer up');
  assert.ok(ev(app, 'window.__bannerDraws') >= 1, 'the banner was not redrawn with the fresh answer');
});

test('D9: the programme panel (▼) opened 3 s after coming back sends the held request at once', () => {
  const app = hiddenAnHour();
  const t0 = front(app);
  app.advance(3 * SEC);
  app.press(KEYS.DOWN, 10);
  assert.ok(app.visible('prog'), 'the panel did not open');
  assert.deepEqual(sentAfter(app, t0), [3 * SEC]);
  assert.deepEqual(nowLines(app), ['now refresh held (front)', 'now refresh released (panel)']);
});

test('D9: a list already open when the app comes back is served at once (no hold)', () => {
  const app = hiddenAnHour({ storage: { menuBasic: 'false' }, before: (a) => a.press(KEYS.ENTER, 2 * SEC) });
  assert.ok(app.visible('guide'), 'the menu is not open');
  const t0 = front(app);
  app.advance(10);
  assert.deepEqual(sentAfter(app, t0), [0]);
  assert.deepEqual(nowLines(app), []);
});

test('D9: repeated visibility changes — hidden during the hold sends nothing behind; the next return holds from its own moment', () => {
  const app = hiddenAnHour();
  const t0 = front(app);
  app.advance(5 * SEC);
  app.setHidden(true);
  app.advance(30 * SEC);
  assert.deepEqual(sentAfter(app, t0), [], 'a request behind or during the hold');
  assert.deepEqual(nowLines(app), ['now refresh held (front)', 'now refresh released (cancelled)']);
  app.advance(61 * MIN);                                      // another hourly catalog while hidden arms it again
  const t1 = front(app);
  app.advance(14 * SEC);
  assert.deepEqual(sentAfter(app, t0), [], 'a request before 15 s after the second return');
  app.advance(2 * SEC);
  assert.deepEqual(sentAfter(app, t1), [15 * SEC]);
  assert.deepEqual(nowLines(app).slice(2), ['now refresh held (front)', 'now refresh released (frame + 15 s)']);
});

// ---- Fix batch 5B (fix-verify-5 REJECTs; the banner point signed 4/4 in rounds 8–9) ----
const guides = (app, from, to) => app.net.requests((r) => f.isGuide(r.url) && r.sentAt >= from && r.sentAt < to);
const lists = (app, from, to) => app.net.requests((r) => f.isList(r.url) && r.sentAt >= from && r.sentAt < to);

test('D9 (A): the launch \'visible\' with the cached-list re-read pending holds nothing — the request goes at once, no "held" line', () => {
  const app = f.ottApp({ channels: 30, boot: false });
  const base = JSON.parse(app.fixture.list.body);
  for (const id in base) Object.assign(base[id], { name: 'Вечерние новости', time: Math.floor((app.clock.now - 33 * MIN) / 1000), time_to: Math.floor((app.clock.now - 3 * MIN) / 1000) });
  app.net.route((u) => f.isList(u), () => ({ body: JSON.stringify(base), delay: 300 }));
  // Tizen's 'visible' right after launch, in the task that applies the cached list: the re-read is armed and not sent yet.
  let launchVisibleAt = -1, sentBefore = -1;
  app.ctx.__launchVisible = () => { launchVisibleAt = app.clock.now; sentBefore = fresh(app, 0).length; app.setHidden(false); };
  ev(app, '(function (c) { NowLines.cachedList = function () { c.apply(NowLines, arguments); __launchVisible(); }; })(NowLines.cachedList)');
  app.boot();
  app.advanceUntil(() => launchVisibleAt >= 0, 5000);
  assert.ok(launchVisibleAt >= 0, 'the cached list never arrived');
  assert.equal(sentBefore, 0, 'the re-read was sent before the launch visibility event');
  app.advance(50);
  assert.deepEqual(sentAfter(app, launchVisibleAt), [0]);
  assert.deepEqual(nowLines(app), []);
});

test('D9 (A): a second \'visible\' 3 s into the hold, with no hidden between, changes nothing — the request still goes at 15 s', () => {
  const app = hiddenAnHour();
  const t0 = front(app);
  app.advance(3 * SEC);
  app.setHidden(false);                                       // a repeated notification: playback rebuilds nothing
  app.advance(12 * SEC - 1);
  assert.deepEqual(sentAfter(app, t0), [], 'a request before 15 s');
  app.advance(15 * SEC);
  assert.deepEqual(sentAfter(app, t0), [15 * SEC]);
  assert.deepEqual(nowLines(app), ['now refresh held (front)', 'now refresh released (frame + 15 s)']);
});

test('D9 (C): a frame whose attempt then failed does not count — a stalled retry keeps the hold past 15 s; the next attempt\'s frame sends it', () => {
  const app = hiddenAnHour();
  const t0 = front(app);
  app.advance(2 * SEC);
  const frameAt = lastFrameAt(app, t0);
  assert.ok(frameAt >= 0 && frameAt < 2 * SEC, 'no frame in front after the return (' + frameAt + ' ms)');
  app.av.stalled = true;                                      // the picture stops: the attempt fails (stalled) and its retry shows none
  app.advance(18 * SEC);
  const lines = Array.from(ev(app, 'LifeLog.snapshot().lines'));
  assert.ok(lines.some((l) => /fail/.test(l) && /stalled/.test(l)), 'the attempt never failed');
  assert.deepEqual(sentAfter(app, t0), [], 'a request on the failed attempt\'s frame');
  assert.deepEqual(nowLines(app), ['now refresh held (front)']);
  app.av.stalled = false;
  app.advanceUntil(() => lastFrameAt(app, t0) > 20 * SEC, 60 * SEC);
  const nextFrameAt = lastFrameAt(app, t0);
  assert.ok(nextFrameAt > 20 * SEC, 'no new frame (' + nextFrameAt + ' ms)');
  app.advance(10);
  assert.deepEqual(sentAfter(app, t0), [nextFrameAt], 'requests vs the next attempt\'s frame at ' + nextFrameAt + ' ms');
});

test('D9 (D): the programme panel already open when the app comes back is served at once (no hold, no "held" line)', () => {
  const app = hiddenAnHour({ before: (a) => a.press(KEYS.DOWN, 2 * SEC) });
  const t0 = front(app);
  app.advance(10);
  assert.ok(app.visible('prog'), 'the panel is not open');
  assert.deepEqual(sentAfter(app, t0), [0]);
  assert.deepEqual(nowLines(app), []);
});

// B: the automatic banners (opened, connecting, loading, retrying, first frame: Banner.show(false)) neither release the hold
// nor fetch anything; the playing channel's guide comes from the first-frame settle (zap.js EPG.ensure → Banner.onGuide), at
// the frame on a return (its delay max(0, lastStepAt + ZAP_IDLE_MS − now) is 0). INFO (show(true)) releases at once: the
// "INFO 3 s after coming back" test above.
for (const [name, guideFresh] of [['a guide older than GUIDE_FRESH_MS', false], ['a guide newer than GUIDE_FRESH_MS', true]]) {
  test('D9 (B): back with ' + name + ' — the automatic banners request nothing before the frame; ' +
    (guideFresh ? 'no guide request' : 'one guide request by frame + ZAP_IDLE_MS') + '; the full list at frame + 15 s', () => {
    const app = hiddenAnHour({ before: guideFresh ? (a) => ev(a, 'CONFIG.GUIDE_FRESH_MS = 3 * 3600000') : null });
    const id = ev(app, 'Playback.current().id'), zapIdle = ev(app, 'CONFIG.ZAP_IDLE_MS');
    ev(app, 'window.__autoBanners = 0; (function (s) { Banner.show = function (g) { if (!g) window.__autoBanners++; return s.apply(Banner, arguments); }; })(Banner.show)');
    const t0 = front(app);
    app.advanceUntil(() => lastFrameAt(app, t0) >= 0, 10 * SEC, 1);
    const frameAt = lastFrameAt(app, t0);
    assert.ok(ev(app, 'window.__autoBanners') >= 1, 'no automatic banner before the frame');
    assert.deepEqual(guides(app, t0, t0 + frameAt).map((r) => r.url), [], 'a guide request before the frame');
    assert.deepEqual(lists(app, t0, t0 + frameAt).map((r) => r.url), [], 'a list request before the frame');
    app.advance(zapIdle + 10);
    const g = guides(app, t0, t0 + frameAt + zapIdle + 1);
    if (guideFresh) assert.deepEqual(g.map((r) => r.url), [], 'a fresh guide was requested');
    else assert.deepEqual(g.map((r) => f.guideIdOf(r.url)), [id], 'the playing channel\'s guide by frame + ZAP_IDLE_MS');
    app.advance(15 * SEC - frameAt - zapIdle - 20);
    assert.deepEqual(lists(app, t0, app.clock.now).map((r) => r.sentAt - t0), [], 'a list request before frame + 15 s');
    app.advance(2 * SEC);
    assert.deepEqual(sentAfter(app, t0), [15 * SEC]);
    assert.equal(lists(app, t0, app.clock.now).length, 1, 'more than one list request');
    assert.equal(guides(app, t0, app.clock.now).length, guideFresh ? 0 : 1, 'guide requests after the return');
    assert.deepEqual(nowLines(app), ['now refresh held (front)', 'now refresh released (frame + 15 s)']);
  });
}
