const Srf = require('drachtio-srf');
const SipRequest = Srf.SipRequest;
const SipResponse = Srf.SipResponse;
const assert = require('assert');
const noop = () => {};
const noopLogger = {debug: noop, info: noop, error: console.error};
const CallManager = require('./lib/call-manager');
const ReferHandler = require ('./lib/refer-handler');

function simring(...args) {
  if (args.length === 1) {
    const logger = args[0];
    assert.ok(typeof logger.debug === 'function' &&
    typeof logger.info === 'function' &&
    typeof logger.error === 'function', 'invalid logger object: must provide [debug|info|error] functions');

    return function(req, res, uriList, opts, notifiers) {
      assert(req instanceof SipRequest);
      assert(res instanceof SipResponse);
      assert(Array.isArray(uriList));

      const manager = new CallManager({req, res, uriList, opts, notifiers, logger});
      return manager.simring();
    };
  }

  assert.ok(args.length >= 3 &&
    args[0] instanceof SipRequest &&
    args[1] instanceof SipResponse &&
    Array.isArray(args[2]), 'invalid simring arguments: usage: simring(req, res, uriArray..)');

  const opts = {
    req: args[0],
    res: args[1],
    uriList: args[2],
    opts: args[3] || {},
    notifiers: args[4] || {},
    logger: noopLogger
  };
  const manager = new CallManager(opts);
  return manager.simring();
}

function transfer(opts) {
  const referHandler = new ReferHandler(opts);
  return referHandler.transfer();
}

class Simring {
  constructor(req, res, uriList, opts, notifiers) {
    const callOpts = {
      req,
      res,
      uriList: typeof uriList == 'string' ? [uriList] : (uriList || []),
      opts: opts || {},
      notifiers: notifiers || {},
      logger: noopLogger
    } ;
    this.manager = new CallManager(callOpts);
  }

  set logger(logger) {
    this.manager.logger = logger;
  }

  get finished() {
    return this.manager.finished;
  }

  get started() {
    return this.manager.started;
  }

  start(anotherUriList) {
    return this.manager.simring(anotherUriList);
  }

  addUri(uri) {
    return this.manager.addUri(uri);
  }

}

module.exports = {simring, Simring, transfer};
