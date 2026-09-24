import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { ZuniaConnectError } from "./errors.js";
import {
  SIGN_IN_LIMITS,
  buildSignInMessage,
  checkSignInBinding,
  createNonce,
  looksLikeSignIn,
  parseSignInMessage,
  type SignInMessage,
} from "./sign-in.js";

interface Vectors {
  valid: Array<{ name: string; lines: string[]; fields: SignInMessage }>;
  invalid: Array<{ name: string; lines: string[] }>;
  binding: Array<{
    name: string;
    lines: string[];
    origin: string;
    chainId: string;
    signer: string;
    now: string;
    expect: "ok" | "ORIGIN_MISMATCH" | "INVALID_PARAMS";
  }>;
}

const vectors = JSON.parse(
  readFileSync(new URL("../test-vectors/sign-in-vectors.json", import.meta.url), "utf8"),
) as Vectors;

function codeOf(fn: () => void): string {
  try {
    fn();
    return "ok";
  } catch (error) {
    assert.ok(error instanceof ZuniaConnectError, `unexpected error ${String(error)}`);
    return error.code;
  }
}

describe("sign-in vectors shared with the extension and the mobile wallet", () => {
  for (const vector of vectors.valid) {
    it(`parses and rebuilds: ${vector.name}`, () => {
      const text = vector.lines.join("\n");
      assert.deepEqual(parseSignInMessage(text), vector.fields);
      const { version: _version, ...fields } = vector.fields;
      assert.equal(buildSignInMessage(fields), text);
    });
  }

  for (const vector of vectors.invalid) {
    it(`refuses: ${vector.name}`, () => {
      assert.equal(codeOf(() => parseSignInMessage(vector.lines.join("\n"))), "INVALID_PARAMS");
    });
  }

  for (const vector of vectors.binding) {
    it(`binds: ${vector.name}`, () => {
      const result = codeOf(() =>
        checkSignInBinding(parseSignInMessage(vector.lines.join("\n")), {
          origin: vector.origin,
          chainId: vector.chainId,
          signer: vector.signer,
          now: Date.parse(vector.now),
        }),
      );
      assert.equal(result, vector.expect);
    });
  }
});

describe("buildSignInMessage", () => {
  const base = {
    domain: "app.example.com",
    address: "cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu",
    uri: "https://app.example.com",
    chainId: "cosmoshub-4",
    nonce: "8f3k2m9QxZ",
  };

  it("defaults Issued At to now", () => {
    const before = Date.now();
    const parsed = parseSignInMessage(buildSignInMessage(base));
    assert.ok(Date.parse(parsed.issuedAt) >= before - 1);
  });

  it("refuses fields the wallet would read differently", () => {
    for (const bad of [
      { statement: "URI: https://evil.example" },
      { statement: "two\nlines" },
      { statement: "" },
      { domain: "app.example.com/path" },
      { nonce: "short" },
      { chainId: "has space" },
      { requestId: "a\u202Eb" },
      { resources: [] },
      { expirationTime: "tomorrow" },
    ]) {
      assert.equal(codeOf(() => buildSignInMessage({ ...base, ...bad })), "INVALID_PARAMS", JSON.stringify(bad));
    }
  });

  it("stays within the size limit", () => {
    const statement = "x".repeat(SIGN_IN_LIMITS.maxStatement + 1);
    assert.equal(codeOf(() => buildSignInMessage({ ...base, statement })), "INVALID_PARAMS");
  });
});

describe("helpers", () => {
  it("creates 128-bit hex nonces the parser accepts", () => {
    const nonce = createNonce();
    assert.match(nonce, /^[0-9a-f]{32}$/);
    assert.notEqual(nonce, createNonce());
  });

  it("spots sign-in text in any wording", () => {
    assert.equal(looksLikeSignIn("x.com Wants You To Sign In With Your Ethereum account:"), true);
    assert.equal(looksLikeSignIn("hello"), false);
  });
});
