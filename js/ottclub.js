// OTT Club source: channel list, logos and guide from the public API; streams need the subscriber key.
//   GET <scheme>://<server>/api/channel_now   -> { "<id>": { ch_id, channel_name, img, rec, category{class,name}, name, time, time_to } }
//   GET <scheme>://<server>/api/channel/<id>  -> { epg_data: [{ name, descr, time, time_to }] }   (7 days back, 24 h ahead)
//   stream:  <scheme>://<server>/stream/<KEY>/<id>.m3u8   archive: ?archive=<start>&archive_end=<end>
var OttClub = (function () {
  var cachedKey = null;        // read from the device once per session; saveKey() updates it

  function base() { return CONFIG.OTT_SCHEME + '://' + CONFIG.OTT_SERVER; }

  // The key is entered once on the setup screen (or built in) and kept on the device.
  function key() {
    if (cachedKey === null) {
      var k = Util.load('ottKey');
      cachedKey = k || (CONFIG.OTT_KEY && CONFIG.OTT_KEY.indexOf('__') !== 0 ? CONFIG.OTT_KEY : '');
    }
    return cachedKey;
  }
  function enabled() { return !!key(); }
  function saveKey(k) { cachedKey = k; Util.save('ottKey', k); }

  // The key an OTT Club link carries (/stream/<key>/, ?key=, ottkey=, /playlist/<key>/); another
  // provider's link is a playlist and gives none, even when it holds a key of its own. A typed key is
  // used as typed (setup.js) and never passes through here.
  function extractKey(text) {
    var t = String(text).trim();
    var host = (/^https?:\/\/(?:[^\/?#@]*@)?([^\/?#:]+)/i.exec(t) || [])[1] || '';
    if (!/(^|\.)(myott|ottclub)\.[a-z]+$/i.test(host)) return '';
    var m = /\/stream\/([A-Za-z0-9]+)\//.exec(t) || /[?&](?:ott)?key=([A-Za-z0-9]+)/.exec(t) ||
            /\/(?:playlist|ottplayer|m3u)\/([A-Za-z0-9]{6,})/.exec(t);
    return m ? m[1] : '';
  }

  function sourceUrl() { return base() + '/api/channel_now'; }
  // The same list, past the provider's server cache (which serves the plain URL minutes old): a URL of its
  // own (to the second) makes the provider build it now. Slower (about 3 s against 0.3 s), so only for the
  // "now" refreshes (every one of them, DEC-2026-10-26-now-refresh-2).
  function freshUrl() { return sourceUrl() + '?t=' + Math.floor(Date.now() / 1000); }
  function streamUrl(id) { return base() + '/stream/' + key() + '/' + id + '.m3u8'; }

  // Text of /api/channel_now -> { channels, seeds, epgUrl: '' }; null when it is not a channel list.
  function parse(text) {
    var recs = records(text);
    return recs ? build(recs) : null;
  }

  // The valid channel records of a /api/channel_now answer, or null.
  function records(text) {
    var data;
    try { data = JSON.parse(text); } catch (e) { return null; }
    if (!data || typeof data !== 'object') return null;
    var recs = [], skipped = 0;
    for (var id in data) {
      var c = data[id];
      if (c && typeof c === 'object' && c.ch_id && typeof c.channel_name === 'string') recs.push(c);
      else skipped++;
    }
    if (skipped) Diag.note('list.skipped', skipped);
    return recs.length ? recs : null;
  }

  // The programme on air now for one record (the API gives no "next"), or null.
  function seedOf(rec) { return rec.name && rec.time ? [{ start: rec.time * 1000, stop: rec.time_to * 1000, title: rec.name }] : null; }

  // The same answer read for the "now" lines only (no channels built): dict id -> [programme], or null when
  // it names no programme at all (an unusable answer changes nothing).
  function seedsOf(text) {
    var recs = records(text), seeds = Util.dict(), n = 0;
    for (var i = 0; recs && i < recs.length; i++) { var s = seedOf(recs[i]); if (s) { seeds[recs[i].ch_id] = s; n++; } }
    return n ? seeds : null;
  }

  // Same order as the official app: Israeli channels first by the number in the name, then group rank,
  // the provider's sequence and server order. Sort keys are computed once per channel.
  function build(recs) {
    var k = key(), b = base(), pinCount = ORDER.PINNED.length;
    var rows = [];
    for (var i = 0; i < recs.length; i++) {
      var c = recs[i], group = c.category && c.category.name ? c.category.name : '';   // '': our «Без группы»
      var cc = Country.detect({ name: c.channel_name, groupId: group, id: c.ch_id }, c.name);
      var grp = ORDER.GROUPS.indexOf(group);
      rows.push({ c: c, group: group, cc: cc, pin: pinRank(cc), num: ORDER.nameNumber(c.channel_name),
        grp: grp < 0 ? ORDER.GROUPS.length : grp, seq: ORDER.SEQ[c.ch_id] || 100000, pos: i });
    }
    rows.sort(function (x, y) {
      if (x.pin !== y.pin) return x.pin - y.pin;
      if (x.pin < pinCount) return (x.num - y.num) || (x.pos - y.pos);
      return (x.grp - y.grp) || (x.seq - y.seq) || (x.pos - y.pos);
    });
    var channels = [], seeds = Util.dict();
    for (var j = 0; j < rows.length; j++) {
      var r = rows[j], rec = r.c, archive = rec.rec === '1';
      channels.push({
        key: 'ott:' + rec.ch_id, num: j + 1, id: String(rec.ch_id), name: rec.channel_name,
        nameLc: rec.channel_name.toLowerCase(), logo: rec.img ? b + '/images/' + rec.img : '', groupId: r.group, group: I18n.group(r.group),
        url: b + '/stream/' + k + '/' + rec.ch_id + '.m3u8', catchup: archive ? 'ottclub' : '', catchupSource: '',
        catchupDays: archive ? CONFIG.ARCHIVE_DAYS : 0, il: r.cc.il, ua: r.cc.ua, dead: false
      });
      var seed = seedOf(rec);
      if (seed) seeds[rec.ch_id] = seed;
    }
    return { channels: channels, seeds: seeds, epgUrl: '' };
  }

  // Pinned channels (Israel) open the list.
  function pinRank(cc) {
    for (var p = 0; p < ORDER.PINNED.length; p++) if (ORDER.PINNED[p].numbered && cc[ORDER.PINNED[p].flag]) return p;
    return ORDER.PINNED.length;
  }

  // Full guide of one channel, fetched only when the viewer looks at it. Descriptions are not kept.
  function guide(id, done) {
    return Net.get({ url: base() + '/api/channel/' + id, timeoutMs: CONFIG.GUIDE_TIMEOUT_MS }, function (err, text) {
      if (err) { done(err); return; }
      var d;
      try { d = JSON.parse(text).epg_data; } catch (e) { done('invalid'); return; }
      if (!(d instanceof Array)) { done('invalid'); return; }
      var out = [];
      for (var i = 0; i < d.length; i++) {
        var p = d[i];
        if (p && +p.time > 0 && +p.time_to > +p.time) out.push({ start: p.time * 1000, stop: p.time_to * 1000, title: String(p.name || '') });
      }
      if (out.length) done(null, out); else done('empty');
    });
  }

  return {
    enabled: enabled, key: key, extractKey: extractKey, saveKey: saveKey,
    sourceUrl: sourceUrl, freshUrl: freshUrl, streamUrl: streamUrl, parse: parse, seedsOf: seedsOf, guide: guide
  };
}());
