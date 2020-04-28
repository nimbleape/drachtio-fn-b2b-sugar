const Emitter = require('events');
const assert = require('assert');
const merge = require('deepmerge');
const DEFAULT_TIMEOUT = 20;

class CallManager extends Emitter {
  constructor(opts) {
    super();

    this._logger = opts.logger;
    this.req = opts.req;
    this.res = opts.res;
    this.srf = this.req.srf;
    this.uriList = opts.uriList;
    this.callOpts = opts.opts || {};
    this.callOpts.localSdp = this.callOpts.localSdpB;
    this.notifiers = opts.notifiers || {};
    this.isEvolving = opts.isEvolving || false;
    this.waitingForResponseFromUrisCount = opts.totalEvolvingUrisCount || opts.uriList.length;

    //calls in progress: uri -> SipRequest
    this.cip = new Map();

    this.started = this.finished = false;
    this.callerGone = false;
    this.callAnswered = false;
    this.bridged = false;
    this.callTimeout = this.callOpts.timeout || DEFAULT_TIMEOUT;
    this.forward180 = true;

    if (!(this.callOpts.headers && this.callOpts.headers.from) && !this.callOpts.callingNumber) {
      this.callOpts.callingNumber = opts.req.callingNumber;
    }
    if (!(this.callOpts.headers && this.callOpts.headers.to) && !this.callOpts.calledNumber) {
      this.callOpts.calledNumber = opts.req.calledNumber;
    }

    this.req.on('cancel', (res) => {
      this._logger.info(`caller hung up, terminating ${this.cip.size} calls in progress`);
      this.callerGone = true;
      console.log('CANCEL RES IS', res);
      this.killCalls(null, res && res.has('Reason') ? res.get('Reason') : null);
    });

    // this is the Promise we resolve when the simring finally concludes
    this.extPromise = new Promise((resolve, reject) => {
      this.finalResolve = resolve;
      this.finalReject = reject;
    });
  }

  set logger(logger) {
    this._logger = logger;
  }

  simring(anotherUriList, callOpts) {
    assert.ok(!this.started, 'CallManager#simring has already been called');
    this.started = true;
    anotherUriList = anotherUriList || [];
    this.uriList.push(...anotherUriList);
    assert.ok(this.uriList.length > 0, 'CallManager#simring called without any sip uris');
    this._logger.debug(`starting simring to ${this.uriList}`);
    this.strategy = 'simring';

    if (this.waitingForResponseFromUrisCount === 0) {
      this.waitingForResponseFromUrisCount = this.uriList.length;
    }
    this._logger.debug(`waiting for responses from ${this.waitingForResponseFromUrisCount} dialogs`);

    const simrings = this.uriList.map((uri) => this._attemptOne(uri, callOpts));
    const p = this.intPromise = oneSuccess(simrings);

    // if more uris were added to the simring while in progress, this Promise is not the final one
    p
      .then((obj) => {
        if (p === this.intPromise) {
          this.finished = true;
          return this.finalResolve(obj);
        }
        return;
      })
      .catch((err) => {
        if (p === this.intPromise && !this.isEvolving) {
          this.finished = true;
          this.finalReject(err);
        }
      });

    return this.extPromise;
  }

  addUri(uri, callOpts) {
    assert.ok(this.started, 'CallManager#addUri should not be called until simring has started');
    const p = this.intPromise = oneSuccess([this.intPromise, this._attemptOne(uri, callOpts)]);
    p
      .then((obj) => {
        if (p === this.intPromise) {
          this.finished = true;
          return this.finalResolve(obj);
        }
        return;
      })
      .catch((err) => {
        if (p === this.intPromise && !this.isEvolving) {
          this.finished = true;
          this.finalReject(err);
        }
      });
  }

