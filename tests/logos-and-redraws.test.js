'use strict';
// Work the screen does not need (performance review 2026-10-27, P-2 P-4 P-8 P-9), without making anything less fresh
// (owner: «видеть актуальные списки каналов и групп … что реально идёт по каналам»):
//  - P-2: a logo is a picture download from a third-party host. Since DEC-2026-10-28-logos-ahead the zap group's logos
//    are loaded in the background before the menu opens, so a page flicked to is already there and costs no download;
//    the first opening and a single step after a pause show them at once. The names and «now» lines are never held back.
//  - P-4: a first channel that does not play still gets the menu laid out ahead (it was laid out only at a first frame).
//  - P-8: the banner does not load its logo again when it is redrawn for the same channel.
//  - P-9: one key in the programme panel reads the day's programmes once.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { KEYS } = require('./harness');
const f = require('./fixtures');

const ev = (app, js) => JSON.parse(vm.runInContext('JSON.stringify(' + js + ')', app.ctx));
const rows = (app) => app.document.getElementById('channels').children;
const writes = (app) => app.images.requests.length;   // picture downloads (the harness's image model), not src writes
// What is wrong with the logos of the visible rows: a page must be drawn (12 rows or more), each row a channel of the
// list (its number), showing that channel's name and its own logo, visible ([] when all is right; review 4, Codex 2:
// with no row drawn at all the old check found nothing wrong).
function wrongLogos(app) {
  const shown = rows(app).filter((r) => r.style.visibility !== 'hidden');
  if (shown.length < 12) return ['only ' + shown.length + ' rows drawn'];
  return shown.map((r) => {
    const num = r.children[0].textContent, c = ev(app, 'Channels.byNum(' + Number(num) + ')'), img = r.children[1];
    if (!c) return num + ': no such channel';
    if (r.children[2].textContent.indexOf(c.name) < 0) return num + ': shows «' + r.children[2].textContent + '», not ' + c.name;
    if (!c.logo || img.getAttribute('src') !== c.logo) return num + ': logo ' + img.getAttribute('src') + ', not ' + c.logo;
    return img.style.visibility === 'hidden' ? num + ': logo hidden' : null;
  }).filter(Boolean);
}

function menuApp() {
  const app = f.untilPlaying(f.ottApp({ channels: 200 }));
  app.advance(5000);
  return app;
}

test('logos (P-2): the menu\'s first opening shows the logos of its page at once', () => {
  const app = menuApp();
  app.press(KEYS.ENTER, 50);
  assert.ok(rows(app).length >= 12);
  assert.deepEqual(wrongLogos(app), []);
});

test('logos (P-2): CH− held through 10 pages over the zap group loaded in the background downloads (almost) nothing while flicking; every page shows its own logos — names and «now» lines at once (DEC-2026-10-28-logos-ahead)', () => {
  const app = menuApp();
  app.press(KEYS.ENTER, 3000);
  const w0 = writes(app);
  // Held: a key every 150 ms. The group was loaded in the background (the trickle), so the pages flicked to are there.
  for (let i = 0; i < 10; i++) app.press(KEYS.CH_DOWN, 150);
  const during = writes(app) - w0;
  const shown = app.rowsDetailed('channels');
  assert.ok(shown.length >= 12 && shown.every((r) => r.cells[2] && r.cells[3]), 'a name or a «now» line waited for the logos: ' + JSON.stringify(shown.slice(0, 3)));
  // A row shows its own channel's picture (loaded before) or an empty box — never the picture of the channel it showed before.
  assert.ok(rows(app).filter((r) => r.style.visibility !== 'hidden').every((r) => r.children[1].style.visibility === 'hidden' || !r.children[1].showing || r.children[1].showing === ev(app, 'Channels.byNum(' + Number(r.children[0].textContent) + ').logo')), 'an old logo shows beside a new channel');
  app.advance(ev(app, 'CONFIG.NOW_QUIET_MS') + 50);
  assert.deepEqual(wrongLogos(app), [], 'the page the cursor rests on has no logos');
  const after = writes(app) - w0;
  assert.ok(during <= 13, 'logos requested while flicking: ' + during);
  // DEC-2026-10-28-logos-ahead: the zap group (200 channels here) was loaded before; whatever remains is bounded by the window.
  assert.ok(after <= 39, 'logo requests for 10 pages: ' + after + ' (was one per row per page, 130)');
});

test('logos (P-2): a single step after a pause shows the new page\'s logos at once (no blank)', () => {
  const app = menuApp();
  app.press(KEYS.ENTER, 3000);
  app.press(KEYS.CH_DOWN, 50);
  assert.deepEqual(wrongLogos(app), []);
  app.press(KEYS.DOWN, 2000);
  app.press(KEYS.DOWN, 50);
  assert.deepEqual(wrongLogos(app), []);
});

