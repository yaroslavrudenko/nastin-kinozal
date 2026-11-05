'use strict';
// COMMON-DECISION player-behind (2026-11-05, judges' round 5): the player after hours behind the Home Dashboard.
//   D1 the background releases AVPlay (stop + close), never av.suspend();
//   D2 only a healthy foreground channel change may reuse the stopped player; every retry, reconnect, start, rebuild and
//      detour closes it first;
//   D3 back in front after playing behind: the stream born in the background is rebuilt (close → open), the next hide
//      suspends again;
//   D4 the player's own exit stops the stream first;
//   D6 after 3 live failures of X one other channel Y is played for a moment (X stays the channel); X again after Y's
//      first frame, Y's error or 15 s; another detour only after 20 further failures; an absolute 30 s first-frame deadline;
//   D7 the life journal (localStorage lifeLog*), redacted, kept across a restart;
//   D8 a held Back, or Back within 1500 ms of coming to the front, never exits.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { KEYS, ROOT } = require('./harness');
const f = require('./fixtures');

const PORT = 'kinozal.control';
const ev = (app, js) => vm.runInContext(js, app.ctx);
const send = (app, cmd) => app.message(PORT, [{ key: 'cmd', value: cmd }]);
const opensAfter = (app, seq) => app.av.calledAfter('open', seq).map((c) => c.args[0]);
const exits = (app, seq) => app.events.filter((e) => e.type === 'exit' && e.seq > (seq || 0));
function noErrors(app) { assert.deepEqual(app.errors.map((e) => e.label + ': ' + e.error), []); }
// The fast channel switch on (CONFIG.AV_REUSE_NO_CLOSE = true, player.js:18; the default, config.js:92), pinned.
function watching(opts) {
  const o = Object.assign({}, opts || {});
  o.storage = Object.assign({ fastSwitch: 'true' }, o.storage || {});
  const app = f.untilPlaying(f.ottApp(o));
  app.advance(10000);
  assert.equal(ev(app, 'CONFIG.AV_REUSE_NO_CLOSE'), true, 'the fast switch is not on');
  return app;
}
function behindThenFront(app) {
  app.setHidden(true); app.advance(1000);
  send(app, 'play-behind'); app.advance(3000);
  const seq = app.seq();
  app.setHidden(false); app.advance(3000);
  return seq;
}
// The calls of AVPlay between seq and the first open after it: ['stop', 'close', 'open'] or ['stop', 'open'].
function teardownBeforeOpen(app, seq) {
  const calls = app.av.calls.filter((c) => c.seq > seq && ['stop', 'close', 'open'].indexOf(c.fn) >= 0).map((c) => c.fn);
  return calls.slice(0, calls.indexOf('open') + 1);
}
// X (the channel on screen) fails now (the TV's error) and every later attempt on its URL fails to prepare.
function failingX(app) {
  const x = f.lastOpenUrl(app);
  app.av.prepareFails = (u) => u === x;
  app.av.emit('onerror', 'PLAYER_ERROR_NOT_SUPPORTED_FORMAT');
  return x;
}
const lifeLines = (app) => ev(app, 'LifeLog.snapshot().lines');

// ---- D1 ----------------------------------------------------------------------------------------------------------
test('D1: the background releases AVPlay with stop + close, never suspend()', () => {
  const app = watching();
  const seq = app.seq();
  app.setHidden(true);
  app.advance(1000);
  assert.equal(app.av.calledAfter('suspend', seq).length, 0, 'av.suspend() was called');
  assert.equal(app.av.calledAfter('stop', seq).length, 1, 'not stopped');
  assert.equal(app.av.calledAfter('close', seq).length, 1, 'not closed');
  assert.equal(app.av.state, 'NONE');
  noErrors(app);
});

