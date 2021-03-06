'use strict';

const dgram = require('dgram');
const net = require('net');
const EventEmitter = require('events');
const util = require('util');

const Device = require('./device');
const Plug = require('./plug');
const Bulb = require('./bulb');
const encryptWithHeader = require('./tplink-crypto').encryptWithHeader;
const encrypt = require('./tplink-crypto').encrypt;
const decrypt = require('./tplink-crypto').decrypt;

/**
 * Client that sends commands to specified devices or discover devices on the local subnet.
 * - Contains factory methods to create devices.
 * - Events are emitted after {@link #startDiscovery} is called.
 * @extends EventEmitter
 */
class Client extends EventEmitter {
  /**
   * @param  {Object} options
   * @param  {number} [options.timeout=5000] default timeout for network operations
   * @param  {string} [options.logLevel]       level for built in logger ['error','warn','info','debug','trace']
   */
  constructor ({timeout = 5000, logLevel, logger} = {}) {
    super();
    this.timeout = timeout;
    this.log = require('./logger')({level: logLevel, logger: logger});

    this.devices = new Map();
    this.discoveryTimer = null;
    this.discoveryPacketSequence = 0;
  }
  /**
   * {@link module:tplink-crypto Encrypts} `payload` and sends (via TCP) to device.
   * - If `payload` is not a string, it is `JSON.stringify`'d.
   * - Promise fulfills with parsed JSON response.
   *
   * Devices use JSON to communicate.\
   * For Example:
   * - If a device receives:
   *   - `{"system":{"get_sysinfo":{}}}`
   * - It responds with:
   *   - `{"system":{"get_sysinfo":{
   *       err_code: 0,
   *       sw_ver: "1.0.8 Build 151113 Rel.24658",
   *       hw_ver: "1.0",
   *       ...
   *     }}}`
   *
   * All responses contain an `err_code` (`0` is success).
   * @param  {Object} options
   * @param  {string} options.host
   * @param  {number} [options.port=9999]
   * @param  {Object|string} options.payload
   * @param  {number} [options.timeout=this.timeout]
   * @return {Promise<Object, Error>}
   */
  send ({host, port = 9999, payload, timeout = this.timeout}) {
    this.log.debug('client.send(%j)', arguments[0]);
    return new Promise((resolve, reject) => {
      let payloadString = (!(typeof payload === 'string' || payload instanceof String) ? JSON.stringify(payload) : payload);

      this.log.debug('client.send: socket: attempting to open. host:%s, port:%s', host, port);
      let socket = net.connect(port, host);
      socket.setKeepAlive(false);

      let timer;
      if (timeout > 0) {
        socket.setTimeout(timeout);
        timer = setTimeout(() => {
          this.log.debug('client.send: timeout(%s)', timeout);
          socket.end();
          socket.destroy(new Error(`client.send: timeout ${timeout}`));
        }, timeout);
      }

      let deviceData = '';

      socket.on('connect', () => {
        this.log.debug('client.send: socket on connect');
        if (timer) { clearTimeout(timer); }
        socket.write(encryptWithHeader(payloadString));
      });

      socket.on('data', (data) => {
        this.log.debug('client.send: socket on data');
        deviceData += decrypt(data.slice(4)).toString('ascii');
        socket.end();
      });

      socket.on('end', () => {
        this.log.debug('client.send: socket on end');
        let data;
        try {
          data = JSON.parse(deviceData);
        } catch (e) {
          data = deviceData;
        }
        if (!data.err_code || data.err_code === 0) {
          resolve(data);
        } else {
          let errMsg = util.format('client.send: invalid response: %s', data);
          this.log.error(errMsg);
          reject(new Error(errMsg));
        }
      });

      socket.on('timeout', () => {
        this.log.debug('client.send: socket on timeout %s', timeout);
        if (timer) { clearTimeout(timer); }
        socket.destroy(new Error(`client.send: socket on timeout ${timeout}`));
      });

      socket.on('error', (err) => {
        this.log.debug('client.send: socket on error');
        this.log.error('TPLink Device TCP Error: %s', err);
        if (timer) { clearTimeout(timer); }
        socket.destroy();
        reject(err);
      });
    });
  }
  /**
   * Requests `{system:{get_sysinfo:{}}}` from device.
   * @param  {Object}  options
   * @param  {string}  options.host
   * @param  {number}  [options.port=9999]
   * @param  {number}  [options.timeout=this.timeout] timeout for request
   * @return {Promise<Object, Error>} parsed JSON response
   */
  async getSysInfo ({host, port = 9999, timeout = this.timeout}) {
    this.log.debug('client.getSysInfo(%j)', {host, port, timeout});
    let data = await this.send({host, port, payload: '{"system":{"get_sysinfo":{}}}', timeout});
    return data.system.get_sysinfo;
  }
  /**
   * @private
   */
  emit (eventName, ...args) {
    // Add device- / plug- / bulb- to eventName
    if (args[0] instanceof Device) {
      super.emit('device-' + eventName, ...args);
      if (args[0].type !== 'device') {
        super.emit(args[0].type + '-' + eventName, ...args);
      }
    } else {
      super.emit(eventName, ...args);
    }
  }
  /**
   * Create {@link Device} object.
   * - Device object only supports common Device methods.
   * - See {@link Device#constructor} for valid options.
   * - Instead use {@link #getDevice} to create a fully featured object.
   * @param  {Object} options passed to {@link Device#constructor}
   * @return {Device}
   */
  getGeneralDevice (options) {
    options = Object.assign({}, options, {client: this});
    return new Device(options);
  }
  /**
   * Creates {@link Plug} object.
   *
   * See {@link Device#constructor} and {@link Plug#constructor} for valid options.
   * @param  {Object} options passed to {@link Plug#constructor}
   * @return {Plug}
   */
  getPlug (options) {
    options = Object.assign({}, options, {client: this});
    return new Plug(options);
  }

