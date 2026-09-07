/**
 * The phone's own, lasting connection to a machine.
 *
 * Before this, the phone could only *generate* a command: it opened a socket,
 * pushed a sealed frame into the machine's room and closed it again. Nothing
 * came back, nothing was acknowledged, and the queue that was supposed to hold
 * unfinished work was never emptied because nothing ever told it a command had
 * arrived. A reply the User could see still came from the desktop, so with the
 * desktop closed the phone could ask and never learn the answer.
 *
 * This is the other half: one connection per machine, held open and re-opened
 * when it drops, speaking the same device-event protocol every other device
 * speaks. What the phone sends is a signed event out of its own durable
 * journal, and it stays there until the machine acknowledges it. What the
 * machine sends back is verified, stored, applied, acknowledged, and only then
 * dropped.
 *
 * Two signatures are involved and they are not interchangeable:
 *
 * - Every event carries its origin's own signature over its event hash. That
 *   is what makes a result trustworthy however it reached us.
 * - Every packet that is not an event carries a signature over the packet.
 *   The room's seal proves the sender is in the room; an acknowledgement is a
 *   claim about which device applied something, and it releases the sender's
 *   retained history, so being in the room is not enough to make one.
 *
 * A packet that fails either check is dropped: not applied, not acknowledged,
 * and not allowed to advance anything.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AccordMachineChannel = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const PROTOCOL = "accord-device-events-v1";
  const RELAY_PROTOCOL = "accord-relay-v1";
  const RECONNECT_MIN_MS = 1000;
  const RECONNECT_MAX_MS = 30000;
  const RESEND_MIN_MS = 5000;
  const RESEND_MAX_MS = 300000;
  const TICK_MS = 5000;

  function isDeviceEventPacket(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
      value.protocol === PROTOCOL && typeof value.from === "string" && typeof value.to === "string" &&
      ["event", "fragment", "ack", "resend", "need", "unavailable", "probe"].indexOf(value.type) >= 0;
  }

  /** The scope a machine's channel accepts from this phone, and answers in. */
  function deviceScope(rendezvousId, conversationId, scope) {
    return "device:" + rendezvousId + ":" + JSON.stringify([conversationId, scope || "actions"]);
  }

  function inScope(logScopeId, rendezvousId) {
    return logScopeId === "chat:actions" || String(logScopeId).indexOf("device:" + rendezvousId + ":") === 0;
  }

  function createMachineChannels(options) {
    const api = options.api;
    const identity = options.identity;
    const log = options.log;
    const blobs = options.blobs;
    const debug = options.debug || function () {};
    const now = options.now || function () { return Date.now(); };
    const connections = new Map();
    let ticking;
    let closed = false;

    function record(machine) {
      return {
        machine: machine,
        socket: undefined,
        connecting: undefined,
        retry: undefined,
        attempts: 0,
        frames: new Map(),
        lastSent: new Map(),
        lastError: undefined,
        connected: false
      };
    }

    /**
     * Brings the held connections in line with what this phone may command.
     *
     * A machine whose room or key changed is a different destination, so its
     * connection is replaced rather than reused. Nothing in the journal is
     * touched: what is owed to that machine is still owed to it.
     */
    function setMachines(list) {
      const wanted = new Map();
      for (const machine of list || []) {
        if (machine && machine.machineId && machine.deviceId && machine.rendezvousId) wanted.set(machine.machineId, machine);
      }
      for (const entry of [...connections]) {
        const machineId = entry[0];
        const connection = entry[1];
        const next = wanted.get(machineId);
        if (!next || next.deviceId !== connection.machine.deviceId || next.rendezvousId !== connection.machine.rendezvousId ||
            next.relayUrl !== connection.machine.relayUrl || next.relaySealKeyBase64 !== connection.machine.relaySealKeyBase64) {
          disconnect(connection, "machine access changed");
          connections.delete(machineId);
        } else {
          connection.machine = next;
        }
      }
      for (const entry of wanted) {
        if (!connections.has(entry[0])) connections.set(entry[0], record(entry[1]));
      }
      startTicking();
      return connections.size;
    }

    function machineFor(machineId) {
      if (machineId) return connections.get(machineId);
      return connections.values().next().value;
    }

    /** Every machine this phone is expected to deliver to, for retention. */
    function roster() {
      return [...connections.values()].map(function (connection) { return connection.machine.deviceId; });
    }

    function statusFor(machineId) {
      const connection = machineFor(machineId);
      if (!connection) return { connected: false, reason: "This phone has no access to that machine yet." };
      return connection.lastError
        ? { connected: connection.connected, reason: connection.lastError }
        : { connected: connection.connected };
    }

    // ---- transport -------------------------------------------------------

    function disconnect(connection, reason) {
      connection.connected = false;
      if (connection.retry) clearTimeout(connection.retry);
      connection.retry = undefined;
      connection.frames.clear();
      const socket = connection.socket;
      connection.socket = undefined;
      connection.connecting = undefined;
      if (socket && socket.readyState < 2) {
        try { socket.close(1000, reason); } catch (error) { debug({ event: "machine-channel-close-failed" }); }
      }
    }

    function scheduleReconnect(connection) {
      if (closed || connection.retry) return;
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * Math.pow(2, Math.min(connection.attempts, 5)));
      connection.retry = setTimeout(function () {
        connection.retry = undefined;
        void ensureSocket(connection).catch(function () { /* the next attempt is already scheduled */ });
      }, delay);
      if (connection.retry.unref) connection.retry.unref();
    }

    function ensureSocket(connection) {
      if (closed) return Promise.reject(new Error("This phone stopped commanding machines."));
      if (connection.socket && connection.socket.readyState === 1) return Promise.resolve(connection.socket);
      if (connection.connecting) return connection.connecting;
      const machine = connection.machine;
      connection.connecting = Promise.resolve()
        .then(function () { return options.connect(machine); })
        .then(function (socket) {
          connection.socket = socket;
          connection.connecting = undefined;
          connection.connected = true;
          connection.attempts = 0;
          connection.lastError = undefined;
          socket.addEventListener("message", function (event) { onFrame(connection, event); });
          socket.addEventListener("close", function () {
            if (connection.socket !== socket) return;
            connection.socket = undefined;
            connection.connected = false;
            connection.frames.clear();
            connection.attempts += 1;
            debug({ event: "machine-channel-closed", machineId: machine.machineId });
            scheduleReconnect(connection);
          });
          debug({ event: "machine-channel-open", machineId: machine.machineId, rendezvousId: machine.rendezvousId });
          // Whatever this phone still owes, and whatever it knows it is
          // missing, is settled the moment there is somewhere to say it.
          void deliver(machine.machineId).catch(function () { /* retried on the tick */ });
          void requestRepairs(connection).catch(function () { /* retried on the tick */ });
          return socket;
        })
        .catch(function (error) {
          connection.connecting = undefined;
          connection.connected = false;
          connection.attempts += 1;
          connection.lastError = String((error && error.message) || error);
          debug({ event: "machine-channel-connect-failed", machineId: machine.machineId, message: connection.lastError });
          scheduleReconnect(connection);
          throw error;
        });
      return connection.connecting;
    }

    async function sendPacket(connection, packet) {
      const machine = connection.machine;
      const authenticated = packet.type === "event" ? packet : await api.signPacket(identity, packet);
      const socket = await ensureSocket(connection);
      const ciphertext = await options.seal(authenticated, machine.relaySealKeyBase64);
      const frames = options.chunk({
        streamId: machine.rendezvousId + ":phone",
        logicalMessageId: packetId(authenticated),
        ciphertext: ciphertext,
        to: machine.deviceId
      });
      for (const frame of frames) socket.send(JSON.stringify(frame));
    }

    function packetId(packet) {
      if (packet.type === "event") return packet.event.eventId;
      if (packet.type === "ack") return "ack:" + packet.receipt.eventId + ":" + packet.receipt.appliedAt;
      if (packet.type === "resend") return "resend:" + packet.requestId;
      return packet.type + ":" + Math.random().toString(36).slice(2);
    }

    function frameText(data) {
      if (typeof data === "string") return data;
      return new TextDecoder().decode(data);
    }

    function onFrame(connection, message) {
      let parsed;
      try {
        parsed = JSON.parse(frameText(message.data));
      } catch (error) {
        return;
      }
      if (!parsed || parsed.protocol !== RELAY_PROTOCOL) return;
      const key = parsed.streamId + " " + parsed.logicalMessageId;
      const collected = [...(connection.frames.get(key) || []), parsed];
      connection.frames.set(key, collected);
      const result = options.reassemble(collected);
      if (result.status !== "complete") {
        if (result.status === "conflict") connection.frames.delete(key);
        return;
      }
      connection.frames.delete(key);
      connection.inbound = (connection.inbound || Promise.resolve())
        .then(function () { return receiveSealed(connection, result.ciphertext); })
        .catch(function (error) {
          connection.lastError = String((error && error.message) || error);
          debug({ event: "machine-channel-receive-error", machineId: connection.machine.machineId, message: connection.lastError });
        });
    }

    async function receiveSealed(connection, ciphertext) {
      const packet = await options.open(ciphertext, connection.machine.relaySealKeyBase64);
      if (!isDeviceEventPacket(packet)) return;
      if (packet.from !== connection.machine.deviceId || packet.to !== identity.deviceId) {
        debug({ event: "machine-channel-not-addressed", from: packet.from, to: packet.to });
        return;
      }
      // Bare events prove themselves; everything else has to prove who sent it.
      if (packet.type !== "event" && !await api.verifyPacket(packet, connection.machine.publicKeyDerBase64)) {
        debug({ event: "machine-channel-packet-unsigned", machineId: connection.machine.machineId, type: packet.type });
        return;
      }
      await handlePacket(connection, packet);
    }

    async function handlePacket(connection, packet) {
      switch (packet.type) {
        case "fragment":
          await blobs.store(packet.fragment);
          await drain(connection);
          return;
        case "ack": {
          const receipt = packet.receipt;
          if (!receipt || typeof receipt.eventId !== "string") return;
          const held = await log.get(receipt.eventId);
          // An acknowledgement for other bytes than the ones we sent releases
          // nothing: it is not a receipt for this event.
          if (held && held.eventHash !== receipt.eventHash) {
            debug({ event: "machine-channel-ack-mismatch", eventId: receipt.eventId });
            return;
          }
          await log.acknowledge(packet.from, receipt.eventId);
          connection.lastSent.delete(receipt.eventId);
          if (options.onAcknowledged) await options.onAcknowledged(receipt, connection.machine);
          await release();
          return;
        }
        case "resend": {
          const gap = packet.gap || {};
          const pending = await log.pendingFor(connection.machine.deviceId);
          for (const event of pending) {
            if (event.originId !== gap.originId || event.logScopeId !== gap.logScopeId) continue;
            if (event.originSeq < gap.fromSeq || event.originSeq > gap.toSeq) continue;
            await sendEvent(connection, event, packet.requestId);
          }
          return;
        }
        case "event": {
          const event = packet.event;
          if (!event || event.originId !== packet.from || !inScope(event.logScopeId, connection.machine.rendezvousId)) {
            debug({ event: "machine-channel-event-out-of-scope", eventId: event && event.eventId });
            return;
          }
          if (!await api.verifyEvent(event, connection.machine.publicKeyDerBase64)) {
            debug({ event: "machine-channel-event-unsigned", eventId: event.eventId });
            return;
          }
          const receipt = await log.receipt(event.originId, event.eventId);
          if (receipt) {
            // Already carried out. Repeating the receipt is what lets the
            // machine stop holding it, however the first one was lost.
            await sendPacket(connection, { protocol: PROTOCOL, from: identity.deviceId, to: packet.from, type: "ack", receipt: receipt });
            return;
          }
          const status = await log.receive(event);
          if (status === "unverified") return;
          if (status === "gap") await requestRepairs(connection);
          await drain(connection);
          return;
        }
        case "need":
          // This phone holds no artifact revisions to serve, and says so
          // rather than leaving the machine waiting for one.
          await sendPacket(connection, { protocol: PROTOCOL, from: identity.deviceId, to: packet.from,
            type: "unavailable", dependency: packet.dependency, requestId: packet.requestId });
          return;
        default:
          return;
      }
    }

    /**
     * Carries out everything that has arrived in order and acknowledges it.
     *
     * An event that cannot be applied right now -- the phone's own storage is
     * failing, or its body has not fully arrived -- stays where it is and is
     * not acknowledged, so the machine keeps holding it.
     */
    async function drain(connection) {
      const machine = connection.machine;
      for (const event of await log.inboundReady(machine.deviceId)) {
        let payload = event.payload;
        if (payload && payload.type === "device.event.blob") {
          payload = await blobs.take(payload);
          if (payload === undefined) {
            debug({ event: "machine-channel-body-incomplete", eventId: event.eventId });
            return;
          }
        }
        let outcome;
        try {
          outcome = await options.apply(event, payload, machine);
        } catch (error) {
          connection.lastError = String((error && error.message) || error);
          debug({ event: "machine-channel-apply-failed", eventId: event.eventId, message: connection.lastError });
          return;
        }
        const receipt = await log.markApplied(event, outcome === "superseded" ? "superseded" : "applied");
        try {
          await sendPacket(connection, { protocol: PROTOCOL, from: identity.deviceId, to: machine.deviceId, type: "ack", receipt: receipt });
        } catch (error) {
          // The receipt is durable: it is repeated when the machine offers the
          // event again, so a failed send is not a lost application.
          debug({ event: "machine-channel-ack-deferred", eventId: event.eventId, message: String((error && error.message) || error) });
        }
      }
    }

    async function requestRepairs(connection) {
      for (const gap of await log.gaps()) {
        if (gap.originId !== connection.machine.deviceId) continue;
        await sendPacket(connection, { protocol: PROTOCOL, from: identity.deviceId, to: connection.machine.deviceId,
          type: "resend", gap: gap, requestId: "repair-" + gap.originId + "-" + gap.fromSeq + "-" + gap.toSeq });
      }
    }

    // ---- outgoing --------------------------------------------------------

    async function sendEvent(connection, event, deliveryId) {
      const packet = { protocol: PROTOCOL, from: identity.deviceId, to: connection.machine.deviceId, type: "event", event: event };
      if (deliveryId) packet.deliveryId = deliveryId;
      await sendPacket(connection, packet);
    }

    /**
     * Offers a machine everything this phone still owes it.
     *
     * Re-offering is safe and is the point: a command carries its own id, so
     * the same ask delivered twice is one turn. Backing off keeps a machine
     * that is simply away from being hammered.
     */
    async function deliver(machineId) {
      const connection = machineFor(machineId);
      if (!connection) throw new Error("This phone has no access to that machine yet.");
      const pending = await log.pendingFor(connection.machine.deviceId);
      let sent = 0;
      for (const event of pending) {
        const previous = connection.lastSent.get(event.eventId);
        const delay = previous ? Math.min(RESEND_MIN_MS * Math.pow(2, previous.attempts), RESEND_MAX_MS) : 0;
        if (previous && now() - previous.at < delay) continue;
        await sendEvent(connection, event);
        connection.lastSent.set(event.eventId, { at: now(), attempts: Math.min((previous ? previous.attempts : -1) + 1, 6) });
        sent += 1;
      }
      return { pending: pending.length, sent: sent };
    }

    /** Frees only what every machine this phone commands has acknowledged. */
    function release() {
      return log.release(roster());
    }

    function startTicking() {
      if (ticking || closed || !connections.size) return;
      ticking = setInterval(function () {
        for (const connection of connections.values()) {
          void ensureSocket(connection).then(function () {
            return Promise.all([deliver(connection.machine.machineId), drain(connection)]);
          }).catch(function () { /* the next tick tries again */ });
        }
      }, TICK_MS);
      if (ticking.unref) ticking.unref();
    }

    function close() {
      closed = true;
      if (ticking) clearInterval(ticking);
      ticking = undefined;
      for (const connection of connections.values()) disconnect(connection, "phone stopped");
      connections.clear();
    }

    return {
      setMachines: setMachines,
      roster: roster,
      status: statusFor,
      deliver: deliver,
      release: release,
      drain: function (machineId) {
        const connection = machineFor(machineId);
        return connection ? drain(connection) : Promise.resolve();
      },
      connect: function (machineId) {
        const connection = machineFor(machineId);
        return connection ? ensureSocket(connection) : Promise.reject(new Error("This phone has no access to that machine yet."));
      },
      receiveSealed: function (machineId, ciphertext) {
        const connection = machineFor(machineId);
        return connection ? receiveSealed(connection, ciphertext) : Promise.resolve();
      },
      close: close
    };
  }

  return {
    createMachineChannels: createMachineChannels,
    deviceScope: deviceScope,
    isDeviceEventPacket: isDeviceEventPacket
  };
});
