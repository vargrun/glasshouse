/**
 * test/test-samrescan.js - sam is made to read its apps again by nudging
 * configd's blocked-app list, which is put back exactly as LG had it; without
 * the list (webOS 4) the caller is told to restart sam instead (#366). One app
 * is reread with a block and a release, the release always sent after a block
 * and tried again if refused. Where neither is there (webOS 6.5.3), restart()
 * restarts sam and opens the app that was in front again.
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var samrescan = require('../server/lib/samrescan');

console.log('Running test-samrescan.js ...');

var KEY = samrescan.KEY, NUDGE = samrescan.NUDGE_ID;

// A configd holding the list (or not), recording each list written to it.
function fakeTV(list, opts) {
  opts = opts || {};
  var tv = { list: list, writes: [], failWrites: opts.failWrites || 0,
             // sam's block and release: the calls made, in order, and whether
             // sam has the call at all (webOS 4 answers neither).
             samCalls: [], hasBlock: opts.hasBlock !== false, failReleases: opts.failReleases || 0,
             blockAnswerLost: !!opts.blockAnswerLost, blocked: {},
             front: opts.front || '', launched: [] };
  tv.luna = function (uri, payload, cb) {
    var r;
    if (uri === 'com.webos.applicationManager/blockSystemApp' || uri === 'com.webos.applicationManager/releaseBlockSystemApp') {
      var m = uri.split('/')[1];
      tv.samCalls.push(m + ' ' + payload.id);
      if (!tv.hasBlock) r = { returnValue: false, errorText: 'Unknown method' };
      else if (m === 'releaseBlockSystemApp' && tv.failReleases > 0) { tv.failReleases--; r = { returnValue: false }; }
      else {
        tv.blocked[payload.id] = m === 'blockSystemApp';
        // A block sam made but whose answer never came back, as when the call times out.
        r = m === 'blockSystemApp' && tv.blockAnswerLost ? null : { returnValue: true };
      }
    } else if (uri === 'com.webos.service.config/getConfigs') {
      var configs = {};
      if (tv.list) configs[KEY] = tv.list.slice();
      r = tv.list ? { returnValue: true, configs: configs } : { returnValue: true, configs: {}, missingConfigs: [KEY] };
    } else if (uri === 'com.webos.service.config/setConfigs') {
      if (tv.failWrites > 0 && tv.writes.length) { tv.failWrites--; r = { returnValue: false }; }
      else { tv.list = payload.configs[KEY].slice(); r = { returnValue: true }; }
      tv.writes.push(payload.configs[KEY].slice());
    } else if (uri === 'com.webos.applicationManager/getForegroundAppInfo') {
      r = { returnValue: true, appId: tv.front };
    } else if (uri === 'com.webos.applicationManager/launch') {
      tv.launched.push(payload.id);
      r = { returnValue: true };
    } else {
      r = { returnValue: true };
    }
    setTimeout(function () { cb(r); }, 1);
  };
  return tv;
}

// A failure inside a timer would otherwise hang the suite rather than fail it.
function checked(fn) {
  return function (arg) {
    try { fn(arg); } catch (e) {
      console.error('  ✗ ' + e.message);
      process.exit(1);
    }
  };
}

var steps = [];
function step(fn) { steps.push(fn); }
function next() { var f = steps.shift(); if (f) f(); else { console.log('ALL test-samrescan.js assertions passed!\n'); process.exit(0); } }

// 1. No list (webOS 4): nothing written, and the caller restarts sam.
step(function () {
  var tv = fakeTV(null);
  samrescan.init({ luna: tv.luna, nudgeMs: 5, pollMs: 5 });
  samrescan.refresh(null, checked(function (ok) {
    assert.strictEqual(ok, false);
    assert.strictEqual(tv.writes.length, 0, 'nothing written to configd');
    console.log('  ✓ without the list, nothing is written and the caller restarts sam');
    next();
  }));
});

// 2. LG's own entries are put back exactly, after the nudge id was added.
step(function () {
  var tv = fakeTV(['com.webos.app.roomconnect', 'netflix']);
  samrescan.init({ luna: tv.luna, nudgeMs: 5, pollMs: 5 });
  samrescan.refresh(null, checked(function (ok) {
    assert.strictEqual(ok, true);
    assert.deepEqual(tv.writes[0], ['com.webos.app.roomconnect', 'netflix', NUDGE]);
    assert.deepEqual(tv.list, ['com.webos.app.roomconnect', 'netflix']);
    console.log('  ✓ the nudge adds an id no app has, then puts LG\'s list back exactly');
    next();
  }));
});

// 3. A nudge id left by a run cut short is not kept as LG's.
step(function () {
  var tv = fakeTV(['netflix', NUDGE]);
  samrescan.init({ luna: tv.luna, nudgeMs: 5, pollMs: 5 });
  samrescan.refresh(null, checked(function () {
    assert.deepEqual(tv.list, ['netflix']);
    console.log('  ✓ a nudge id left behind is dropped, not put back');
    next();
  }));
});

// 4. Waits for sam to catch up, and gives up so the caller can restart it.
step(function () {
  var tv = fakeTV([]);
  samrescan.init({ luna: tv.luna, nudgeMs: 5, pollMs: 5 });
  var asked = 0;
  samrescan.refresh(function (done) { asked++; done(asked >= 3); }, checked(function (ok) {
    assert.strictEqual(ok, true);
    assert.strictEqual(asked, 3, 'asked until sam had it');
    samrescan.refresh(function (done) { done(false); }, checked(function (ok2) {
      assert.strictEqual(ok2, false, 'never caught up');
      assert.deepEqual(tv.list, [], 'the list is back even so');
      console.log('  ✓ it waits for sam to have the change, and gives up if it never does');
      next();
    }));
  }));
});

// 5. Two at once: the second does not read the list mid-nudge.
step(function () {
  var tv = fakeTV(['netflix']);
  samrescan.init({ luna: tv.luna, nudgeMs: 20, pollMs: 5 });
  var done = 0;
  function both() {
    if (++done < 2) return;
    tv.writes.forEach(function (w) {
      assert.ok(w.filter(function (id) { return id === NUDGE; }).length <= 1, 'one nudge id at most: ' + w);
    });
    assert.deepEqual(tv.list, ['netflix']);
    console.log('  ✓ nudges asked for together run one after another');
    next();
  }
  samrescan.refresh(null, checked(both));
  samrescan.refresh(null, checked(both));
});

// 6. A failed restore is tried again.
step(function () {
  var tv = fakeTV(['netflix'], { failWrites: 1 });
  samrescan.init({ luna: tv.luna, nudgeMs: 5, pollMs: 5 });
  samrescan.refresh(null, checked(function (ok) {
    assert.strictEqual(ok, true);
    assert.deepEqual(tv.list, ['netflix']);
    console.log('  ✓ putting the list back is tried again if configd refuses it');
    next();
  }));
});

// 7. One app: a block then a release, nothing written to configd, and the
//    caller waits for sam to report the change.
step(function () {
  var tv = fakeTV([]);
  samrescan.init({ luna: tv.luna, nudgeMs: 5, pollMs: 5 });
  var asked = 0;
  samrescan.rereadApp('com.webos.app.screensaver', function (done) { asked++; done(asked >= 2); }, checked(function (ok) {
    assert.strictEqual(ok, true);
    assert.deepEqual(tv.samCalls, ['blockSystemApp com.webos.app.screensaver', 'releaseBlockSystemApp com.webos.app.screensaver']);
    assert.strictEqual(tv.blocked['com.webos.app.screensaver'], false, 'released');
    assert.strictEqual(tv.writes.length, 0, 'the configd list is not touched');
    assert.strictEqual(asked, 2, 'asked until sam had it');
    console.log('  ✓ one app is reread with a block then a release, and the change waited for');
    next();
  }));
});

// 8. sam without the call (webOS 4): the block is refused, one release goes out
//    quietly in case it was not, and the caller falls back.
step(function () {
  var tv = fakeTV(null, { hasBlock: false });
  samrescan.init({ luna: tv.luna, nudgeMs: 5, pollMs: 5 });
  samrescan.rereadApp('com.webos.app.screensaver', null, checked(function (ok) {
    assert.strictEqual(ok, false);
    assert.deepEqual(tv.samCalls, ['blockSystemApp com.webos.app.screensaver', 'releaseBlockSystemApp com.webos.app.screensaver']);
    console.log('  ✓ where sam has no block call the caller falls back, after one release');
    next();
  }));
});

// 8b. A block sam made whose answer was lost is released all the same.
step(function () {
  var tv = fakeTV([], { blockAnswerLost: true });
  samrescan.init({ luna: tv.luna, nudgeMs: 5, pollMs: 5 });
  samrescan.rereadApp('com.webos.app.screensaver', null, checked(function (ok) {
    assert.strictEqual(ok, false, 'the caller falls back');
    assert.strictEqual(tv.blocked['com.webos.app.screensaver'], false, 'not left blocked');
    console.log('  ✓ a block whose answer was lost is released all the same');
    next();
  }));
});

// 9. A refused release is tried again, so the app is not left blocked.
step(function () {
  var tv = fakeTV([], { failReleases: 2 });
  samrescan.init({ luna: tv.luna, nudgeMs: 5, pollMs: 5 });
  samrescan.rereadApp('com.webos.app.screensaver', null, checked(function (ok) {
    assert.strictEqual(ok, true);
    assert.strictEqual(tv.samCalls.length, 4, 'one block, three releases');
    assert.strictEqual(tv.blocked['com.webos.app.screensaver'], false, 'released in the end');
    console.log('  ✓ a refused release is tried again until the app is unblocked');
    next();
  }));
});

// 10. sam never reports the change: released even so, and the caller falls back.
step(function () {
  var tv = fakeTV([]);
  samrescan.init({ luna: tv.luna, nudgeMs: 5, pollMs: 5 });
  samrescan.rereadApp('com.webos.app.screensaver', function (done) { done(false); }, checked(function (ok) {
    assert.strictEqual(ok, false);
    assert.strictEqual(tv.blocked['com.webos.app.screensaver'], false, 'not left blocked');
    console.log('  ✓ if sam never reports the change the app is still released and the caller falls back');
    next();
  }));
});

// 11. A restart: sam killed with the start limits cleared, the refused units
// that require it started again, and the app in front opened again once sam
// reports the change; nothing opened again over Home.
step(function () {
  var tv = fakeTV(null, { front: 'com.webos.app.hdmi2' });
  var commands = [];
  function exec(file, args, opts, cb) {
    commands.push(args[1]);
    setTimeout(function () { cb(null, commands.length === 2 ? 'eim.service\n' : ''); }, 1);
  }
  samrescan.init({ luna: tv.luna, pollMs: 5, exec: exec, restartSettleMs: 1 });
  var polls = 0;
  samrescan.restart(function (done) { done(++polls >= 3); }, checked(function (ok) {
    assert.strictEqual(ok, true);
    assert.strictEqual(commands.length, 2);
    assert.ok(/systemctl reset-failed sam\.service/.test(commands[0]) && /systemctl kill -s 9 sam\.service/.test(commands[0]));
    assert.ok(/systemctl is-failed --quiet/.test(commands[1]) && /systemctl start --no-block/.test(commands[1]));
    assert.strictEqual(polls, 3, 'waited for sam to report the change');
    assert.deepEqual(tv.launched, ['com.webos.app.hdmi2'], 'the input in front is opened again');
    var home = fakeTV(null, { front: 'com.webos.app.home' });
    samrescan.init({ luna: home.luna, pollMs: 5, exec: exec, restartSettleMs: 1 });
    samrescan.restart(null, checked(function (ok2) {
      assert.strictEqual(ok2, true);
      assert.deepEqual(home.launched, [], 'Home is left to sam');
      console.log('  ✓ a restart clears the start limits, starts refused units again and reopens the app in front');
      next();
    }));
  }));
});

next();