  /**
   * Creates Bulb object.
   *
   * See {@link Device#constructor} and {@link Bulb#constructor} for valid options.
   * @param  {Object} options passed to {@link Bulb#constructor}
   * @return {Bulb}
   */
  getBulb (options) {
    options = Object.assign({}, options, {client: this});
    return new Bulb(options);
  }

  /**
   * Creates a {@link Plug} or {@link Bulb} after querying device to determine type.
   *
   * See {@link Device#constructor}, {@link Bulb#constructor}, {@link Plug#constructor} for valid options.
   * @param  {Object}  options passed to {@link Device#constructor}
   * @return {Promise<Plug|Bulb, Error>}
   */
  async getDevice (options) {
    options = Object.assign({}, options, {client: this});
    let sysInfo = await this.getSysInfo(options);
    return this.getDeviceFromSysInfo(sysInfo, options);
  }

  /**
   * @private
   */
  getDeviceFromType (typeName, options) {
    if (typeof typeName === 'function') {
      typeName = typeName.name;
    }
    switch (typeName.toLowerCase()) {
      case 'plug': return this.getPlug(options);
      case 'bulb': return this.getBulb(options);
      default: return this.getPlug(options);
    }
  }

  /**
   * Creates device corresponding to the provided `sysInfo`.
   *
   * See {@link Device#constructor}, {@link Bulb#constructor}, {@link Plug#constructor} for valid options
   * @param  {Object} sysInfo
   * @param  {Object} options passed to device constructor
   * @return {Plug|Bulb}
   */
  getDeviceFromSysInfo (sysInfo, options) {
    options = Object.assign({}, options, {sysInfo: sysInfo});
    switch (this.getTypeFromSysInfo(sysInfo)) {
      case 'plug': return this.getPlug(options);
      case 'bulb': return this.getBulb(options);
      default: return this.getPlug(options);
    }
  }