  _attemptOne(uri, callOpts = {}) {
    let timer = null;
    let uac, uas;

    let mergedCallOpts = merge(this.callOpts, callOpts);

    this._logger.debug(mergedCallOpts, `Sending call to ${uri} with callOpts`);

    // return a Promise that resolves to a {uac, uas} pair
    const p = this.srf.createUAC(uri, mergedCallOpts,
      {
        cbRequest: (err, reqSent) => {
          if (this.notifiers.cbRequest) this.notifiers.cbRequest(err, reqSent);
          this.cip.set(uri, reqSent);
          this._logger.debug(
            `CallManager#_attemptOne: launched call to ${reqSent.uri}; ${this.cip.size} calls in progress`);
        },
        cbProvisional: (response) => {
          if (this.notifiers.cbProvisional) this.notifiers.cbProvisional(response);
          if (this.strategy === 'hunt' && [180, 183].includes(response.status) && response.body) {
            // TODO: cut through audio on early media..
          }
          if (response.status === 180 && this.forward180) {
            // Got a ringing from a client; send a 180 upstream
            this._logger.debug({response}, 'Branch sent 180 - sending 180 upstream to keep them hopeful');
            this.res.send(180);
            this.forward180 = false;
          }
        }
      })
      .then((dlg) => {
        if (this.callAnswered) {
          dlg.destroy();
          this._logger.info(`race condition; hanging up call ${dlg.sip.callid} because another leg answered`);
          throw new this.srf.SipError(500);
        }
        this.callAnswered = true;
        uac = dlg;

        this.waitingForResponseFromUrisCount = 0;
        this.isEvolving = false;

        this.killCalls(uri);
        this.cip.delete(uri);
        if (timer) clearTimeout(timer);

        const sdpA = uac.remote.sdp;
        const localSdpA = this.callOpts.localSdpA;
        if (typeof localSdpA === 'string') return localSdpA;
        if (typeof localSdpA === 'function') return localSdpA(uac.remote.sdp, uac.res);
        return sdpA;
      })
      .then((sdpA) => {
        return this.srf.createUAS(this.req, this.res, {headers: this.copyUACHeadersToUAS(uac.res), localSdp: sdpA});
      })
      .then((dlg) => {
        uas = dlg;

        this.emit('finalSuccess');
        return {uas, uac};
      })
      .catch((err) => {
        this.emit('finalFailure');
        if (timer) clearTimeout(timer);

        this.waitingForResponseFromUrisCount = this.waitingForResponseFromUrisCount - 1;

        if (this.waitingForResponseFromUrisCount === 0) {
          this.isEvolving = false;
        }

        if (!this.callerGone) {
          this._logger.info({err}, `CallManager#attemptOne: call to ${uri} failed with ${err.status}`);
        }
        throw err;
      });

    timer = setTimeout(() => {
      if (this.cip.has(uri)) {
        this._logger.info(`CallManager#attemptOne: timeout on call to ${uri}; tearing down call`);
        const req = this.cip.get(uri);
        this.cip.delete(uri);
        req.cancel();
      }
    }, this.callTimeout * 1000);

    return p;
  }

  killCalls(spareMe, reason) {
    for (const arr of this.cip) {
      const uri = arr[0];
      const req = arr[1];

      if (spareMe === uri) {
        this._logger.info(`not killing call to ${uri} because we were asked to spare it`);
      }
      else {
        this._logger.info(`killing call to ${uri}`);

        if (!reason && this.callAnswered) {
          reason = 'SIP;cause=200;text="Call completed elsewhere"';
        }

        if (reason) {
          req.cancel({
            headers: {
              'Reason': reason
            }
          });
        } else {
          req.cancel();
        }
      }
    }
    this.cip.clear();
  }

  copyUACHeadersToUAS(uacRes) {
    this.callOpts.headers = {} ;
    if(this.callOpts.proxyResponseHeaders) {
      this.callOpts.proxyResponseHeaders.forEach((hdr) => {
        if (uacRes.has(hdr)) {
          this.callOpts[hdr] = uacRes.get(hdr) ;
        }
      });
    }

    // after copying headers from A to B, apply any specific requested headerss
    if (typeof this.callOpts.responseHeaders === 'function') {
      Object.assign(this.callOpts.headers, this.callOpts.opts.responseHeaders(uacRes, this.callOpts.headers));
    }
    else if (typeof this.callOpts.responseHeaders === 'object') {
      Object.assign(this.callOpts.headers, this.callOpts.responseHeaders);
    }
    Object.assign(this.callOpts.headers, this.callOpts.responseHeaders);
    return this.callOpts.headers ;
  }
}

module.exports = CallManager;

function oneSuccess(promises) {

  // tricky reverse usage of Promise.all to return when first Promise succeeds
  return Promise.all(promises.map((p) => {
    return p.then((val) => Promise.reject(val), (err) => Promise.resolve(err));
  }))
    .then(
      (errors) => Promise.reject(errors),
      (val) => Promise.resolve(val)
    );
}