test('D1: no av.suspend() anywhere in the app', () => {
  const hits = fs.readdirSync(path.join(ROOT, 'js')).filter((n) => /\.js$/.test(n))
    .filter((n) => /\bav\.suspend\(/.test(fs.readFileSync(path.join(ROOT, 'js', n), 'utf8')));
  assert.deepEqual(hits, []);
});

// ---- D2 ----------------------------------------------------------------------------------------------------------
test('D2: a healthy channel change still reuses the stopped player (fast switch: no close)', () => {
  const app = watching({ channels: 10 });
  const seq = app.seq();
  app.press(KEYS.RIGHT, 2000);
  assert.deepEqual(teardownBeforeOpen(app, seq), ['stop', 'open']);
});

test('D2: a retry after a failure closes the player before it opens again (fast switch on)', () => {
  const app = watching();
  const seq = app.seq();
  app.av.emit('onerror', 'PLAYER_ERROR_CONNECTION_FAILED');
  app.advance(3000);
  assert.deepEqual(teardownBeforeOpen(app, seq), ['stop', 'close', 'open']);
});

test('D2: a reconnect after a failure closes the player before it opens again (fast switch on)', () => {
  const app = watching();
  app.av.emit('onerror', 'PLAYER_ERROR_CONNECTION_FAILED');
  const seq = app.seq();
  app.network('GATEWAY_CONNECTED');
  app.advance(100);
  assert.deepEqual(teardownBeforeOpen(app, seq), ['stop', 'close', 'open']);
});

test('D2: a zap right after a failure (not healthy) closes the player first', () => {
  const app = watching({ channels: 10 });
  app.av.emit('onerror', 'PLAYER_ERROR_CONNECTION_FAILED');
  const seq = app.seq();
  app.press(KEYS.RIGHT, 100);
  assert.deepEqual(teardownBeforeOpen(app, seq), ['stop', 'close', 'open']);
});

// ---- D3 ----------------------------------------------------------------------------------------------------------
test('D3: back in front after playing behind, the stream is rebuilt once (close → open), the same channel', () => {
  const app = watching();
  const liveUrl = f.lastOpenUrl(app);
  const seq = behindThenFront(app);
  assert.deepEqual(opensAfter(app, seq), [liveUrl], 'the stream born behind was not rebuilt once');
  // Player.suspend() (stop, close) and then the open's own teardown: the player is closed right before it opens.
  assert.deepEqual(teardownBeforeOpen(app, seq).slice(-2), ['close', 'open']);
  assert.equal(app.av.state, 'PLAYING');
  assert.equal(ev(app, 'Playback.mode()'), 'live');
  noErrors(app);
});

test('D3: after the front-after-behind rebuild the next hide suspends again (nothing plays behind another app)', () => {
  const app = watching();
  behindThenFront(app);
  const seq = app.seq();
  app.setHidden(true);
  app.advance(30000);
  assert.equal(app.av.calledAfter('close', seq).length, 1, 'the second hide did not release the player');
  assert.deepEqual(opensAfter(app, seq), [], 'something opened behind another app');
});

test('D3: an archive played behind is rebuilt at the moment on screen when it comes to the front', () => {
  const app = f.untilPlaying(f.ottApp({ guideLatency: 10 }));
  app.advance(2000);
  app.press(KEYS.DOWN, 50); app.press(KEYS.UP, 50); app.press(KEYS.ENTER, 0);
  app.advanceUntil(() => app.av.state === 'PLAYING' && f.archiveStartOf(app.av.url) !== null, 5000, 10);
  app.advance(30000);
  app.setHidden(true); app.advance(1000);
  send(app, 'play-behind'); app.advance(3000);
  const seq = app.seq();
  const before = ev(app, 'Playback.position()');            // the moment on screen right before it comes to the front (R7)
  app.setHidden(false); app.advance(3000);
  const opens = opensAfter(app, seq);
  assert.equal(opens.length, 1);
  assert.equal(ev(app, 'Playback.mode()'), 'archive');
  const shown = f.archiveStartOf(opens[0]);
  assert.ok(shown !== null && Math.abs(shown - before) <= 10000, 'reopened at ' + shown + ', on screen before: ' + before);
});

test('D3: the late stop-behind after coming to the front stops nothing', () => {
  const app = watching();
  behindThenFront(app);
  const seq = app.seq();
  send(app, 'stop-behind');
  app.advance(3000);
  assert.equal(app.av.calledAfter('close', seq).length, 0);
  assert.equal(app.av.state, 'PLAYING');
});

// ---- D4 / D8 -----------------------------------------------------------------------------------------------------
test('D4: the player\'s own exit (Back twice) stops and closes the stream before exit()', () => {
  const app = watching();
  const seq = app.seq();
  app.press(KEYS.BACK, 500);
  app.press(KEYS.BACK, 0);
  const exit = exits(app, seq);
  assert.equal(exit.length, 1, 'no exit');
  const close = app.av.calledAfter('close', seq);
  assert.ok(close.length === 1 && close[0].seq < exit[0].seq, 'the stream was not closed before exit()');
  assert.ok(lifeLines(app).some((l) => /exit-js double-back/.test(l)), 'exit-js not journaled');
});

test('D8: a held Back (repeat keydowns) never exits, even beyond 1500 ms', () => {
  const app = watching();
  const seq = app.seq();
  app.press(KEYS.BACK, 1600, { repeat: false });          // fresh: «press Back again»
  app.press(KEYS.BACK, 100, { repeat: true });
  app.press(KEYS.BACK, 100, { repeat: true });
  assert.equal(exits(app, seq).length, 0, 'a repeated Back exited');
  assert.ok(lifeLines(app).some((l) => /back ignored \(repeat\)/.test(l)), 'the ignored Back is not journaled');
});

test('D8: Back within 1500 ms after coming to the front never exits; later fresh presses do', () => {
  const app = watching();
  app.setHidden(true); app.advance(1000);
  app.setHidden(false);
  const seq = app.seq();
  app.press(KEYS.BACK, 300);
  app.press(KEYS.BACK, 300);
  assert.equal(exits(app, seq).length, 0, 'Back right after becoming visible exited');
  app.advance(1000);                                       // > 1500 ms after becoming visible
  app.press(KEYS.BACK, 500);
  app.press(KEYS.BACK, 0);
  assert.equal(exits(app, seq).length, 1, 'two fresh accepted presses did not exit');
});

test('D8: the exit confirmation is cleared when the player comes to the front', () => {
  const app = watching();
  const seq = app.seq();
  app.press(KEYS.BACK, 0);                                 // «press Back again»
  app.setHidden(true); app.advance(10);
  app.setHidden(false); app.advance(1600);
  app.press(KEYS.BACK, 0);                                 // within EXIT_CONFIRM_MS of the first, but the confirmation was cleared
  assert.equal(exits(app, seq).length, 0, 'an exit confirmation from before the background was used');
});

// ---- D6 ----------------------------------------------------------------------------------------------------------
test('D6: after 3 live failures of X one other channel Y plays; X stays the channel, no landing bookkeeping for Y', () => {
  const app = watching({ channels: 10 });
  const xKey = ev(app, 'Playback.current().key');
  const seq = app.seq();
  const x = failingX(app);
  app.advanceUntil(() => opensAfter(app, seq).some((u) => u !== x), 20000);
  const opens = opensAfter(app, seq);
  assert.equal(opens.length, 3, 'opens: ' + opens.join(' | '));
  assert.deepEqual(opens.slice(0, 2), [x, x]);
  const y = opens[2];
  assert.notEqual(y, x);
  const ySeq = app.seq();
  app.advance(2000);                                       // Y's first frame, then X again in the next task
  assert.equal(opensAfter(app, ySeq)[0], x, 'X was not reopened after Y\'s first frame');
  assert.equal(ev(app, 'Playback.current().key'), xKey, 'the logical channel changed');
  assert.equal(ev(app, 'Playback.mode()'), 'live');
  const yWrites = app.storage.writes().filter((w) => w.seq > seq && !/^life/.test(w.key) && w.value.indexOf(f.streamIdOf(y) + '.m3u8') >= 0);
  assert.deepEqual(yWrites.map((w) => w.key), [], 'Y was remembered as a landing');
  const yGuide = app.net.requests((r) => r.sendSeq > seq && f.isGuide(r.url) && f.guideIdOf(r.url) === f.streamIdOf(y));
  assert.equal(yGuide.length, 0, 'Y\'s guide was asked for');
  assert.ok(lifeLines(app).some((l) => /detour start/.test(l)) && lifeLines(app).some((l) => /detour result frame/.test(l)));
  noErrors(app);
});

test('D6: Y failing returns to X in the next task', () => {
  const app = watching({ channels: 10 });
  const seq = app.seq();
  const x = f.lastOpenUrl(app);
  app.av.prepareFails = () => true;                        // Y fails as well
  app.av.emit('onerror', 'PLAYER_ERROR_NOT_SUPPORTED_FORMAT');
  app.advanceUntil(() => opensAfter(app, seq).some((u) => u !== x), 20000);
  const ySeq = app.seq();
  app.advanceUntil(() => opensAfter(app, ySeq).length > 0, 2000, 10);
  assert.equal(opensAfter(app, ySeq)[0], x);
  assert.ok(app.clock.now - app.events.find((e) => e.seq === ySeq).at <= 300 + 1000);
  assert.ok(lifeLines(app).some((l) => /detour result error/.test(l)));
});

test('D6: Y never answering returns to X at the absolute 15 s deadline', () => {
  const app = watching({ channels: 10 });
  const seq = app.seq();
  const x = failingX(app);
  app.av.prepareHangs = (u) => u !== x;
  app.advanceUntil(() => opensAfter(app, seq).some((u) => u !== x), 20000);
  const yAt = app.clock.now;
  const ySeq = app.seq();
  app.advanceUntil(() => opensAfter(app, ySeq).length > 0, 30000, 50);
  assert.equal(opensAfter(app, ySeq)[0], x);
  const waited = app.clock.now - yAt;
  assert.ok(waited >= 14900 && waited <= 15200, 'X came back after ' + waited + ' ms');
});

test('D6: another detour only after 20 further failures of X', () => {
  const app = watching({ channels: 10 });
  const seq = app.seq();
  const x = failingX(app);
  app.advance(900000);
  const opens = opensAfter(app, seq);
  const yAt = opens.map((u, i) => (u !== x ? i : -1)).filter((i) => i >= 0);
  assert.ok(yAt.length >= 2, 'detours: ' + yAt.length);
  assert.equal(yAt[0], 2, 'the first detour is not after the third failure');
  assert.equal(yAt[1] - yAt[0] - 1, 20, 'X attempts between the detours: ' + (yAt[1] - yAt[0] - 1));
});

test('D6: a pause cancels a pending detour; resuming plays X again (at the paused moment), never the cancelled detour', () => {
  const app = watching({ channels: 10 });
  const seq = app.seq();
  const x = failingX(app);
  app.advanceUntil(() => lifeLines(app).some((l) => /fail #3 /.test(l)), 10000, 10);   // the detour waits in the retry slot
  app.press(KEYS.PLAY_PAUSE, 5000);
  assert.equal(ev(app, 'Playback.mode()'), 'paused');
  assert.ok(opensAfter(app, seq).every((u) => u === x), 'the pending detour ran during the pause');
  const rSeq = app.seq();
  app.press(KEYS.PLAY_PAUSE, 3000);
  const opens = opensAfter(app, rSeq);
  assert.ok(opens.length >= 1 && f.streamIdOf(opens[0]) === f.streamIdOf(x), 'resumed on another channel: ' + opens.join(' | '));
  assert.ok(lifeLines(app).filter((l) => /detour start/.test(l)).length === 0, 'the cancelled detour started');
});

for (const [what, act] of [
  ['a new channel chosen', (app) => { app.av.prepareHangs = null; app.press(KEYS.RIGHT, 0); }],
  ['the app hidden', (app) => app.setHidden(true)],
  ['the stream stopped (exit)', (app) => { app.press(KEYS.BACK, 500); app.press(KEYS.BACK, 0); }]
]) {
  test('D6: ' + what + ' during a detour cancels it: X is not reopened by the detour', () => {
    const app = watching({ channels: 10 });
    const seq = app.seq();
    const x = failingX(app);
    app.av.prepareHangs = (u) => u !== x;
    app.advanceUntil(() => opensAfter(app, seq).some((u) => u !== x), 20000);
    const cSeq = app.seq();
    act(app);
    app.advance(20000);
    assert.ok(opensAfter(app, cSeq).every((u) => u !== x), 'the cancelled detour reopened X: ' + opensAfter(app, cSeq).join(' | '));
    if (what === 'a new channel chosen') assert.equal(opensAfter(app, cSeq).length, 1, 'the cancelled detour opened again: ' + opensAfter(app, cSeq).join(' | '));
    assert.ok(lifeLines(app).some((l) => /detour cancelled/.test(l)), 'the cancellation is not journaled');
    noErrors(app);
  });
}

test('D6: pause during a detour cancels it; play resumes X', () => {
  const app = watching({ channels: 10 });
  const seq = app.seq();
  const x = failingX(app);
  app.av.prepareHangs = (u) => u !== x;
  app.advanceUntil(() => opensAfter(app, seq).some((u) => u !== x), 20000);
  const cSeq = app.seq();
  app.press(KEYS.PLAY_PAUSE, 20000);
  assert.equal(ev(app, 'Playback.mode()'), 'paused');
  assert.deepEqual(opensAfter(app, cSeq), [], 'something opened during the pause');
  assert.equal(app.av.calledAfter('play', cSeq).length, 0, 'the detour\'s stream played on during the pause');
  assert.equal(app.av.calledAfter('stop', cSeq).length, 1, 'the detour\'s stream was not stopped by the pause');
  app.press(KEYS.PLAY_PAUSE, 1000);
  const resumed = opensAfter(app, cSeq);
  assert.ok(resumed.length === 1 && f.streamIdOf(resumed[0]) === f.streamIdOf(x), 'X did not resume: ' + resumed.join(' | '));
});

test('D6: a pending detour is cancelled by hiding the app before it runs', () => {
  const app = watching({ channels: 10 });
  const seq = app.seq();
  const x = failingX(app);
  app.advanceUntil(() => /#3 /.test(lifeLines(app).filter((l) => /fail #/.test(l)).pop() || ''), 10000, 10);
  app.setHidden(true);
  app.advance(30000);
  assert.ok(opensAfter(app, seq).every((u) => u === x), 'the detour ran in the background');
});

test('D6: an archive never detours', () => {
  const app = f.untilPlaying(f.ottApp({ guideLatency: 10, channels: 10 }));
  app.advance(2000);
  app.press(KEYS.DOWN, 50); app.press(KEYS.UP, 50); app.press(KEYS.ENTER, 0);
  app.advanceUntil(() => app.av.state === 'PLAYING' && f.archiveStartOf(app.av.url) !== null, 5000, 10);
  app.advance(5000);
  const seq = app.seq();
  app.av.prepareFails = () => true;
  app.av.emit('onerror', 'PLAYER_ERROR_NOT_SUPPORTED_FORMAT');
  app.advance(120000);
  const opens = opensAfter(app, seq);
  assert.ok(opens.length >= 5);
  assert.deepEqual(opens.filter((u) => f.archiveStartOf(u) === null), [], 'a live stream was opened from an archive');
  assert.equal(app.net.requests((r) => r.sendSeq > seq && f.isStream(r.url)).length, 0, 'an archive\'s failures probed the stream');
});

test('D6: a stable X starts the failure episode over', () => {
  const app = watching({ channels: 10 });
  const seq = app.seq();
  const x = f.lastOpenUrl(app);
  app.av.emit('onerror', 'PLAYER_ERROR_NOT_SUPPORTED_FORMAT');   // failure 1 and 2, then X plays and is stable
  app.advance(1500);
  app.av.emit('onerror', 'PLAYER_ERROR_NOT_SUPPORTED_FORMAT');
  app.advance(40000);
  app.av.emit('onerror', 'PLAYER_ERROR_NOT_SUPPORTED_FORMAT');   // failure 1 of a new episode
  app.advance(3000);
  app.av.emit('onerror', 'PLAYER_ERROR_NOT_SUPPORTED_FORMAT');
  app.advance(3000);
  assert.ok(opensAfter(app, seq).every((u) => u === x), 'a detour after failures of two separate episodes');
});

test('D6: a live stream with no first frame fails at the absolute 30 s deadline, even while buffering progresses', () => {
  const app = watching({ channels: 10 });
  app.av.stalled = true;                                   // the next channel never shows a frame
  const seq = app.seq();
  app.press(KEYS.RIGHT, 0);
  const openAt = app.clock.now;
  let pct = 0;
  for (let t = 0; t < 40000; t += 1000) {
    app.advance(1000);
    app.av.emit('onbufferingprogress', Math.min(99, ++pct));
    if (lifeLines(app).some((l) => /no first frame/.test(l))) break;
  }
  const failLine = lifeLines(app).find((l) => /fail #1 no first frame/.test(l));
  assert.ok(failLine, 'no deadline failure; lines: ' + lifeLines(app).slice(-5).join(' | '));
  assert.ok(app.clock.now - openAt <= 32000, 'the deadline came after ' + (app.clock.now - openAt) + ' ms');
  assert.ok(app.av.calledAfter('open', seq).length >= 1);
});

// ---- D7 ----------------------------------------------------------------------------------------------------------
const STORED_LIFE = (app) => Array.from(app.storage.raw.entries()).filter(([k]) => /^life/.test(k));

test('D7: the journal records boot, opens, AVPlay calls, the first frame, failures, keys (with repeat), visibility and control', () => {
  const app = watching();
  app.press(KEYS.INFO, 100);
  app.press(KEYS.INFO, 100, { repeat: true });
  app.setHidden(true); app.advance(100);
  send(app, 'play-behind'); app.advance(3000);
  app.windowEvent('pagehide');
  const lines = lifeLines(app);
  for (const re of [/ boot \S+ v1\.\d+\.\d+/, /open live /, /av\.open$/, /av\.open ok/, /av\.prepareAsync/, /av\.play ok/, /first frame/,
    /key 457$/, /key 457 repeat/, /visibility hidden/, /control play-behind done/, /pagehide/]) {
    assert.ok(lines.some((l) => re.test(l)), 'missing ' + re + ' in ' + lines.length + ' lines');
  }
  const stored = STORED_LIFE(app).map(([, v]) => v).join('\n');
  assert.ok(stored.indexOf('control play-behind done') >= 0, 'not written to storage synchronously');
  noErrors(app);
});

test('D7: a failure and the fast-switch close skip are journaled', () => {
  const app = watching({ channels: 10 });
  app.press(KEYS.RIGHT, 2000);
  app.av.emit('onerror', 'PLAYER_ERROR_NOT_SUPPORTED_FORMAT');
  app.advance(2000);
  const lines = lifeLines(app);
  assert.ok(lines.some((l) => /av\.close skipped/.test(l)), 'close skip not journaled');
  assert.ok(lines.some((l) => /fail #1 PLAYER_ERROR_NOT_SUPPORTED_FORMAT/.test(l)), 'failure not journaled');
});

test('D7: alive every 5 s, front or behind', () => {
  const app = watching();
  app.setHidden(true); app.advance(100);
  send(app, 'play-behind');
  const at0 = app.clock.now;
  app.advance(12000);
  const alive = app.storage.writes().filter((w) => w.key === 'lifeAlive' && w.at > at0);
  assert.ok(alive.length >= 2, 'alive writes: ' + alive.length);
  assert.match(alive[alive.length - 1].value, /hidden live behind/);
});

test('D7: no credentials in any journal line (OTT key, M3U user and password)', () => {
  const app = watching();
  failingX(app);
  app.advance(10000);
  const leaks = STORED_LIFE(app).filter(([, v]) => v.indexOf(f.FAKE_KEY) >= 0);
  assert.deepEqual(leaks.map(([k]) => k), []);
  assert.ok(lifeLines(app).some((l) => /\/stream\/<key>\//.test(l)), 'stream URLs not journaled in redacted form');
  const m3u = f.m3uApp({ channels: 3, m3u: { streamUrl: (id) => 'http://anastasia:fake123@iptv.example.test/live/anastasia/fake123/' + id + '.m3u8?username=anastasia&password=fake123' } });
  f.untilPlaying(m3u);
  m3u.av.prepareFails = () => true;
  m3u.av.emit('onerror', 'x');
  m3u.advance(20000);
  const m3uLeaks = STORED_LIFE(m3u).filter(([, v]) => v.indexOf('fake123') >= 0 || v.indexOf('anastasia') >= 0);
  assert.deepEqual(m3uLeaks.map(([k, v]) => k + '=' + v.slice(0, 120)), []);
});

test('D7: the previous boot\'s last records survive the next launch (lifeLogPrev)', () => {
  const first = watching();
  first.press(KEYS.INFO, 100);
  first.setHidden(true); first.advance(100);
  const firstBoot = ev(first, 'LifeLog.snapshot().boot');
  const storage = Object.fromEntries(first.storage.raw);
  const second = f.untilPlaying(createAppLike(storage));
  const prev = JSON.parse(second.storage.raw.get('lifeLogPrev'));
  assert.equal(prev.boot, firstBoot);
  assert.ok(prev.lines.some((l) => /visibility hidden/.test(l)), 'the previous boot\'s last line is gone');
  assert.ok(prev.alive && prev.pins && prev.pins.visibility, 'alive / pins of the previous boot not kept');
  assert.notEqual(ev(second, 'LifeLog.snapshot().boot'), firstBoot);
  assert.ok(!ev(second, 'LifeLog.snapshot().lines').some((l) => /visibility hidden/.test(l)), 'the old boot\'s lines are in the new one');
});
function createAppLike(storage) {
  const app = f.ottApp({ boot: false, storage: Object.fromEntries(Object.entries(storage).map(([k, v]) => [k, v])) });
  app.boot();
  return app;
}

test('D7: the storage refusing the journal never breaks the app; the refusal is counted', () => {
  const app = f.untilPlaying(f.ottApp({ quotaChars: 600 }));    // the list's offline copy and the journal do not fit
  app.advance(10000);
  noErrors(app);
  assert.ok(ev(app, 'LifeLog.snapshot().refused') > 0, 'nothing was refused');
  assert.equal(app.av.state, 'PLAYING');
});

test('D7: at the third failure one bounded GET of the live playlist is journaled (status, type, first 80 chars, redacted)', () => {
  const app = watching({ channels: 10 });
  const seq = app.seq();
  const x = failingX(app);
  app.advance(20000);
  const probes = app.net.requests((r) => r.sendSeq > seq && r.url === x);
  assert.equal(probes.length, 1, 'probe requests: ' + probes.length);
  const line = lifeLines(app).find((l) => /probe result/.test(l));
  assert.ok(line && /probe result 200 /.test(line) && /#EXTM3U/.test(line), 'line: ' + line);
  assert.ok(line.indexOf(f.FAKE_KEY) < 0);
});

// ==== Fix batch 2 (2026-11-05, the union of the four fix-verification REJECTs: R1–R7) ===============================
const storedLines = (app) => STORED_LIFE(app).map(([k, v]) => k + '=' + v);
const lifeWritesBetween = (app, from, to) => app.storage.writes().filter((w) => w.seq > from && w.seq <= to && /^life/.test(w.key));
const MPEGURL = { 'Content-Type': 'application/vnd.apple.mpegurl' };
// X fails and its playlist answers the probe (at the third failure) with this body; the journal is complete in storage after it.
function probedWith(body, opts) {
  const app = watching(Object.assign({ channels: 10 }, opts || {}));
  const x = failingX(app);
  app.net.route((u) => u === x, () => Object.assign({ body, headers: MPEGURL }, (opts && opts.answer) || {}));
  app.advanceUntil(() => lifeLines(app).some((l) => /probe result/.test(l)), 20000, 10);
  return app;
}

// ---- R1: no credential reaches any journal line ----------------------------------------------------------------------
const PROBE_BODIES = [
  ['a relative URI with user, password and token (VERIFY-codex F1)', '#EXTM3U\nlive/probeUser/probePass/seg.ts?token=probeToken\n', 'live/…/…/seg.ts?…'],
  ['an absolute URI that crosses character 80 (VERIFY-codex F1, VERIFY-gemini 1)',
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttp://cdn.example.test/live/probeUser/probePass/77.m3u8?token=probeToken\n',
    'http://cdn.example.test/live/<user>/<pass>'],   // cleaned whole, then cut: never a fragment of the password
  ['a root-relative URI with a token (VERIFY-javascript-pro F1)', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n/live/probeUser/probePass/77.m3u8?token=probeToken',
    '/live/<user>/<pass>/77.m3u8?…'],
  ['a protocol-relative URI with user info', '#EXTM3U\n//probeUser:probePass@cdn.example.test/hls/77.m3u8?token=probeToken', '//cdn.example.test/…/77.m3u8?…'],
  ['a relative chunk with a token (VERIFY-debugger F3)', '#EXTM3U\nchunk.m3u8?token=probeToken', 'chunk.m3u8?…']
];
const PROBE_SECRETS = ['probeUser', 'probePass', 'probeToken'];
for (const [what, body, shown] of PROBE_BODIES) {
  test('R1: the probe journals ' + what + ' with no credential, in storage', () => {
    const app = probedWith(body);
    const line = lifeLines(app).find((l) => /probe result/.test(l));
    assert.ok(line && /probe result 200 application\/vnd\.apple\.mpegurl "#EXTM3U/.test(line), 'line: ' + line);
    assert.ok(line.indexOf(shown) >= 0, 'not shown as ' + shown + ': ' + line);
    const stored = storedLines(app);
    assert.ok(stored.some((l) => /probe result 200/.test(l)), 'the probe result is not in storage');
    const leaks = stored.filter((l) => PROBE_SECRETS.some((s) => l.indexOf(s) >= 0) || l.indexOf(f.FAKE_KEY) >= 0);
    assert.deepEqual(leaks, []);
  });
}

test('R1: provider / native failure text is journaled with its credentials masked and bounded', () => {
  const app = watching();
  app.av.emit('onerror', 'denied username=errUser password=errPass ' + 'x'.repeat(400));
  const line = storedLines(app).find((l) => /fail #1 denied/.test(l));
  assert.ok(line, 'the failure is not in storage');
  assert.ok(line.indexOf('errUser') < 0 && line.indexOf('errPass') < 0, line);
  assert.match(line, /username=… password=…/);
  assert.ok(line.length < 400, 'unbounded: ' + line.length);
});

test('R1: an Xtream short-form URL (/<user>/<pass>/<id>) is journaled without its user and password', () => {
  const app = f.m3uApp({ channels: 3, m3u: { streamUrl: (id) => 'http://iptv.example.test:8080/anastasia/fake123/' + id } });
  f.untilPlaying(app);
  app.setHidden(true); app.advance(100);                      // everything waiting is written
  const opens = storedLines(app).filter((l) => /open live /.test(l));
  assert.ok(opens.length >= 1 && opens.every((l) => /open live http:\/\/iptv\.example\.test:8080\/…\/…\/ch\d/.test(l)), opens.join(' | '));
  assert.deepEqual(storedLines(app).filter((l) => /anastasia|fake123/.test(l)), []);
});

test('R1: keys typed into a text field are journaled without their codes', () => {
  const app = watching();
  const input = app.document.getElementById('key-input');
  for (const k of [65, 66, 49]) app.press(k, 50, { target: input });
  app.press(KEYS.INFO, 50);                                   // outside a text field the code is kept
  app.advance(6000);
  const stored = storedLines(app);
  assert.equal(stored.filter((l) => /key \(text field\)/.test(l)).length, 3, 'the typed keys are not journaled');
  assert.deepEqual(stored.filter((l) => /key (65|66|49)\b/.test(l)), []);
  assert.ok(stored.some((l) => new RegExp('key ' + KEYS.INFO + '"$').test(l)), 'a key outside a text field lost its code');
});

test('R1: nothing secret survives into the next launch (lifeLogPrev) — OTT key, M3U user/password, probe tokens, typed keys', () => {
  const first = f.m3uApp({ channels: 3, storage: { fastSwitch: 'true' },
    m3u: { streamUrl: (id) => 'http://anastasia:fake123@iptv.example.test/live/anastasia/fake123/' + id + '.m3u8?username=anastasia&password=fake123' } });
  f.untilPlaying(first);
  first.advance(10000);
  const input = first.document.getElementById('key-input');
  for (const k of [65, 66, 49]) first.press(k, 50, { target: input });
  const x = f.lastOpenUrl(first);
  first.av.prepareFails = (u) => u === x;
  first.net.route((u) => u === x, () => ({ body: '#EXTM3U\nlive/probeUser/probePass/seg.ts?token=probeToken\n', headers: MPEGURL }));
  first.av.emit('onerror', 'denied username=errUser password=errPass');
  first.advanceUntil(() => lifeLines(first).some((l) => /probe result/.test(l)), 20000, 10);
  first.setHidden(true); first.advance(100);
  const second = createAppLike(Object.fromEntries(first.storage.raw));
  f.untilPlaying(second);
  const prev = second.storage.raw.get('lifeLogPrev');
  assert.ok(/probe result 200/.test(prev) && /fail #1 denied/.test(prev) && /key \(text field\)/.test(prev), 'the previous boot\'s lines are not kept');
  const SECRETS = ['anastasia', 'fake123', 'probeUser', 'probePass', 'probeToken', 'errUser', 'errPass'];
  const leaks = storedLines(second).filter((l) => SECRETS.some((s) => l.indexOf(s) >= 0) || /key (65|66|49)\b/.test(l));
  assert.deepEqual(leaks, []);
});

test('R1: a bare OTT key or a bare M3U user / password in provider text is scrubbed', () => {
  const ott = watching();
  ott.av.emit('onerror', 'key ' + f.FAKE_KEY + ' rejected');
  const ottLine = storedLines(ott).find((l) => /fail #1 key/.test(l));
  assert.ok(ottLine && ottLine.indexOf(f.FAKE_KEY) < 0 && /key <key> rejected/.test(ottLine), 'line: ' + ottLine);
  const m3u = f.m3uApp({ channels: 3, m3u: { streamUrl: (id) => 'http://anastasia:fake123@iptv.example.test/hls/' + id + '.m3u8' } });
  f.untilPlaying(m3u);
  m3u.av.emit('onerror', 'auth failed for anastasia fake123');
  const m3uLine = storedLines(m3u).find((l) => /fail #1 auth failed/.test(l));
  assert.ok(m3uLine && !/anastasia|fake123/.test(m3uLine) && /auth failed for <cred> <cred>/.test(m3uLine), 'line: ' + m3uLine);
});

// ---- R5: the probe keeps the answer of an HTTP error ---------------------------------------------------------------
test('R5: the probe of a playlist answered with HTTP 403 journals the status, type and the redacted body', () => {
  const app = probedWith('provider denied fixture /live/probeUser/probePass/77.m3u8?token=probeToken',
    { answer: { status: 403, headers: { 'Content-Type': 'text/plain' } } });
  const line = storedLines(app).find((l) => /probe result/.test(l));
  assert.ok(line, 'the probe result is not in storage');
  assert.match(line, /probe result 403 text\/plain HTTP 403 \\"provider denied fixture \/live\/<user>\/<pass>\/77\.m3u8\?…\\"/);
});

// ---- R2: the journal is off the key path --------------------------------------------------------------------------
test('R2: a zap writes nothing in its key task; its lines reach storage within 5 s (in front)', () => {
  const app = watching({ channels: 10 });
  const keySeq = app.seq();
  app.press(KEYS.RIGHT, 0);
  assert.deepEqual(lifeWritesBetween(app, keySeq, app.seq()).map((w) => w.key), [], 'journal writes in the key task');
  const url = f.lastOpenUrl(app);
  app.advance(5000);
  const stored = storedLines(app);
  assert.ok(stored.some((l) => new RegExp('key ' + KEYS.RIGHT + '"$').test(l)), 'the key is not in storage after 5 s');
  assert.ok(stored.some((l) => l.indexOf('open live') >= 0 && l.indexOf(f.streamIdOf(url) + '.m3u8') >= 0), 'the open is not in storage after 5 s');
  assert.ok(stored.some((l) => /av\.play ok/.test(l)), 'the AVPlay lines are not in storage after 5 s');
});

test('R2: behind the dashboard every line is written at once', () => {
  const app = watching();
  app.setHidden(true); app.advance(100);
  const seq = app.seq();
  send(app, 'play-behind');
  const inTask = lifeWritesBetween(app, seq, app.seq()).map((w) => w.value).join('\n');
  assert.ok(/open live/.test(inTask) && /av\.open ok/.test(inTask) && /control play-behind done/.test(inTask), 'not written at once: ' + inTask.slice(0, 300));
  const pSeq = app.seq();
  app.advance(1000);                                          // prepared, played: each line written as it happens
  assert.ok(lifeWritesBetween(app, pSeq, app.seq()).some((w) => /av\.play ok/.test(w.value)), 'av.play not written behind');
});

test('R2: a failure is written at once, with every line still waiting', () => {
  const app = watching();
  app.press(KEYS.INFO, 100);                                 // waits in memory
  const seq = app.seq();
  app.av.emit('onerror', 'PLAYER_ERROR_CONNECTION_FAILED');
  const inTask = lifeWritesBetween(app, seq, app.seq()).map((w) => w.value).join('\n');
  assert.match(inTask, /fail #1 PLAYER_ERROR_CONNECTION_FAILED/);
  assert.ok(new RegExp('key ' + KEYS.INFO).test(inTask), 'the waiting key line was not written with the failure');
});

test('R2: while the player fails, every line is written at once (the retry\'s AVPlay calls too)', () => {
  const app = watching();
  app.advance(20000);                                         // out of every window
  app.av.emit('onerror', 'PLAYER_ERROR_CONNECTION_FAILED');
  const seq = app.seq();
  app.advanceUntil(() => app.av.calledAfter('open', seq).length > 0, 5000, 5);
  const open = app.av.calledAfter('open', seq)[0];
  const upToOpen = lifeWritesBetween(app, seq, open.seq).map((w) => w.value).join('\n');
  assert.ok(/open live .*\(retry 1\)/.test(upToOpen) && /av\.close ok/.test(upToOpen) && / av\.open"$/m.test(upToOpen), 'not written at once: ' + upToOpen.slice(-300));
});

test('R2: for 10 s after coming to the front every line is written at once; later a zap writes nothing in its key task', () => {
  const app = watching({ channels: 10 });
  app.setHidden(true); app.advance(1000);
  app.setHidden(false); app.advance(3000);
  let keySeq = app.seq();
  app.press(KEYS.RIGHT, 0);
  const early = lifeWritesBetween(app, keySeq, app.seq()).map((w) => w.value).join('\n');
  assert.ok(new RegExp('key ' + KEYS.RIGHT).test(early) && /av\.open ok/.test(early), 'not written at once within 10 s of the front');
  app.advance(10000);
  keySeq = app.seq();
  app.press(KEYS.RIGHT, 0);
  assert.deepEqual(lifeWritesBetween(app, keySeq, app.seq()).map((w) => w.key), [], 'journal writes in the key task after the window');
});

test('R2: the exit writes the stop\'s AVPlay lines before exit()', () => {
  const app = watching();
  app.advance(20000);                                         // out of every window: lines wait in memory
  const seq = app.seq();
  app.press(KEYS.BACK, 500);
  app.press(KEYS.BACK, 0);
  const exit = exits(app, seq)[0];
  assert.ok(exit, 'no exit');
  const before = lifeWritesBetween(app, seq, exit.seq).map((w) => w.value).join('\n');
  assert.ok(/exit-js double-back/.test(before) && /av\.close ok/.test(before), 'not on record before exit(): ' + before.slice(-300));
});

// ---- R3: the D6 failure episode survives a lifecycle rebuild ---------------------------------------------------------
function failuresOf(app) { return lifeLines(app).filter((l) => / fail #/.test(l)).length; }
function hideAndShow(app) { app.setHidden(true); app.advance(1000); const seq = app.seq(); app.setHidden(false); return seq; }

test('R3: failures #1 and #2, a rebuild (the app hidden and back), then #3: the detour starts', () => {
  const app = watching({ channels: 10 });
  const x = failingX(app);
  app.advanceUntil(() => failuresOf(app) === 2, 10000, 10);
  const seq = hideAndShow(app);
  app.advanceUntil(() => opensAfter(app, seq).some((u) => u !== x), 10000, 10);
  const opens = opensAfter(app, seq);
  assert.equal(opens[0], x, 'the rebuild did not reopen X first');
  assert.ok(opens.length === 2 && opens[1] !== x, 'no detour at the third failure across the rebuild: ' + opens.join(' | '));
});

test('R3: a detour that was due but cancelled by the background runs at the next failure (not 20 later)', () => {
  const app = watching({ channels: 10 });
  const x = failingX(app);
  app.advanceUntil(() => failuresOf(app) === 3, 10000, 10);   // the detour waits in the retry slot
  const seq = hideAndShow(app);
  app.advanceUntil(() => opensAfter(app, seq).some((u) => u !== x), 10000, 10);
  const opens = opensAfter(app, seq);
  assert.ok(opens.length === 2 && opens[0] === x && opens[1] !== x, 'opens after the front: ' + opens.join(' | '));
});

test('R3: between detours the 20-failure budget survives a rebuild', () => {
  const app = watching({ channels: 10 });
  const seq = app.seq();
  const x = failingX(app);
  app.advanceUntil(() => lifeLines(app).some((l) => /detour result/.test(l)), 30000, 10);
  const fails = failuresOf(app);
  app.advanceUntil(() => failuresOf(app) === fails + 5, 120000, 10);
  hideAndShow(app);
  app.advance(900000);
  const opens = opensAfter(app, seq);
  const yAt = opens.map((u, i) => (u !== x ? i : -1)).filter((i) => i >= 0);
  assert.ok(yAt.length >= 2, 'detours: ' + yAt.length);
  assert.equal(yAt[1] - yAt[0] - 1, 20, 'X attempts between the detours across the rebuild: ' + (yAt[1] - yAt[0] - 1));
});

test('R3: a channel chosen by the viewer starts a new episode (its own 3 failures before a detour)', () => {
  const app = watching({ channels: 10 });
  failingX(app);
  app.av.prepareFails = () => true;
  app.advanceUntil(() => failuresOf(app) === 2, 10000, 10);
  const seq = app.seq();
  app.press(KEYS.RIGHT, 0);
  const z = f.lastOpenUrl(app);
  app.advanceUntil(() => opensAfter(app, seq).some((u) => u !== z), 20000, 10);
  const opens = opensAfter(app, seq);
  assert.equal(opens.findIndex((u) => u !== z), 3, 'opens after the choice: ' + opens.join(' | '));
});

// ---- R4: every AVPlay call goes through the journal --------------------------------------------------------------
test('R4: pause and resume are journaled AVPlay calls', () => {
  const app = watching();
  app.press(KEYS.PLAY_PAUSE, 1000);
  app.press(KEYS.PLAY_PAUSE, 1000);
  const lines = lifeLines(app);
  const p = lines.findIndex((l) => / av\.pause$/.test(l));
  assert.ok(p >= 0 && / av\.pause ok$/.test(lines[p + 1]), 'pause not journaled: ' + lines.slice(-8).join(' | '));
  assert.ok(lines.slice(p).some((l) => / av\.play ok$/.test(l)), 'the resume\'s play not journaled');
});

test('R4: a pause AVPlay refuses is journaled as an error, and the app carries on', () => {
  const app = watching({ platformThrows: ['webapis.avplay.pause'] });
  app.press(KEYS.PLAY_PAUSE, 1000);
  assert.ok(lifeLines(app).some((l) => / av\.pause error SecurityError$/.test(l)), 'the refused pause is not journaled');
  noErrors(app);
});

test('R4: the setup calls are journaled; one AVPlay refuses is journaled as an error and the stream still plays', () => {
  const app = watching({ platformThrows: ['webapis.avplay.setDisplayRect'] });
  const lines = lifeLines(app);
  for (const re of [/ av\.displayRect error SecurityError$/, / av\.displayMode ok$/, / av\.adaptive ok$/, / av\.bufferPlay ok$/,
    / av\.bufferResume ok$/, / av\.setListener ok$/]) assert.ok(lines.some((l) => re.test(l)), 'missing ' + re);
  assert.equal(app.av.state, 'PLAYING');
  noErrors(app);
});

// ---- R6: D2 healthy = established playback in front ---------------------------------------------------------------
test('R6: a zap while the previous channel is still preparing closes the player first', () => {
  const app = watching({ channels: 10 });
  app.av.prepareMs = 3000;
  app.press(KEYS.RIGHT, 500);                                // preparing, no first frame yet
  const seq = app.seq();
  app.press(KEYS.RIGHT, 1500);                               // the burst's open; the first is still preparing
  assert.ok(app.av.calledAfter('play', seq).length === 0, 'the first channel was no longer preparing');
  assert.deepEqual(teardownBeforeOpen(app, seq), ['stop', 'close', 'open']);
});

test('R6: a zap after the next channel buffered but before its first frame closes the player first', () => {
  const app = watching({ channels: 10 });
  app.av.stalled = true;                                      // prepared and playing, but no frame yet
  app.press(KEYS.RIGHT, 1500);
  app.av.emit('onbufferingcomplete');                         // buffering done, still no first frame
  assert.equal(ev(app, 'Playback.mode()'), 'live');
  const seq = app.seq();
  app.press(KEYS.RIGHT, 1500);
  assert.deepEqual(teardownBeforeOpen(app, seq), ['stop', 'close', 'open']);
});

test('R6: a zap while playing behind the dashboard closes the player first', () => {
  const app = watching({ channels: 10 });
  app.setHidden(true); app.advance(100);
  send(app, 'play-behind'); app.advance(5000);
  assert.equal(app.av.state, 'PLAYING');
  const seq = app.seq();
  app.press(KEYS.RIGHT, 100);
  assert.deepEqual(teardownBeforeOpen(app, seq), ['stop', 'close', 'open']);
});

// ==== Fix batch 3 (2026-11-05, the MUST-FIX of fix-verification 2: S1–S5) ==========================================
const STORED_DIAG = (app) => ['failLog', 'diag'].map((k) => k + '=' + (app.storage.raw.get(k) || ''));
const writesPerTask = (writes) => writes.reduce((m, w) => { m[w.task] = (m[w.task] || 0) + 1; return m; }, {});
const lineSeq = (l) => +/ #(\d+) /.exec(l)[1];

// ---- S1: the Xtream short form /<user>/<pass>/<id> never reaches storage (VERIFY2-codex R1, VERIFY2-debugger NB3) ------
const SHORT_FORM = (id) => 'http://iptv.example.test:8080/anastasia/fake123/' + id;
test('S1: an Xtream short-form URL\'s user and password reach no stored record — the journal, failLog, the AVPlay event note, the next launch', () => {
  const first = f.untilPlaying(f.m3uApp({ channels: 3, m3u: { streamUrl: SHORT_FORM } }));
  first.advance(20000);                                       // out of every window: lines wait in memory
  first.av.listener.onevent('PLAYER_MSG_HTTP_ERROR_CODE', SHORT_FORM('ch1') + ' 403');
  first.av.emit('onerror', 'auth failed for anastasia fake123');   // VERIFY2-codex's reproduction
  first.advance(40000);                                       // failLog and diag written (DIAG_FLUSH_MS)
  const failLine = storedLines(first).find((l) => /fail #1 auth failed/.test(l));
  assert.ok(failLine && /auth failed for <cred> <cred>/.test(failLine), 'journal: ' + failLine);
  const diag = STORED_DIAG(first);
  assert.ok(/#1 auth failed for <cred> <cred> http:\/\/iptv\.example\.test:8080\/…\/…\/ch1/.test(diag[0]), 'failLog: ' + diag[0]);
  assert.ok(/avEvent\.PLAYER_MSG_HTTP_ERROR_CODE.*http:\/\/iptv\.example\.test:8080\/…\/…\/ch1 403/.test(diag[1]), 'diag: ' + diag[1]);
  const leaks = (app) => storedLines(app).concat(STORED_DIAG(app)).filter((l) => /anastasia|fake123/.test(l));
  assert.deepEqual(leaks(first), []);
  const second = f.untilPlaying(createAppLike(Object.fromEntries(first.storage.raw)));
  const prev = second.storage.raw.get('lifeLogPrev');
  assert.ok(/fail #1 auth failed for <cred> <cred>/.test(prev), 'the previous boot\'s failure is not kept');
  assert.deepEqual(leaks(second), []);
});

// ---- S2: an AVPlay call that throws reaches storage at once (VERIFY2-codex R2) -------------------------------------
test('S2: an AVPlay call that throws (pause, a setup call) is in storage at once, with the lines waiting before it', () => {
  const app = watching({ platformThrows: ['webapis.avplay.pause'] });
  app.advance(20000);                                         // out of every window: routine lines wait in memory
  let seq = app.seq();
  app.press(KEYS.PLAY_PAUSE, 0);
  let inTask = lifeWritesBetween(app, seq, app.seq()).map((w) => w.value).join('\n');
  assert.match(inTask, / av\.pause error SecurityError/);
  assert.ok(new RegExp('key ' + KEYS.PLAY_PAUSE + '"').test(inTask) && / av\.pause"$/m.test(inTask), 'the lines before it were not written: ' + inTask);
  const zap = watching({ channels: 10, platformThrows: ['webapis.avplay.setDisplayRect'] });
  zap.advance(20000);
  seq = zap.seq();
  zap.press(KEYS.RIGHT, 0);
  inTask = lifeWritesBetween(zap, seq, zap.seq()).map((w) => w.value).join('\n');
  assert.match(inTask, / av\.displayRect error SecurityError/);
  assert.match(inTask, /open live /);
});

// ---- S3: the coalesced flush is bounded (VERIFY2-javascript-pro V2-1) -----------------------------------------------
test('S3: after a burst of 10 zaps no task writes more than 20 journal records, and every line is in storage within 5 s', () => {
  const app = watching({ channels: 30 });
  app.advance(20000);                                         // out of every window
  const seq = app.seq();
  for (let i = 0; i < 10; i++) app.press(KEYS.RIGHT, 400);
  const burst = Array.from(lifeLines(app));            // the app's realm → this one, for deepEqual
  app.advance(5050);
  const perTask = writesPerTask(lifeWritesBetween(app, seq, app.seq()));
  assert.ok(Object.keys(perTask).length > 0, 'nothing was written');
  const worst = Math.max.apply(null, Object.values(perTask));
  assert.ok(worst <= 20, 'journal writes in one task: ' + worst + ' ' + JSON.stringify(perTask));
  const stored = new Map(STORED_LIFE(app).filter(([k]) => /^lifeLog\.\d+$/.test(k)).map(([k, v]) => [k, JSON.parse(v)]));
  const missing = burst.filter((l) => { const s = stored.get('lifeLog.' + (lineSeq(l) % 200)); return !s || lineSeq(s) < lineSeq(l); });
  assert.deepEqual(missing, []);
});

// ---- S4: a resume that plays live keeps the failure episode (VERIFY2-javascript-pro V2-2) -------------------------
test('S4: failures #1 and #2, a pause, Home, back and a resume within 2 min (it plays live), then #3: the detour starts', () => {
  const app = watching({ channels: 10 });
  const x = failingX(app);
  app.advanceUntil(() => failuresOf(app) === 2, 10000, 10);
  app.press(KEYS.PLAY_PAUSE, 500);
  assert.equal(ev(app, 'Playback.mode()'), 'paused');
  app.setHidden(true); app.advance(1000);                    // Home: the pipeline is released
  app.setHidden(false); app.advance(2000);                   // back: still paused
  const seq = app.seq();
  app.press(KEYS.PLAY_PAUSE, 0);                             // the resume snaps to live (goLive → live)
  assert.equal(ev(app, 'Playback.mode()'), 'live');
  app.advanceUntil(() => opensAfter(app, seq).some((u) => u !== x), 20000, 10);
  const opens = opensAfter(app, seq);
  assert.equal(opens[0], x, 'the resume did not reopen X first');
  assert.ok(opens.length === 2 && opens[1] !== x, 'no detour at the third failure across the resume: ' + opens.join(' | '));
});

// ---- S5: a rebuild always closes, pinned at the decision (VERIFY2-javascript-pro V2-3, VERIFY2-debugger NB2) --------
test('S5: Player.open({ rebuild: true }) called from established playback in front closes the player first (never the fast switch)', () => {
  const app = watching({ channels: 10 });
  assert.equal(app.av.state, 'PLAYING');
  const seq = app.seq();
  ev(app, 'Player.open({ url: ' + JSON.stringify(f.lastOpenUrl(app)) + ', archive: false, rebuild: true })');
  assert.deepEqual(teardownBeforeOpen(app, seq), ['stop', 'close', 'open']);
});

// ==== Fix batch 4 (2026-11-05, the MUST-FIX of fix-verification 3: T1) ==========================================
// ---- T1: the short form learns no known word and no ordinary HLS path segment (VERIFY3-debugger S1-R, VERIFY3-javascript-pro J1c)
const HLS_PATHS = [
  ['…/hls/live/<id>.m3u8 (VERIFY3-javascript-pro J1c)', (id) => 'http://cdn.example.test/hls/live/' + id + '.m3u8', /\/…\/live\/ch\d\.m3u8/],
  ['…/<id>x/live/index.m3u8 (VERIFY3-debugger)', (id) => 'http://cdn.example.test/' + id + 'x/live/index.m3u8', /\/…\/live\/index\.m3u8/],
  ['…/live/<id>x/index.m3u8 (the known word first)', (id) => 'http://cdn.example.test/live/' + id + 'x/index.m3u8', /\/live\/…\/index\.m3u8/],
];
for (const [name, streamUrl, path] of HLS_PATHS) {
  test('T1: a channel at ' + name + ' keeps "open live", "first frame live" and "front live" in storage, no <cred>', () => {
    const app = f.untilPlaying(f.m3uApp({ channels: 3, m3u: { streamUrl } }));
    app.advance(6000);                                        // one alive record
    const lines = storedLines(app);
    const opens = lines.filter((l) => /open live http:\/\/cdn\.example\.test\//.test(l));
    assert.ok(opens.length >= 1 && opens.every((l) => path.test(l)), 'opens: ' + opens.join(' | '));
    assert.ok(lines.some((l) => /first frame live/.test(l)), 'no "first frame live" in storage');
    assert.match(app.storage.raw.get('lifeAlive') || '', /front live/);
    assert.deepEqual(lines.filter((l) => /<cred>/.test(l)), []);
  });
}
