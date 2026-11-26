import assert from "node:assert/strict";
import test from "node:test";
import { Client, makeSession, resolvedSyncPromise, type ClientOptions, type Envelope, type Event, type Integration } from "@sentry/core";
import { outgoingEnvelopeIntegration, prepareOutgoingEnvelope } from "./crashReportEnvelope";

class RecordingClient extends Client {
  constructor(options: ClientOptions) {
    super(options);
  }

  eventFromException(): PromiseLike<Event> {
    return resolvedSyncPromise({});
  }

  eventFromMessage(): PromiseLike<Event> {
    return resolvedSyncPromise({});
  }
}

// Like the Electron SDK's session integration with sendOnCreate: the first
// session leaves while the client is still being set up.
const sessionAtSetup: Integration = {
  name: "SessionAtSetup",
  setup(client) {
    client.captureSession(makeSession({ release: "AccordAgents@1.11.9+mac", environment: "production" }));
  }
};

function startClient(teamDevice: boolean): Envelope[] {
  const sent: Envelope[] = [];
  const client = new RecordingClient({
    dsn: "https://public@o1.ingest.de.sentry.io/1",
    integrations: [sessionAtSetup, outgoingEnvelopeIntegration({ teamDevice })],
    transport: () => ({
      send: (envelope: Envelope) => {
        sent.push(JSON.parse(JSON.stringify(envelope)) as Envelope);
        return resolvedSyncPromise({});
      },
      flush: () => resolvedSyncPromise(true)
    }),
    stackParser: () => [],
    release: "AccordAgents@1.11.9+mac",
    environment: "production"
  });
  client.init();
  return sent;
}

function sessionEnvironments(sent: Envelope[]): unknown[] {
  return sent.flatMap((envelope) => (envelope[1] as Array<[{ type?: string }, { attrs?: { environment?: unknown } }]>)
    .filter(([header]) => header.type === "session")
    .map(([, payload]) => payload.attrs?.environment));
}

test("a team device's very first session, sent while the SDK starts, already goes to team", () => {
  assert.deepEqual(sessionEnvironments(startClient(true)), ["team"]);
  assert.deepEqual(sessionEnvironments(startClient(false)), ["production"], "a real installation keeps its channel");
});

test("the last look moves sessions and still drops logs that are not usage signals", () => {
  const session = { sid: "s", attrs: { release: "AccordAgents@1.11.9+mac", environment: "beta" } };
  const logs = {
    items: [
      { body: "first_chat", attributes: { milestone: { value: "first_chat", type: "string" }, team_device: { value: true, type: "boolean" }, chat_title: { value: "Acme", type: "string" } } },
      { body: "Sending prompt to @taylor", attributes: {} }
    ]
  };
  const header = { type: "log", item_count: 2 };
  const items: Array<[{ type?: string; item_count?: number }, unknown]> = [[{ type: "session" }, session], [header, logs], [{ type: "log" }, { items: [{ body: "x" }] }]];
  prepareOutgoingEnvelope(items, { teamDevice: true });
  assert.equal(session.attrs.environment, "team");
  assert.equal(items.length, 2, "a log item with nothing left is removed");
  assert.equal(header.item_count, 1);
  assert.deepEqual(logs.items, [{ body: "first_chat", attributes: { milestone: { value: "first_chat", type: "string" }, team_device: { value: true, type: "boolean" } } }]);

  const kept = { sid: "s", attrs: { environment: "beta" } };
  prepareOutgoingEnvelope([[{ type: "session" }, kept]], { teamDevice: false });
  assert.equal(kept.attrs.environment, "beta");
});

test("only the kinds of record the app sends leave; feedback, metrics, spans and the like do not", () => {
  const event = { message: "error" };
  const items: Array<[{ type?: string; item_count?: number }, unknown]> = [
    [{ type: "event" }, event],
    [{ type: "feedback" }, { contexts: { device: { memory_size: 1 } } }],
    [{ type: "trace_metric" }, {}],
    [{ type: "span" }, {}],
    [{ type: "transaction" }, {}],
    [{ type: "attachment" }, "bytes"],
    [{ type: "session" }, { sid: "s", attrs: { environment: "beta" } }],
    [{ type: "client_report" }, {}],
    [{}, {}]
  ];
  prepareOutgoingEnvelope(items, { teamDevice: false });
  assert.deepEqual(items.map(([header]) => header.type), ["event", "session", "client_report"]);
  assert.equal(items[0][1], event, "an error event goes as beforeSend left it");
});
