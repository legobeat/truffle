const debug = require("debug")("contract:execute");
const PromiEvent = require("./promievent");
const EventEmitter = require("events");
const utils = require("./utils");
const StatusError = require("./statuserror");
const Reason = require("./reason");
const handlers = require("./handlers");
const override = require("./override");
const reformat = require("./reformat");
const { formatters } = require("web3-core-helpers"); //used for reproducing web3's behavior

const execute = {
  // -----------------------------------  Helpers --------------------------------------------------
  /**
   * Retrieves gas estimate multiplied by the set gas multiplier for a `sendTransaction` call.
   * @param  {Object} params     `sendTransaction` parameters
   * @param  {Number} blockLimit  most recent network block.blockLimit
   * @return {Number}             gas estimate
   */
  getGasEstimate: function(params, blockLimit) {
    const constructor = this;
    const interfaceAdapter = this.interfaceAdapter;

    return new Promise(function(accept) {
      // Always prefer specified gas - this includes gas set by class_defaults
      if (params.gas) return accept(params.gas);
      if (!constructor.autoGas) return accept();

      interfaceAdapter
        .estimateGas(params)
        .then(gas => {
          const bestEstimate = utils.multiplyBigNumberByDecimal(
            utils.bigNumberify(gas),
            constructor.gasMultiplier
          );

          // Don't go over blockLimit
          const limit = utils.bigNumberify(blockLimit);
          bestEstimate.gte(limit)
            ? accept(limit.sub(1).toHexString())
            : accept(bestEstimate.toHexString());

          // We need to let txs that revert through.
          // Often that's exactly what you are testing.
        })
        .catch(() => accept());
    });
  },

  /**
   * Prepares simple wrapped calls by checking network and organizing the method inputs into
   * objects web3 can consume.
   * @param  {Object} constructor   TruffleContract constructor
   * @param  {Object} methodABI     Function ABI segment w/ inputs & outputs keys.
   * @param  {Array}  _arguments    Arguments passed to method invocation
   * @return {Promise}              Resolves object w/ tx params disambiguated from arguments
   */
  prepareCall: async function(constructor, methodABI, _arguments) {
    let args = Array.prototype.slice.call(_arguments);
    let params = utils.getTxParams.call(constructor, methodABI, args);

    args = utils.convertToEthersBN(args);

    if (constructor.ens && constructor.ens.enabled) {
      const { web3 } = constructor;
      const processedValues = await utils.ens.convertENSNames({
        ensSettings: constructor.ens,
        inputArgs: args,
        inputParams: params,
        methodABI,
        web3
      });
      args = processedValues.args;
      params = processedValues.params;
    }

    const network = await constructor.detectNetwork();
    return { args, params, network };
  },

  /**
   * Disambiguates between transaction parameter objects and BN / BigNumber objects
   * @param  {Any}  arg
   * @return {Boolean}
   */
  hasTxParams: function(arg) {
    return utils.is_object(arg) && !utils.is_big_number(arg);
  },

  /**
   * Parses function arguments to discover if the terminal argument specifies the `defaultBlock`
   * to execute a call at.
   * @param  {Array}  args      `arguments` that were passed to method
   * @param  {Any}    lastArg    terminal argument passed to method
   * @param  {Array}  inputs     ABI segment defining method arguments
   * @return {Boolean}           true if final argument is `defaultBlock`
   */
  hasDefaultBlock: function(args, lastArg, inputs) {
    const hasDefaultBlock =
      !execute.hasTxParams(lastArg) && args.length > inputs.length;
    const hasDefaultBlockWithParams =
      execute.hasTxParams(lastArg) && args.length - 1 > inputs.length;
    return hasDefaultBlock || hasDefaultBlockWithParams;
  },

  // -----------------------------------  Methods --------------------------------------------------

  /**
   * Executes method as .call and processes optional `defaultBlock` argument.
   * @param  {Function} fn         method
   * @param  {Object}   methodABI  Function ABI segment w/ inputs & outputs keys.
   * @return {Promise}             Return value of the call.
   */
  call: function(fn, methodABI, address) {
    const constructor = this;

    return function() {
      let defaultBlock = constructor.web3.eth.defaultBlock || "latest";
      const args = Array.prototype.slice.call(arguments);
      const lastArg = args[args.length - 1];
      const promiEvent = new PromiEvent();

      // Extract defaultBlock parameter
      if (execute.hasDefaultBlock(args, lastArg, methodABI.inputs)) {
        defaultBlock = args.pop();
      }

      execute
        .prepareCall(constructor, methodABI, args)
        .then(async ({ args, params }) => {
          let result;

          params.to = address;

          promiEvent.eventEmitter.emit("execute:call:method", {
            fn: fn,
            args: args,
            address: address,
            abi: methodABI,
            contract: constructor
          });

          result = await fn(...args).call(params, defaultBlock);
          result = reformat.numbers.call(
            constructor,
            result,
            methodABI.outputs
          );
          return promiEvent.resolve(result);
        })
        .catch(promiEvent.reject);

      return promiEvent.eventEmitter;
    };
  },

  /**
   * Executes method as .send
   * @param  {Function} fn         Method to invoke
   * @param  {Object}   methodABI  Function ABI segment w/ inputs & outputs keys.
   * @param  {String}   address    Deployed address of the targeted instance
   * @return {PromiEvent}          Resolves a transaction receipt (via the receipt handler)
   */
  send: function(fn, methodABI, address) {
    const constructor = this;
    const web3 = constructor.web3;

    return function() {
      let deferred;
      const promiEvent = new PromiEvent(
        false,
        constructor.debugger,
        constructor.debugSelectors
      );

      execute
        .prepareCall(constructor, methodABI, arguments)
        .then(async ({ args, params, network }) => {
          const context = {
            contract: constructor, // Can't name this field `constructor` or `_constructor`
            promiEvent: promiEvent,
            params: params
          };

          params.to = address;
          params.data = fn ? fn(...args).encodeABI() : params.data;

          promiEvent.eventEmitter.emit("execute:send:method", {
            fn,
            args,
            address,
            abi: methodABI,
            contract: constructor
          });

          try {
            params.gas = await execute.getGasEstimate.call(
              constructor,
              params,
              network.blockLimit
            );
          } catch (error) {
            promiEvent.reject(error);
            return;
          }

          deferred = execute.sendTransaction(web3, params, promiEvent, context); //the crazy things we do for stacktracing...
          deferred.catch(override.start.bind(constructor, context));
        })
        .catch(promiEvent.reject);

      return promiEvent.eventEmitter;
    };
  },

  /**
   * Deploys an instance
   * @param  {Object} constructorABI  Constructor ABI segment w/ inputs & outputs keys
   * @return {PromiEvent}             Resolves a TruffleContract instance
   */
  deploy: function(constructorABI) {
    const constructor = this;
    const web3 = constructor.web3;

    return function() {
      let deferred;
      const promiEvent = new PromiEvent(
        false,
        constructor.debugger,
        constructor.debugSelectors
      );

      execute
        .prepareCall(constructor, constructorABI, arguments)
        .then(async ({ args, params, network }) => {
          const { blockLimit } = network;

          utils.checkLibraries.apply(constructor);

          // Promievent and flag that allows instance to resolve (rather than just receipt)
          const context = {
            contract: constructor,
            promiEvent,
            onlyEmitReceipt: true
          };

          const options = {
            data: constructor.binary,
            arguments: args
          };

          const contract = new web3.eth.Contract(constructor.abi);
          params.data = contract.deploy(options).encodeABI();

          params.gas = await execute.getGasEstimate.call(
            constructor,
            params,
            blockLimit
          );

          context.params = params;

          promiEvent.eventEmitter.emit("execute:deploy:method", {
            args,
            abi: constructorABI,
            contract: constructor
          });

          deferred = execute.sendTransaction(web3, params, promiEvent, context); //the crazy things we do for stacktracing...

          try {
            const receipt = await deferred;
            if (receipt.status !== undefined && !receipt.status) {
              const reason = await Reason.get(params, web3);

              const error = new StatusError(
                params,
                context.transactionHash,
                receipt,
                reason
              );

              return context.promiEvent.reject(error);
            }

            const web3Instance = new web3.eth.Contract(
              constructor.abi,
              receipt.contractAddress
            );
            web3Instance.transactionHash = context.transactionHash;

            context.promiEvent.resolve(new constructor(web3Instance));
          } catch (web3Error) {
            // Manage web3's 50 blocks' timeout error.
            // Web3's own subscriptions go dead here.
            await override.start.call(constructor, context, web3Error);
          }
        })
        .catch(promiEvent.reject);

      return promiEvent.eventEmitter;
    };
  },

  /**
   * Begins listening for an event OR manages the event callback
   * @param  {Function} fn  Solidity event method
   * @return {Emitter}      Event emitter
   */
  event: function(fn) {
    const constructor = this;
    const decode = utils.decodeLogs;
    let currentLogID = null;

    // Someone upstream is firing duplicates :/
    function dedupe(id) {
      return id === currentLogID ? false : (currentLogID = id);
    }

    return function(params, callback) {
      if (typeof params === "function") {
        callback = params;
        params = {};
      }

      // As callback
      if (callback !== undefined) {
        const intermediary = function(err, e) {
          if (err) return callback(err);
          if (!dedupe(e.id)) return;
          callback(null, decode.call(constructor, e, true)[0]);
        };

        return constructor
          .detectNetwork()
          .then(() => fn.call(constructor.events, params, intermediary));
      }

      // As EventEmitter
      const emitter = new EventEmitter();

      constructor.detectNetwork().then(() => {
        const event = fn(params);

        event.on(
          "data",
          e =>
            dedupe(e.id) &&
            emitter.emit("data", decode.call(constructor, e, true)[0])
        );
        event.on(
          "changed",
          e =>
            dedupe(e.id) &&
            emitter.emit("changed", decode.call(constructor, e, true)[0])
        );
        event.on("error", e => emitter.emit("error", e));
      });

      return emitter;
    };
  },

  /**
   * Wraps web3 `allEvents`, with additional log decoding
   * @return {PromiEvent}  EventEmitter
   */
  allEvents: function(web3Instance) {
    const constructor = this;
    const decode = utils.decodeLogs;
    let currentLogID = null;

    // Someone upstream is firing duplicates :/
    function dedupe(id) {
      return id === currentLogID ? false : (currentLogID = id);
    }

    return function(params) {
      const emitter = new EventEmitter();

      constructor.detectNetwork().then(() => {
        const event = web3Instance.events.allEvents(params);

        event.on(
          "data",
          e =>
            dedupe(e.id) &&
            emitter.emit("data", decode.call(constructor, e, true)[0])
        );
        event.on(
          "changed",
          e =>
            dedupe(e.id) &&
            emitter.emit("changed", decode.call(constructor, e, true)[0])
        );
        event.on("error", e => emitter.emit("error", e));
      });

      return emitter;
    };
  },

  /**
   * Wraps web3 `getPastEvents`, with additional log decoding
   * @return {Promise}  Resolves array of event objects
   */
  getPastEvents: function(web3Instance) {
    const constructor = this;
    const decode = utils.decodeLogs;

    return function(event, options) {
      return web3Instance
        .getPastEvents(event, options)
        .then(events => decode.call(constructor, events, false));
    };
  },

  /**
   * Estimates gas cost of a method invocation
   * @param  {Function} fn  Method to target
   * @param  {Object}   methodABI  Function ABI segment w/ inputs & outputs keys.
   * @return {Promise}
   */
  estimate: function(fn, methodABI) {
    const constructor = this;
    return function() {
      return execute
        .prepareCall(constructor, methodABI, arguments)
        .then(res => fn(...res.args).estimateGas(res.params));
    };
  },

  /**
   *
   * @param  {Function} fn  Method to target
   * @param  {Object}   methodABI  Function ABI segment w/ inputs & outputs keys.
   * @return {Promise}
   */
  request: function(fn, methodABI) {
    const constructor = this;
    return function() {
      return execute
        .prepareCall(constructor, methodABI, arguments)
        .then(res => fn(...res.args).request(res.params));
    };
  },

  // This gets attached to `.new` (declared as a static_method in `contract`)
  // during bootstrapping as `estimate`
  estimateDeployment: function() {
    const constructor = this;

    const constructorABI = constructor.abi.filter(
      i => i.type === "constructor"
    )[0];

    return execute
      .prepareCall(constructor, constructorABI, arguments)
      .then(res => {
        const options = {
          data: constructor.binary,
          arguments: res.args
        };

        delete res.params["data"]; // Is this necessary?

        const instance = new constructor.web3.eth.Contract(
          constructor.abi,
          res.params
        );
        return instance.deploy(options).estimateGas(res.params);
      });
  },

  //our own custom sendTransaction function, made to mimic web3's,
  //while also being able to do things, like, say, store the transaction
  //hash even in case of failure.  it's not as powerful in some ways,
  //as it just returns an ordinary Promise rather than web3's PromiEvent,
  //but it's more suited to our purposes (we're not using that PromiEvent
  //functionality here anyway)
  //input works the same as input to web3.sendTransaction
  //(well, OK, it's lacking some things there too, but again, good enough
  //for our purposes)
  sendTransaction: function(web3, params, promiEvent, context) {
    //first off: if we don't need the debugger, let's not risk any errors on our part,
    //and just have web3 do everything
    if (!promiEvent || !promiEvent.debug) {
      const deferred = web3.eth.sendTransaction(params);
      handlers.setup(deferred, context);
      return deferred;
    }
    //otherwise, do things manually!
    //(and skip the PromiEvent stuff :-/ )
    return execute.sendTransactionManual(web3, params, promiEvent);
  },

  sendTransactionManual: async function(web3, params, promiEvent) {
    //note: to head off any potential problems with Webpack (contract *has* to
    //work on web!), I'm going to resort to manual promise creation rather than
    //using util.promisify :-/
    const send = rpc =>
      new Promise((accept, reject) =>
        web3.currentProvider.send(
          rpc,
          (err, result) => (err ? reject(err) : accept(result))
        )
      );
    //let's clone params
    let transaction = {};
    for (let key in params) {
      transaction[key] = params[key];
    }
    transaction.from =
      transaction.from != undefined
        ? transaction.from
        : web3.eth.defaultAccount;
    //now: if the from address is in the wallet, web3 will sign the transaction before
    //sending, so we have to account for that
    const account = web3.eth.accounts.wallet[transaction.from];
    let rpcPromise;
    if (account) {
      const rawTx = (await web3.eth.accounts.sign(
        transaction,
        account.privateKey
      )).rawTransaction;
      rpcPromise = send({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "eth_sendRawTransaction",
        params: [rawTx]
      });
    } else {
      //in this case, web3 hasn't checked the validity of our inputs, so we'd better
      //have it do that before the send
      transaction = formatters.inputTransactionFormatter(transaction); //warning, not a pure fn
      rpcPromise = send({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "eth_sendTransaction",
        params: [transaction]
      });
    }
    const rpcReturn = await rpcPromise;
    const txHash = rpcReturn.result; //note: this should work even in Ganache default mode!
    //this is unlike for calls, where default mode poses more of a problem
    promiEvent.setTransactionHash(txHash); //this here is why I wrote this function @_@
    const receipt = await web3.eth.getTransactionReceipt(txHash);
    if (rpcReturn.error) {
      //appears to be how web3 handles errors in Ganache's default mode??
      throw new Error("Returned error: " + rpcReturn.error.message);
    }
    if (receipt.status) {
      if (!transaction.to) {
        //in the deployment case, web3 might error even when technically successful @_@
        if ((await web3.eth.getCode(receipt.contractAddress)) === "0x") {
          throw new Error(
            "The contract code couldn't be stored, please check your gas limit."
          );
        }
      }
      return receipt;
    } else {
      //otherwise: we have to mimic web3's errors @_@
      if (!transaction.to) {
        //deployment case
        throw new Error(
          "The contract code couldn't be stored, please check your gas limit."
        );
      }
      throw new Error(
        "Transaction has been reverted by the EVM:" +
          "\n" +
          JSON.stringify(receipt)
      );
    }
  }
};

module.exports = execute;