test('menu (P-4): a first channel that does not play — the menu is laid out ahead from its 4th attempt («no signal»), never during the three silent retries (review 4, P4-2)', () => {
  const app = f.ottApp({ channels: 30 });
  app.av.prepareFails = true;                                   // nothing plays (the detour's channel neither, D6)
  const openCalls = () => app.av.calls.filter((c) => c.fn === 'open').length;
  app.advanceUntil(() => openCalls() > 0, 5000, 10);
  app.advance(150);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const n = openCalls();
    app.av.emit('onerror', 'PLAYER_ERROR_CONNECTION_FAILED');
    app.advance(50);
    assert.equal(rows(app).length, 0, 'the menu was laid out at the silent retry ' + attempt + ' (logos and layout beside the stream)');
    // the player opens the stream again; after the third failure the detour's channel first, then the stream (D6,
    // COMMON-DECISION player-behind 2026-11-05)
    app.advanceUntil(() => openCalls() > n + (attempt === 3 ? 1 : 0), 20000, 10);
    app.advance(150);
  }
  app.av.emit('onerror', 'PLAYER_ERROR_CONNECTION_FAILED');
  app.advance(50);
  assert.ok(!app.av.calls.some((c) => c.fn === 'play'), 'the channel played: this is not the case under test');
  assert.ok(app.visible('toast') && /Нет сигнала/.test(app.text('toast')), 'not the «no signal» point');
  assert.ok(rows(app).length >= 12, 'the menu was not laid out at «no signal»');
  assert.equal(app.visible('guide'), false, 'the menu opened by itself');
});

test('logos (P4-5): a menu closed while its logos wait requests none of them; opened again, it shows them', () => {
  const app = menuApp();
  app.press(KEYS.ENTER, 3000);
  // Pages flicked down and back to the first one: every row's logo waits for the cursor to rest, the first page's too.
  for (let i = 0; i < 4; i++) app.press(KEYS.CH_DOWN, 120);
  for (let i = 0; i < 4; i++) app.press(KEYS.CH_UP, 120);
  app.press(KEYS.BACK, 0);                                     // the menu closes with them waiting
  assert.equal(app.visible('guide'), false);
  const w0 = writes(app);
  app.advance(2000);
  assert.equal(writes(app) - w0, 0, 'logos requested for a closed menu');
  app.press(KEYS.ENTER, 50);                                   // opened again on that page: its logos at once
  assert.deepEqual(wrongLogos(app), []);
});

test('logos (P4-5): «📡 Провайдеры» (BLUE), «⚙ Настройки» or «🔍 Поиск» opened over the menu while its logos wait — none of them is requested; the menu opened again shows them (review 5, Codex 15)', () => {
  for (const [name, open] of [['providers', (app) => app.press(KEYS.BLUE, 0)], ['settings', (app) => vm.runInContext('Overlay.open("about")', app.ctx)],
    ['search', (app) => vm.runInContext('Overlay.open("search")', app.ctx)]]) {
    const app = menuApp();
    app.press(KEYS.ENTER, 3000);
    for (let i = 0; i < 4; i++) app.press(KEYS.CH_DOWN, 120);
    for (let i = 0; i < 4; i++) app.press(KEYS.CH_UP, 120);
    open(app);
    assert.equal(app.visible('guide'), false, name + ': the menu is still open');
    const w0 = writes(app);
    app.advance(2000);
    assert.equal(writes(app) - w0, 0, name + ': logos requested for the hidden menu');
    vm.runInContext('Overlay.close()', app.ctx);
    app.press(KEYS.ENTER, 50);
    assert.deepEqual(wrongLogos(app), [], name);
  }
});

test('banner (P-8): redrawn for the same channel, the banner does not load its logo again', () => {
  const app = menuApp();
  const logo = app.document.getElementById('b-logo');
  app.press(KEYS.INFO, 500);
  const n = logo.srcWrites || 0;
  for (let i = 0; i < 5; i++) app.press(KEYS.INFO, 500);
  assert.equal((logo.srcWrites || 0) - n, 0);
  app.press(KEYS.RIGHT, 3000);                                // another channel: its logo
  assert.equal(logo.getAttribute('src'), ev(app, 'Playback.current().logo'));
});

test('panel (P-9): one ▲ or ▼ reads the day\'s programmes once', () => {
  const app = menuApp();
  app.press(KEYS.DOWN, 1500);
  assert.ok(app.visible('prog'));
  vm.runInContext('var __days = 0, __day = EPG.day; EPG.day = function (a, b) { __days++; return __day(a, b); };', app.ctx);
  app.press(KEYS.DOWN, 50);
  app.press(KEYS.UP, 50);
  assert.equal(ev(app, '__days'), 2);
});
