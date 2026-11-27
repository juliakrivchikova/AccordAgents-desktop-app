import assert from "node:assert/strict";
import { test } from "node:test";
import { alertCallContactCard } from "./alertCallContact";
import { ALERT_CALL_CONTACT_PHOTO_JPEG_BASE64 } from "./alertCallContactPhoto";

test("the alert-call contact card is vCard 3.0 with only the Call-from number, folded at 75", () => {
  const card = alertCallContactCard("+1 415 555 0134");
  assert.ok(card);
  assert.ok(card.endsWith("\r\n"));
  assert.ok(!/[^\r]\n/.test(card), "every line ends in CRLF");
  const physical = card.slice(0, -2).split("\r\n");
  for (const line of physical) assert.ok(line.length <= 75, `line over 75: ${line.length}`);
  // Unfolded, the card is exactly the fields of the brief, in order.
  const logical = card.slice(0, -2).replace(/\r\n /g, "").split("\r\n");
  assert.deepEqual(logical, [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "FN:AccordAgents",
    "N:;AccordAgents;;;",
    "TEL;TYPE=VOICE:+14155550134",
    "URL:https://accordagents.com",
    "NOTE:Urgent alert calls from AccordAgents",
    `PHOTO;ENCODING=b;TYPE=JPEG:${ALERT_CALL_CONTACT_PHOTO_JPEG_BASE64}`,
    "END:VCARD"
  ]);
  // The photo is a JPEG and stays small.
  const photo = Buffer.from(ALERT_CALL_CONTACT_PHOTO_JPEG_BASE64, "base64");
  assert.deepEqual([...photo.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  assert.ok(photo.length < 40_000);
});

test("no card for something that is not an international phone number", () => {
  assert.equal(alertCallContactCard(""), undefined);
  assert.equal(alertCallContactCard("4155550134"), undefined);
  assert.equal(alertCallContactCard("+1 415\r\nNOTE:x"), undefined);
});