  /**
   * Guess the device type from provided `sysInfo`.
   * @param  {Object} sysInfo
   * @return {string}         'plug','bulb','device'
   */
  getTypeFromSysInfo (sysInfo) {
    const deviceType = (sysInfo.type || sysInfo.mic_type || '').toLowerCase();
    if (deviceType.includes('plug')) {
      return 'plug';
    } else if (deviceType.includes('bulb')) {
      return 'bulb';
    }
    return 'device';
  }

  /**
   * Error during discovery.
   * @event Client#error
   * @type {Object}
   * @property {Error}
   */

  /**
   * First response from device.
   * @event Client#device-new
   * @property {Device|Bulb|Plug}
   */

  /**
   * Follow up response from device.
   * @event Client#device-online
   * @property {Device|Bulb|Plug}
   */

  /**
   * No response from device.
   * @event Client#device-offline
   * @property {Device|Bulb|Plug}
   */

  /**
   * First response from Bulb.
   * @event Client#bulb-new
   * @property {Bulb}
   */

  /**
   * Follow up response from Bulb.
   * @event Client#bulb-online
   * @property {Bulb}
   */

  /**
   * No response from Bulb.
   * @event Client#bulb-offline
   * @property {Bulb}
   */

  /**
   * First response from Plug.
   * @event Client#plug-new
   * @property {Plug}
   */

  /**
   * Follow up response from Plug.
   * @event Client#plug-online
   * @property {Plug}
   */

  /**
   * No response from Plug.
   * @event Client#plug-offline
   * @property {Plug}
   */

  /**
   * Discover TP-Link Smarthome devices on the network.
   *
   * - Sends a discovery packet (via UDP) to the `broadcast` address every `discoveryInterval`(ms).
   * - Stops discovery after `discoveryTimeout`(ms) (if `0`, runs until {@link #stopDiscovery} is called).
   *   - If a device does not respond after `offlineTolerance` number of attempts, {@link event:device-offline} is emitted.
   * - If `deviceTypes` are specified only matching devices are found.
   * - If `devices` are specified it will attempt to contact them directly in addition to sending to the broadcast address.
   *   - `devices` are specified as an array of `[{host, [port: 9999]}]`.
   * @param  {Object}   options
   * @param  {string}   [options.address]                     address to bind udp socket
   * @param  {number}   [options.port]                        port to bind udp socket
   * @param  {string}   [options.broadcast='255.255.255.255'] broadcast address
   * @param  {number}   [options.discoveryInterval=10000]     (ms)
   * @param  {number}   [options.discoveryTimeout=0]          (ms)
   * @param  {number}   [options.offlineTolerance=3]
   * @param  {string[]} [options.deviceTypes]                 'plug','bulb'
   * @param  {Object}   [options.deviceOptions={}]            passed to device constructors
   * @param  {Object[]} [options.devices]                     known devices to query instead of relying on broadcast
   * @return {Client}                                 this
   * @emits  Client#error
   * @emits  Client#device-new
   * @emits  Client#device-online
   * @emits  Client#device-offline
   * @emits  Client#bulb-new
   * @emits  Client#bulb-online
   * @emits  Client#bulb-offline
   * @emits  Client#plug-new
   * @emits  Client#plug-online
   * @emits  Client#plug-offline
   */
  startDiscovery ({address, port, broadcast = '255.255.255.255', discoveryInterval = 10000, discoveryTimeout = 0, offlineTolerance = 3, deviceTypes, deviceOptions = {}, devices} = {}) {
    this.log.debug('client.startDiscovery(%j)', arguments[0]);

    try {
      this.socket = dgram.createSocket('udp4');

      this.socket.on('error', (err) => {
        this.log.error('client.startDiscovery: UDP Error: %s', err);
        this.stopDiscovery();
        this.emit('error', err);
      // TODO
      });

      this.socket.on('message', (msg, rinfo) => {
        const decryptedMsg = decrypt(msg).toString('ascii');

        this.log.debug('client.startDiscovery(): socket from: %s message: %s', decryptedMsg, rinfo.address);

        let jsonMsg;
        let sysInfo;
        try {
          jsonMsg = JSON.parse(decryptedMsg);
          sysInfo = jsonMsg.system.get_sysinfo;
        } catch (err) {
          this.log.error('client.startDiscovery(): Error parsing JSON: %s\nFrom: [%s] Original: [%s] Decrypted: [%s]', err, rinfo.address, msg, decryptedMsg);
          return;
        }

        if (deviceTypes) {
          const deviceType = this.getTypeFromSysInfo(sysInfo);
          if (!deviceTypes.includes(deviceType)) {
            this.log.debug('client.startDiscovery(): Filtered out: %s (%s), allowed device types: (%j)', sysInfo.alias, deviceType, deviceTypes);
            return;
          }
        }

        if (this.devices.has(sysInfo.deviceId)) {
          const device = this.devices.get(sysInfo.deviceId);
          device.host = rinfo.address;
          device.port = rinfo.port;
          device.sysInfo = sysInfo;
          device.status = 'online';
          device.seenOnDiscovery = this.discoveryPacketSequence;
          this.emit('online', device);
        } else {
          Object.assign(deviceOptions, {client: this, deviceId: sysInfo.deviceId, host: rinfo.address, port: rinfo.port, seenOnDiscovery: this.discoveryPacketSequence});
          const device = this.getDeviceFromSysInfo(sysInfo, deviceOptions);
          device.sysInfo = sysInfo;
          device.status = 'online';
          this.devices.set(device.deviceId, device);
          this.emit('new', device);
        }
      });

      this.socket.bind(port, address, () => {
        this.isSocketBound = true;
        const address = this.socket.address();
        this.log.debug(`client.socket: UDP ${address.family} listening on ${address.address}:${address.port}`);
        this.socket.setBroadcast(true);

        this.discoveryTimer = setInterval(() => {
          this.sendDiscovery(broadcast, devices, offlineTolerance);
        }, discoveryInterval);

        this.sendDiscovery(broadcast, devices, offlineTolerance);
        if (discoveryTimeout > 0) {
          setTimeout(() => {
            this.log.debug('client.startDiscovery: discoveryTimeout reached, stopping discovery');
            this.stopDiscovery();
          }, discoveryTimeout);
        }
      });
    } catch (err) {
      this.log.error('client.startDiscovery: %s', err);
      this.emit('error', err);
    }

    return this;
  }

