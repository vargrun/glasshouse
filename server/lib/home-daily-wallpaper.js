/*
 * lib/home-daily-wallpaper.js - a picture of the day as Glasshouse Home's
 * wallpaper, in place of the uploaded ones (lib/home-wallpapers)
 *
 * Bing's and Wikimedia Commons' pictures of the day, which need no account.
 * The TV reads what the provider's picture is (lib/fetch: curl or wget, as
 * node 0.12 cannot speak their TLS), and downloads it only when it is not the
 * one it has.
 *
 * Two slots, a and b, blue-green: the wallpaper is one, and a new picture or a
 * preview goes into the other. Once it is downloaded and checked, state.json
 * names it the wallpaper and the old one is deleted, so only the wallpaper is
 * kept, with at most one preview beside it, and a fetch that fails or is cut
 * short never touches the wallpaper. A preview applied is the same switch.
 *
 * Strict ES5: runs on node 0.12.
 */
var fs = require('fs');
var path = require('path');
var allocBuffer = require('./util').allocBuffer;

var PROVIDERS = ['bing', 'wikimedia'];
var MAX_BYTES = 20 * 1024 * 1024;
// Pictures the size the view is drawn at; larger adds download and nothing on screen.
var WIDTH = 1920;

var dir = '/var/lib/tvweb/home-wallpaper-daily';
var getJsonFn = null, downloadFn = null;
var nowFn = Date.now;
// One fetch at a time: both write the slot that is not the wallpaper.
var queue = [], running = false;

function init(opts) {
  opts = opts || {};
  if (opts.stateDir) dir = path.join(opts.stateDir, 'home-wallpaper-daily');
  getJsonFn = opts.getJson || null;
  downloadFn = opts.download || null;
  nowFn = opts.now || Date.now;
  queue = [];
  running = false;
}

function validProvider(p) { return PROVIDERS.indexOf(p) !== -1 ? p : null; }

function text(v, max) {
  return typeof v === 'string' ? v.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, max || 300) : '';
}

function utcDate(ms) {
  var d = new Date(ms);
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  return d.getUTCFullYear() + '/' + pad(d.getUTCMonth() + 1) + '/' + pad(d.getUTCDate());
}

/*
 * Each provider's picture now: cb(error, { id, url, title, credit, link, date }).
 * id changes when the picture does, and is what the hourly check compares.
 */
