import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptSecret, decryptSecret, sign, verify, verificationCode } from "../src/lib/crypto.js";
import { mentionsToken, realWordCount } from "../src/lib/text.js";

const KEY = "a".repeat(64);

test("launch wallet keys round-trip and tampering is detected", () => {
  const enc = encryptSecret("0xsecret", KEY);
  assert.equal(decryptSecret(enc, KEY), "0xsecret");
  const parts = enc.split(".");
  parts[3] = Buffer.from("tampered").toString("base64url");
  assert.throws(() => decryptSecret(parts.join("."), KEY));
});

test("signed sessions reject forgeries", () => {
  const tok = sign({ uid: 1 }, "s3cret");
  assert.deepEqual(verify(tok, "s3cret"), { uid: 1 });
  assert.equal(verify(tok, "other"), null);
});

test("verification codes look right", () => {
  assert.match(verificationCode(), /^SHILL-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
});

test("mention detection and word counting", () => {
  const ca = "0x" + "b".repeat(40);
  assert.ok(mentionsToken("loading up on $RDOG today", "RDOG", ca));
  assert.ok(!mentionsToken("loading up on $RDOGS today", "RDOG", ca));
  assert.ok(mentionsToken(`ca: ${ca}`, "RDOG", ca));
  assert.equal(realWordCount(`$RDOG ${ca} gm`), 1);
  assert.equal(realWordCount("this coin is going to run hard $RDOG"), 7);
});