  /**
   * Stops discovery and closes UDP socket.
   */
  stopDiscovery () {
    this.log.debug('client.stopDiscovery()');
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }
    if (this.isSocketBound) {
      this.isSocketBound = false;
      this.socket.close();
    }
  }

  /**
   * @private
   */
  sendDiscovery (address, devices, offlineTolerance) {
    this.log.debug('client.sendDiscovery(%j)', arguments[0]);
    try {
      devices = devices || [];

      this.devices.forEach((device) => {
        if (device.status !== 'offline') {
          let diff = this.discoveryPacketSequence - device.seenOnDiscovery;
          if (diff >= offlineTolerance) {
            device.status = 'offline';
            this.emit('offline', device);
          }
        }
      });

      const msgBuf = encrypt('{"system":{"get_sysinfo":{}}}');

      // sometimes there is a race condition with setInterval where this is called after it was cleared
      // check and exit
      if (!this.isSocketBound) {
        return;
      }
      this.socket.send(msgBuf, 0, msgBuf.length, 9999, address);

      devices.forEach((d) => {
        this.socket.send(msgBuf, 0, msgBuf.length, d.port || 9999, d.host);
      });

      if (this.discoveryPacketSequence >= Number.MAX_VALUE) {
        this.discoveryPacketSequence = 0;
      } else {
        this.discoveryPacketSequence += 1;
      }
    } catch (err) {
      this.log.error('client.sendDiscovery: %s', err);
      this.emit('error', err);
    }

    return this;
  }
}

module.exports = Client;
