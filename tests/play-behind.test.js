'use strict';
// Playing behind the Home Dashboard (owner, 2026-10-30: «когда запускаешь дэшборд то музыка от плеера играла в бэкграунде»,
// «только для дешборда он не заканчивал играть — для остальных заканчивал»). The dashboard sends 'play-behind' to the
// player's message port 'kinozal.control' when it comes to the front and 'stop-behind' when it goes away; any other app
// in front still stops the player. js/remote-control.js, js/playback.js playBehind / stopBehind.
// AVPlay playing while the app is hidden is unverified on the 2017 TV (UE50MU7000) until the owner's TV run.
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
const opensAfter = (app, seq) => app.av.calledAfter('open', seq).length;
function watching(opts) { const app = f.untilPlaying(f.ottApp(opts)); app.advance(10000); return app; }
// Another app comes to the front: the player is released (D1, COMMON-DECISION player-behind 2026-11-05: stop + close, never
// AVPlay's suspend()).
function hide(app) { app.setHidden(true); app.advance(1000); }
const released = (app, seq) => app.av.calledAfter('close', seq).length;
function noErrors(app) { assert.deepEqual(app.errors.map((e) => e.label + ': ' + e.error), []); }

test('play-behind: a live channel suspended by the dashboard plays on behind it, the same channel', () => {
  const app = watching();
  const liveUrl = f.lastOpenUrl(app);
  const hideSeq = app.seq();
  hide(app);
  assert.equal(released(app, hideSeq), 1, 'the player was not released in the background');
  assert.equal(app.av.calledAfter('suspend', hideSeq).length, 0, 'AVPlay suspend() was called (D1)');
  const seq = app.seq();
  send(app, 'play-behind');
  app.advance(3000);
  assert.equal(opensAfter(app, seq), 1, 'the stream was not reopened behind the dashboard');
  assert.equal(f.lastOpenUrl(app), liveUrl);
  assert.equal(app.av.state, 'PLAYING');
  assert.equal(ev(app, 'Playback.mode()'), 'live');
  assert.equal(ev(app, 'Diag.snapshot().notes.control'), 'play-behind done');
  noErrors(app);
});

test('play-behind: an archive recording plays on behind the dashboard from where it was left', () => {
  const app = f.untilPlaying(f.ottApp({ guideLatency: 10 }));
  app.advance(2000);
  app.press(KEYS.DOWN, 50);
  app.press(KEYS.UP, 50);
  app.press(KEYS.ENTER, 0);
  app.advanceUntil(() => app.av.state === 'PLAYING' && f.archiveStartOf(app.av.url) !== null, 5000, 10);
  app.advance(60000);
  const shown = f.shownArchiveMs(app);
  assert.ok(shown !== null, 'the archive did not start');
  hide(app);
  const seq = app.seq();
  send(app, 'play-behind');
  app.advance(3000);
  assert.equal(opensAfter(app, seq), 1);
  assert.equal(ev(app, 'Playback.mode()'), 'archive');
  const resumedAt = f.archiveStartOf(f.lastOpenUrl(app));
  assert.ok(Math.abs(resumedAt - shown) <= 10000, 'resumed ' + (resumedAt - shown) / 1000 + ' s away from the moment left');
  noErrors(app);
});

test('play-behind: a paused stream stays paused behind the dashboard', () => {
  const app = watching();
  app.press(KEYS.PLAY_PAUSE, 0);
  assert.equal(ev(app, 'Playback.mode()'), 'paused');
  hide(app);
  const seq = app.seq();
  send(app, 'play-behind');
  app.advance(5000);
  assert.equal(opensAfter(app, seq), 0, 'a paused stream was opened behind the dashboard');
  assert.equal(app.av.calledAfter('play', seq).length, 0);
  assert.equal(ev(app, 'Playback.mode()'), 'paused');
  assert.equal(ev(app, 'Diag.snapshot().notes.control'), 'play-behind ignored');
});

test('play-behind: nothing playing (the list server down, no copy) → nothing opens', () => {
  const app = f.ottApp({ listDown: true });
  app.advance(3000);
  assert.equal(ev(app, 'Playback.mode()'), 'idle');
  hide(app);
  const seq = app.seq();
  send(app, 'play-behind');
  app.advance(3000);
  assert.equal(opensAfter(app, seq), 0);
  noErrors(app);
});