var RESOLVE = {
  bing: function (cb) {
    getJsonFn('https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=en-US', function (err, doc) {
      var img = !err && doc && doc.images && doc.images[0];
      if (!img || typeof img.urlbase !== 'string' || img.urlbase.charAt(0) !== '/') {
        return cb(err || new Error('Bing gave no picture'));
      }
      cb(null, { id: 'bing-' + (img.hsh || img.urlbase), url: 'https://www.bing.com' + img.urlbase + '_1920x1080.jpg',
        title: text(img.title), credit: text(img.copyright), link: /^https:\/\//.test(img.copyrightlink || '') ? img.copyrightlink : '',
        date: text(img.startdate, 8) });
    });
  },
  // The day's Commons picture, from Wikipedia's featured feed, as a 1920-wide thumbnail where the original is wider.
  wikimedia: function (cb) {
    var day = utcDate(nowFn());
    getJsonFn('https://en.wikipedia.org/api/rest_v1/feed/featured/' + day, function (err, doc) {
      var img = !err && doc && doc.image;
      var thumb = img && img.thumbnail && img.thumbnail.source, orig = img && img.image;
      if (!img || typeof thumb !== 'string' || !orig || typeof orig.source !== 'string') {
        return cb(err || new Error('Wikimedia Commons gave no picture'));
      }
      var url = orig.width > WIDTH && /\/\d+px-/.test(thumb) ? thumb.replace(/\/\d+px-/, '/' + WIDTH + 'px-') : orig.source;
      cb(null, { id: 'wikimedia-' + day + '-' + text(img.title, 200), url: url,
        title: text(img.description && img.description.text) || text(img.title).replace(/^File:/, '').replace(/\.[a-z]+$/i, ''),
        credit: text(img.artist && img.artist.text, 120) || text(img.credit && img.credit.text, 120),
        link: typeof img.file_page === 'string' ? img.file_page : '', date: day.replace(/\//g, '') });
    });
  }
};

// ---------------------------------------------------------------- the two slots

function statePath() { return path.join(dir, 'state.json'); }
function slotFile(slot, type) { return path.join(dir, 'wallpaper-' + slot + '.' + type); }
function other(slot) { return slot === 'a' ? 'b' : 'a'; }
function unlinkQuiet(p) { try { fs.unlinkSync(p); } catch (e) {} }

/*
 * { active, slots: { a, b } }: active names the wallpaper's slot, or null
 * before the first; each slot's metadata, or null, with preview true while it
 * is not the wallpaper. A slot whose file is gone counts as empty.
 */
function readState() {
  var st = null;
  try { st = JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch (e) {}
  if (!st || typeof st !== 'object' || !st.slots) st = { active: null, slots: { a: null, b: null } };
  ['a', 'b'].forEach(function (s) {
    var m = st.slots[s];
    if (m && !fs.existsSync(slotFile(s, m.type))) st.slots[s] = null;
  });
  if (st.active !== 'a' && st.active !== 'b') st.active = null;
  if (st.active && !st.slots[st.active]) st.active = null;
  return st;
}

function writeState(st) {
  fs.writeFileSync(statePath() + '.part', JSON.stringify(st));
  fs.renameSync(statePath() + '.part', statePath());
}

// JPEG or PNG by its first bytes; anything else is not shown.
function imageType(file) {
  var fd, buf = allocBuffer(8);
  try {
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, 8, 0);
  } catch (e) { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (e2) {} }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  return null;
}

// The slot that is not the wallpaper.
function spare(st) { return st.active ? other(st.active) : 'a'; }

/*
 * The picture downloaded into the spare slot, as a preview: cb(err, state).
 * Its old file goes first, and its metadata is written only once the new one
 * is checked, so a slot never names a file it does not hold.
 */
function fill(st, provider, info, cb) {
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir); } catch (e) { return cb(e); }
  var slot = spare(st), part = path.join(dir, 'wallpaper-' + slot + '.part');
  var old = st.slots[slot];
  if (old) unlinkQuiet(slotFile(slot, old.type));
  st.slots[slot] = null;
  try { writeState(st); } catch (e) { return cb(e); }
  downloadFn(info.url, part, { expectedSize: null }, function (err) {
    var size = 0;
    try { size = fs.statSync(part).size; } catch (e) {}
    var type = !err && size && size <= MAX_BYTES ? imageType(part) : null;
    if (!type) {
      unlinkQuiet(part);
      return cb(err || new Error(size > MAX_BYTES ? 'the picture is larger than 20 MB' : 'not a JPEG or PNG picture'));
    }
    try {
      fs.renameSync(part, slotFile(slot, type));
      st.slots[slot] = { provider: provider, id: info.id, type: type, title: info.title, credit: info.credit,
        link: info.link, date: info.date, fetchedAt: nowFn(), preview: true };
      writeState(st);
      cb(null, st);
    } catch (e) { cb(e); }
  });
}

// The spare slot made the wallpaper, and the old wallpaper deleted.
function flip(st) {
  var slot = spare(st), was = st.active;
  st.slots[slot].preview = false;
  st.active = slot;
  if (was && st.slots[was]) {
    unlinkQuiet(slotFile(was, st.slots[was].type));
    st.slots[was] = null;
  }
  writeState(st);
  return st.slots[slot];
}

function same(m, provider, id) { return !!(m && m.provider === provider && m.id === id); }

// Fetches one after another; each reads the state afresh when its turn comes.
function serial(work, cb) {
  queue.push({ work: work, cb: cb });
  if (running) return;
  running = true;
  (function nextJob() {
    var job = queue.shift();
    if (!job) { running = false; return; }
    job.work(function () {
      var args = arguments;
      try { job.cb.apply(null, args); } finally { nextJob(); }
    });
  })();
}

/*
 * The provider's picture as a preview: cb(err, meta). The wallpaper itself
 * where it is that picture, and a preview already there is reused.
 */
function preview(provider, cb) {
  provider = validProvider(provider);
  if (!provider) return cb(new Error('unknown provider'));
  if (!getJsonFn || !downloadFn) return cb(new Error('daily wallpaper unavailable'));
  serial(function (done) {
    RESOLVE[provider](function (err, info) {
      if (err) return done(err);
      var st = readState();
      if (same(st.slots[st.active], provider, info.id)) return done(null, st.slots[st.active]);
      if (same(st.slots[spare(st)], provider, info.id)) return done(null, st.slots[spare(st)]);
      fill(st, provider, info, function (e2, st2) { done(e2, st2 && st2.slots[spare(st2)]); });
    });
  }, cb);
}

/*
 * The provider's picture as the wallpaper, if it is not the one there:
 * cb(err, meta, changed). A preview of it is switched in without downloading
 * again. Used when a provider is chosen and by the hourly check.
 */
function refresh(provider, cb) {
  provider = validProvider(provider);
  if (!provider) return cb(new Error('unknown provider'));
  if (!getJsonFn || !downloadFn) return cb(new Error('daily wallpaper unavailable'));
  serial(function (done) {
    RESOLVE[provider](function (err, info) {
      if (err) return done(err);
      var st = readState();
      if (same(st.slots[st.active], provider, info.id)) return done(null, st.slots[st.active], false);
      function switchIn(st2) {
        try { done(null, flip(st2), true); } catch (e) { done(e); }
      }
      if (same(st.slots[spare(st)], provider, info.id)) return switchIn(st);
      fill(st, provider, info, function (e2, st2) {
        if (e2) return done(e2);
        switchIn(st2);
      });
    });
  }, cb);
}

function current() {
  var st = readState();
  return st.active ? st.slots[st.active] : null;
}

// A picture's file, as the wallpaper or a provider's preview, for serving: { file, type } or null.
function image(kind, provider) {
  var st = readState();
  var slot = kind === 'preview' ? spare(st) : st.active;
  var m = slot && st.slots[slot];
  if (!m || (kind === 'preview' && (!m.preview || m.provider !== validProvider(provider)))) return null;
  return { file: slotFile(slot, m.type), type: m.type };
}

// What a page shows about a picture; never the file's path. revision changes with each picture.
function describe(m) {
  return m ? { provider: m.provider, title: m.title, credit: m.credit, link: m.link, date: m.date, fetchedAt: m.fetchedAt,
    revision: m.provider + '-' + m.fetchedAt } : null;
}

module.exports = {
  PROVIDERS: PROVIDERS,
  init: init,
  validProvider: validProvider,
  preview: preview,
  refresh: refresh,
  current: current,
  image: image,
  describe: describe
};
