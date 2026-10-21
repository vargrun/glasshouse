/**
 * test/test-home-daily-wallpaper.js - a picture of the day as Glasshouse
 * Home's wallpaper: each provider's answer read as the picture it names; two
 * slots, the wallpaper and a spare, so only the wallpaper and at most one
 * preview are ever kept; a new picture switched in only once downloaded and
 * checked; a preview applied without downloading again; nothing downloaded
 * while the provider still names the picture there; anything but a JPEG or
 * PNG refused.
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var daily = require('../server/lib/home-daily-wallpaper');
var toBuffer = require('../server/lib/util').toBuffer;

console.log('Running test-home-daily-wallpaper.js ...');

var dir = path.join(os.tmpdir(), 'tvweb-daily-' + process.pid);
var store = path.join(dir, 'home-wallpaper-daily');
function rmrf(p) {
  var st;
  try { st = fs.lstatSync(p); } catch (e) { return; }
  if (st.isDirectory()) {
    fs.readdirSync(p).forEach(function (f) { rmrf(path.join(p, f)); });
    fs.rmdirSync(p);
  } else fs.unlinkSync(p);
}
process.on('exit', function () { rmrf(dir); });

var JPEG = toBuffer([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
var PNG = toBuffer([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5, 6]);

// What each provider says now, as they answered on 20 October 2026.
function bing(hash, base) {
  return { images: [{ startdate: '20261020', urlbase: base || '/th?id=OHR.BrownSloth_EN-US6816754257', hsh: hash || 'h1',
    title: 'Life in the slow lane', copyright: 'Brown-throated sloth, Puerto Viejo de Talamanca, Costa Rica (© Suzi Eszterhas/Minden Pictures)',
    copyrightlink: 'https://www.bing.com/search?q=International+Sloth+Day' }] };
}
function wikimedia() {
  var name = 'Gewone_fopzwam_%28Laccaria_laccata%29.jpg';
  return { image: { title: 'File:Gewone fopzwam (Laccaria laccata).jpg',
    image: { source: 'https://upload.wikimedia.org/wikipedia/commons/7/71/' + name, width: 4320, height: 3456 },
    thumbnail: { source: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/7/71/' + name + '/960px-' + name, width: 640, height: 512 },
    artist: { text: 'Famberhorst' }, description: { text: 'Laccaria laccata, <i>deceiver</i> mushroom' },
    file_page: 'https://commons.wikimedia.org/wiki/File:Gewone_fopzwam.jpg' } };
}

var answers = {}, asked = [], downloads = [], bodyFor = {}, failDownload = false;
function getJson(url, cb) {
  asked.push(url);
  var a = /bing\.com/.test(url) ? answers.bing : /wikipedia\.org/.test(url) ? answers.wikimedia : null;
  setTimeout(function () { if (a instanceof Error) cb(a); else cb(null, a); }, 1);
}
// Writes what the server would, a part of it where the download is cut short.
function download(url, out, opts, cb) {
  downloads.push(url);
  var body = bodyFor[url] || JPEG;
  fs.writeFileSync(out, failDownload ? body.slice(0, 3) : body);
  setTimeout(function () { cb(failDownload ? new Error('timed out') : null); }, 1);
}

var clock = Date.UTC(2026, 9, 20, 12, 0);
function fresh() {
  rmrf(dir);
  fs.mkdirSync(dir);
  answers = { bing: bing(), wikimedia: wikimedia() };
  asked = [];
  downloads = [];
  bodyFor = {};
  failDownload = false;
  daily.init({ stateDir: dir, getJson: getJson, download: download, now: function () { return clock; } });
}
// The pictures on disk, state.json aside.
function pictures() { return fs.readdirSync(store).filter(function (f) { return f !== 'state.json'; }).sort(); }

var steps = [];
function step(name, fn) { steps.push({ name: name, fn: fn }); }
function next() {
  var s = steps.shift();
  if (!s) { console.log('ALL test-home-daily-wallpaper.js assertions passed!\n'); return process.exit(0); }
  // After the step's last callback has returned, so a queue it ran from is done with.
  s.fn(function () { console.log('  ✓ ' + s.name); setImmediate(next); });
}

step('Bing\'s picture is its 1920 × 1080 size, with its title and credit', function (done) {
  fresh();
  daily.refresh('bing', function (err, meta, changed) {
    assert.ifError(err);
    assert.strictEqual(changed, true);
    assert.deepEqual(downloads, ['https://www.bing.com/th?id=OHR.BrownSloth_EN-US6816754257_1920x1080.jpg']);
    var d = daily.describe(daily.current());
    assert.strictEqual(d.title, 'Life in the slow lane');
    assert.ok(/Suzi Eszterhas/.test(d.credit));
    assert.strictEqual(d.provider, 'bing');
    assert.ok(!/\//.test(d.revision), 'a page is never given the file\'s path');
    var img = daily.image('current');
    assert.strictEqual(img.type, 'jpg');
    assert.ok(fs.readFileSync(img.file).equals(JPEG));
    assert.deepEqual(pictures(), ['wallpaper-a.jpg']);
    done();
  });
});

step('a new picture goes into the other slot, is switched in, and the old one is deleted; the same one downloads nothing', function (done) {
  fresh();
  daily.refresh('bing', function () {
    var first = daily.describe(daily.current()).revision;
    daily.refresh('bing', function (err, meta, changed) {
      assert.ifError(err);
      assert.strictEqual(changed, false);
      assert.strictEqual(downloads.length, 1, 'nothing downloaded again');
      answers.bing = bing('h2', '/th?id=OHR.Next');
      clock += 60 * 60 * 1000;
      daily.refresh('bing', function (err2, meta2, changed2) {
        assert.ifError(err2);
        assert.strictEqual(changed2, true);
        assert.strictEqual(downloads[1], 'https://www.bing.com/th?id=OHR.Next_1920x1080.jpg');
        assert.deepEqual(pictures(), ['wallpaper-b.jpg'], 'only the new picture is kept');
        assert.notStrictEqual(daily.describe(daily.current()).revision, first, 'the view sees a new revision');
        answers.bing = bing('h3', '/th?id=OHR.Third');
        clock += 60 * 60 * 1000;
        daily.refresh('bing', function () {
          assert.deepEqual(pictures(), ['wallpaper-a.jpg'], 'and back to the first slot');
          done();
        });
      });
    });
  });
});

step('a download cut short, or not a picture, leaves the wallpaper as it was', function (done) {
  fresh();
  daily.refresh('bing', function () {
    answers.bing = bing('h2', '/th?id=OHR.Html');
    bodyFor['https://www.bing.com/th?id=OHR.Html_1920x1080.jpg'] = toBuffer('<html>blocked</html>');
    daily.refresh('bing', function (err) {
      assert.ok(err && /JPEG or PNG/.test(err.message), err && err.message);
      assert.strictEqual(daily.current().id, 'bing-h1', 'the earlier picture stays');
      assert.ok(fs.readFileSync(daily.image('current').file).equals(JPEG));
      failDownload = true;
      daily.refresh('bing', function (err2) {
        assert.ok(err2 && /timed out/.test(err2.message));
        assert.strictEqual(daily.current().id, 'bing-h1');
        assert.deepEqual(pictures(), ['wallpaper-a.jpg'], 'no half-done file left');
        failDownload = false;
        answers.bing = bing('h4', '/th?id=OHR.Png');
        bodyFor['https://www.bing.com/th?id=OHR.Png_1920x1080.jpg'] = PNG;
        daily.refresh('bing', function (err3) {
          assert.ifError(err3);
          assert.strictEqual(daily.image('current').type, 'png', 'served as the PNG it is');
          assert.deepEqual(pictures(), ['wallpaper-b.png']);
          done();
        });
      });
    });
  });
});

step('a preview fills the spare slot, one at a time, and is switched in without downloading again', function (done) {
  fresh();
  daily.refresh('bing', function () {
    daily.preview('wikimedia', function (err, meta) {
      assert.ifError(err);
      assert.ok(/\/1920px-Gewone/.test(downloads[1]), 'a 1920-wide thumbnail of a wider original: ' + downloads[1]);
      assert.ok(/feed\/featured\/2026\/10\/20$/.test(asked[1]), 'today\'s, in UTC');
      assert.strictEqual(daily.describe(meta).title, 'Laccaria laccata, deceiver mushroom', 'markup taken out');
      assert.strictEqual(daily.describe(meta).credit, 'Famberhorst');
      assert.strictEqual(daily.current().provider, 'bing', 'a preview is not the wallpaper');
      assert.ok(daily.image('preview', 'wikimedia'));
      assert.strictEqual(daily.image('preview', 'bing'), null, 'only the provider previewed');
      assert.deepEqual(pictures(), ['wallpaper-a.jpg', 'wallpaper-b.jpg'], 'the wallpaper and one preview');
      daily.preview('wikimedia', function () {
        assert.strictEqual(downloads.length, 2, 'a second look reuses the preview');
        daily.preview('bing', function (e2, m2) {
          assert.strictEqual(m2.preview, false, 'the wallpaper\'s own provider shows the wallpaper');
          assert.strictEqual(downloads.length, 2);
          daily.refresh('wikimedia', function (e3, m3, changed) {
            assert.ifError(e3);
            assert.strictEqual(changed, true);
            assert.strictEqual(downloads.length, 2, 'applied without downloading again');
            assert.strictEqual(daily.current().provider, 'wikimedia');
            assert.deepEqual(pictures(), ['wallpaper-b.jpg'], 'the old wallpaper is deleted');
            assert.strictEqual(daily.image('preview', 'wikimedia'), null);
            done();
          });
        });
      });
    });
  });
});

step('fetches run one at a time, and an unknown provider is refused', function (done) {
  fresh();
  var got = 0;
  function both(err) {
    assert.ifError(err);
    if (++got < 2) return;
    assert.strictEqual(downloads.length, 1, 'the second found the first one\'s picture in place');
    assert.deepEqual(pictures(), ['wallpaper-a.jpg']);
    daily.refresh('flickr', function (err2) {
      assert.ok(err2);
      done();
    });
  }
  daily.refresh('bing', both);
  daily.refresh('bing', both);
});

next();
