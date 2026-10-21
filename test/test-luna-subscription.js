/**
 * test/test-luna-subscription.js - a subscription whose service stops is
 * subscribed again.
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var child = require('child_process');
var EventEmitter = require('events').EventEmitter;

// Each spawned luna-send, which ends only when killed.
var spawned = [];
child.spawn = function (file, args) {
  var c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.args = args;
  c.killed = false;
  c.kill = function () {
    if (c.killed) return;
    c.killed = true;
    process.nextTick(function () { c.emit('close', null, 'SIGTERM'); });
  };
  spawned.push(c);
  return c;
};

var luna = require('../server/lib/luna');

console.log('Running test-luna-subscription.js ...');

function waitFor(cond, what, cb) {
  var until = Date.now() + 5000;
  (function poll() {
    if (cond()) return cb();
    if (Date.now() > until) {
      console.error('  ✗ timed out waiting for ' + what);
      process.exit(1);
    }
    setTimeout(poll, 10);
  })();
}

var messages = [];
var sub = new luna.Subscription('com.webos.applicationManager/getForegroundAppInfo', { subscribe: true }, null, {
  message: function (r) { messages.push(r); }
});
sub.start();

waitFor(function () { return spawned.length === 1; }, 'the first subscription', function () {
  spawned[0].stdout.emit('data', '{"appId":"com.webos.app.hdmi2","returnValue":true}\n');
  assert.strictEqual(spawned[0].killed, false, 'an answer leaves it running');
  spawned[0].stdout.emit('data', '{"serviceName":"com.webos.applicationManager","returnValue":false,' +
    '"errorCode":-1,"errorText":"com.webos.applicationManager is not running."}\n');
  assert.strictEqual(spawned[0].killed, true, 'ended once the service has stopped');
  assert.strictEqual(messages.length, 2, 'both replies reach the handler');
  waitFor(function () { return spawned.length === 2; }, 'the subscription again', function () {
    assert.deepEqual(spawned[1].args, spawned[0].args, 'the same subscription');
    spawned[1].stdout.emit('data', '{"errorText":"Unknown method","returnValue":false}\n');
    assert.strictEqual(spawned[1].killed, false, 'another refusal is left as it is');
    sub.stop();
    console.log('  ✓ a subscription whose service stops is subscribed again, and only then');
    console.log('ALL test-luna-subscription.js assertions passed!\n');
    process.exit(0);
  });
});
