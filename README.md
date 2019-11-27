# drachtio-fn-b2b-sugar

## :bell: :bell: Warning :bell: :bell:
drachtio-fn-b2b-sugar now gives reasons on cancellations. In order to support that you need to use a version of drachtip-srf above 4.4.21
If you try to use this module without using the correct version of drachtio-srf you will get rejected promises due to errors from within drachtio-srf

A selection of useful and reusable functions dealing with common [B2BUA](https://drachtio.org/api#srf-create-b2bua) scenarios for the [drachtio](https://drachtio.org) SIP server.

## simring function

A common need is to do a simultaneous ring of multiple SIP endpoints in response to an incoming call, connecting the caller to the first answering device and terminating the other requests.

This function provides a forking outdial B2BUA that connects the caller to the first endpoint that answers.

##### Basic usage
In basic usage, the exported `simring` function acts almost exactly like [Srf#createB2BUA](https://drachtio.org/api#srf-create-b2bua), except that you pass an array of sip URIs rather than a single sip URI.
```js
const {simring} = require('drachtio-fn-b2b-sugar');
srf.invite(async (req, res) {
  try {
    const {uas, uac} = await simring(req, res, ['sip:123@example.com', 'sip:456@example.com']);
    console.info(`successfully connected to ${uas.remote.uri}`);
  } catch (err) {
    console.log(err, 'Error connecting call');
  }
});
```
All of the options that you can pass to [Srf#createB2BUA](https://drachtio.org/api#srf-create-b2bua) can be passed to `simring`.

##### With logging
If you want logging from simring, you can treat the exported `simring` reference as a factory function that you invoke with a single argument, that being the logger object that you want to be used.  That object must provide 'debug', 'info', and 'error' functions (e.g. [pino](https://www.npmjs.com/package/pino)).

Invoking the factory function then returns another function that does the actual simring.
```js
const logger = require('pino')();
const {simring} = require('drachtio-fn-b2b-sugar');
const doSimring = simring(logger);
srf.invite(async (req, res) {
  try {
    const {uas, uac} = await doSimring(req, res, ['sip:123@example.com', 'sip:456@example.com']);
    console.info(`successfully connected to ${uas.remote.uri}`);
  } catch (err) {
    console.log(err, 'Error connecting call');
  }
});
```

##### Timouts values & Global vs individual leg timeouts

By default the timeout you can pass to `simring` is assigned to each outbound leg in the fork. The default value is `20` seconds. You may want to change this so that it's a global timeout rather than individual timeouts. You can pass in `globalTimeout` within the `opts` object. You can also change the timeout value by setting `timeout` in that object too; it's set in seconds.

```js
const {simring} = require('drachtio-fn-b2b-sugar');
srf.invite(async (req, res) {
  try {
    const {uas, uac} = await simring(req, res, ['sip:123@example.com', 'sip:456@example.com'], {
      globalTimeout: true,
      timeout: 30
    });
    console.info(`successfully connected to ${uas.remote.uri}`);
  } catch (err) {
    console.log(err, 'Error connecting call');
  }
});
```

## Simring class
A more advanced usage is to to start a simring against a list of endpoints, and then later (before any have answered) add one or more new endpoints to the simring list.

This would be useful, for instance, in a scenario where you are ringing all of the registered devices for a user and while doing that a new device registers that you also want to include.

In this case, you would use the Simring class, which exports a `Simring#addUri` method to do just that.
```js
const logger = require('pino')();
const {Simring} = require('drachtio-fn-b2b-sugar');

srf.invite(async (req, res) {
  const simring = new Simring(req, res, ['sip:123@example.com', 'sip:456@example.com']);
  simring.start()
    .then(({uas, uc}) => {
      console.info(`successfully connected to ${uas.remote.uri}`);
    })
    .catch((err) => console.log(err, 'Error connecting call'));

  // assume we are alerted when a new device registers
  someEmitter.on('someRegisterEvent', () => {
    if (!simring.finished) simring.addUri('sip:789@example.com');
  });
```

##### Events

The Simring class emits two different events - `finalSuccess` and `failure`

###### finalSuccess

Emits the uri that was eventually successful. - `uri`

###### failure

Emits an object containing the error and the uri that failed - `{err, uri}`

##### Diasble the timeout and Promise rejection

You may want to disable simringer's ability to handle a timeout completely as well as decide when your simringer is indeed finished.
This might be the case if you have an active simringer but you want to add a URI later on. Without the ability to handle this decison yourself lets say you add a URI straight away and it fails (500 response), the simringer will see that as a failed simringer and reject the returned promise. But you're still within your timeout value within your app and you want to add another URI to the now failed simringer. The way to handle this is to take control of the timeout yourself by passing in a timeout value of `null` or `false`. In this case, you now need to cancel the Simring class yourself using the exported `Simring#cancel` method.

## transfer (REFER handler)

Handle REFER messasges in your B2B dialogs.

```js
const {transfer} = require('drachtio-fn-b2b-sugar');

const auth = (username) => {
  // Valid username can make REFER/transfers
  //if (username == 'goodGuy') {
  //  return true;
  //} else {
  //  return false;
  //}
}

const destLookUp = (username) => {
  // do lookup on username here
  // to get an IP address or domain
  // const ipAddress = someLook();
  // return ipAddress;
};

srf.invite(async (req, res) {
  try {
    const {uas, uac} = await srf.createB2BUA(req, res, destination, {localSdpB: req.body});
    uac.on('refer', async (req, res) => {
      const opts = {
        srf, // required
        req, // required
        res,  // required
        transferor: uac, // required
        // authLookup: referAuthLookup, // optional, unless auth is true
        // destinationLookUp: this.referDestinationLookup, // optional
      }
      const { transfereeDialog, transferTargetDialog } = await transfer(opts);
    });

    uas.on('refer', async (req, res) => {
      const opts = {
        srf, // required
        req, // required
        res,  // required
        transferor: uas, // required
        authLookup: auth, // optional, unless auth is true
        destinationLookUp: destLookUp, // optional
      }
      const { transfereeDialog, transferTargetDialog } = await transfer(opts);
    });
  } catch (error) {
    console.log(error);
  }
});
```

### Options

* authLookup: function - used to verify endpoint sending REFER is allowed to REFER calls in your environment
* destinationLookUp: function - used to determine what IP address (or domain) to use when calling the transferTarget (the person being transferred to). If not set, whatever is put in the `Refer-To` uri will be used

## forwardInDialogRequests

This function forwards in-dialog requests received on one Dialog in a B2B to the paired Dialog.  It does _not_ handle in-dialog INVITEs (e.g. re-INVITEs) or UPDATE requests, however, as these usually require application-specific processing.

The signature is: `forwardInDialogRequests(dlg, requestTypes)`, e.g.:
```
const {forwardInDialogRequests} = require('drachtio-fn-b2b-sugar');
const {uas, uac} = await srf.createB2BUA(..);
forwardInDialogRequests(uas, ['info', 'options', 'notify']);
```
The list of request types to forward is optional; if not specified all request types (except, as per above, INVITEs and UPDATEs) will for forwarded:
```
forwardInDialogRequests(uas); // forwards all requests (except INVITE and UPDATE)
```

Note that although you only provide one of the paired dialogs as an argument, in-dialog requests are forwarded in both directions (e.g. though you may specify 'uas', requests received on 'uac' are also forwarded to the uas).

Also note that you can still attach your own event listeners to the in-dialog requests (just don't try to forward the requests in your event handler, since that will already be taken care of).
 