test('play-behind: the player in front (not suspended) → nothing reopens', () => {
  const app = watching();
  const seq = app.seq();
  send(app, 'play-behind');
  app.advance(3000);
  assert.equal(opensAfter(app, seq), 0, 'the playing stream was reopened');
  assert.equal(ev(app, 'Diag.snapshot().notes.control'), 'play-behind ignored');
});

test('play-behind: a second message while already playing behind does nothing (the dashboard sends it twice)', () => {
  const app = watching();
  hide(app);
  send(app, 'play-behind');
  app.advance(3000);
  const seq = app.seq();
  send(app, 'play-behind');
  app.advance(3000);
  assert.equal(opensAfter(app, seq), 0);
});

// D3 (COMMON-DECISION player-behind 2026-11-05) replaces «keeps playing — no second reopen»: the stream born behind is rebuilt
// once in front.
test('play-behind: the player brought back to the front rebuilds the stream once; a late stop-behind stops nothing', () => {
  const app = watching();
  hide(app);
  send(app, 'play-behind');
  app.advance(3000);
  const seq = app.seq();
  app.setHidden(false);
  app.advance(3000);
  assert.equal(opensAfter(app, seq), 1, 'the stream born behind was not rebuilt once on return');
  assert.equal(app.av.state, 'PLAYING');
  const lateSeq = app.seq();
  send(app, 'stop-behind');                             // the dashboard's late "gone" must not stop the player in front
  app.advance(1000);
  assert.equal(released(app, lateSeq), 0, 'the player in front was released by a late stop-behind');
});

test('stop-behind: the dashboard going away stops the player; back in front, it resumes as usual', () => {
  const app = watching();
  hide(app);
  send(app, 'play-behind');
  app.advance(3000);
  const stopSeq = app.seq();
  send(app, 'stop-behind');
  app.advance(1000);
  assert.equal(released(app, stopSeq), 1, 'the player was not released by stop-behind');
  assert.equal(ev(app, 'Diag.snapshot().notes.control'), 'stop-behind done');
  app.advance(30000);
  assert.equal(opensAfter(app, stopSeq), 0, 'something reopened the stream after stop-behind');
  const backSeq = app.seq();
  app.setHidden(false);
  app.advance(3000);
  assert.equal(opensAfter(app, backSeq), 1, 'the stream did not resume in front');
  assert.equal(app.av.state, 'PLAYING');
});

test('stop-behind: not playing behind (in front, or suspended by another app) → nothing changes', () => {
  const app = watching();
  let seq = app.seq();
  send(app, 'stop-behind');
  app.advance(1000);
  assert.equal(released(app, seq), 0, 'the player in front was released');
  assert.equal(ev(app, 'Diag.snapshot().notes.control'), 'stop-behind ignored');
  hide(app);
  seq = app.seq();
  send(app, 'stop-behind');
  app.setHidden(false);
  app.advance(3000);
  assert.equal(opensAfter(app, seq), 1, 'the normal return to the front was broken');
});

test('remote control: an unknown command is recorded and changes nothing', () => {
  const app = watching();
  hide(app);
  const seq = app.seq();
  app.message(PORT, [{ key: 'cmd', value: 'reboot' }]);
  app.message(PORT, null);
  app.advance(3000);
  assert.equal(opensAfter(app, seq), 0);
  assert.equal(ev(app, 'Diag.snapshot().notes.control'), '? unknown');
  noErrors(app);
});

test('remote control: no Tizen (desktop) → the app boots and plays, no error', () => {
  const app = f.ottApp({ boot: false });
  delete app.ctx.tizen;
  app.boot();
  f.untilPlaying(app);
  noErrors(app);
  assert.equal(ev(app, 'Diag.snapshot().notes["boot.control"]'), undefined);
});

test('remote control: a TV refusing the message port → boot carries on and plays, the refusal recorded', () => {
  const app = f.untilPlaying(f.ottApp({ platformThrows: ['tizen.messageport.requestLocalMessagePort'] }));
  noErrors(app);
  assert.equal(ev(app, 'Diag.snapshot().notes["boot.control"]'), 18);
});

// The package must let the hidden player run (scripts and AVPlay); without these the message never arrives.
test('config.xml: background support enabled, background category «media»', () => {
  const xml = fs.readFileSync(path.join(ROOT, 'config.xml'), 'utf8');
  assert.match(xml, /<tizen:setting\b[^>]*\bbackground-support="enable"/);
  assert.match(xml, /<tizen:background-category value="media"\/>/);
});
