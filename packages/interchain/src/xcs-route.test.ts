import assert from "node:assert/strict";
import { test } from "node:test";

import { encodeBase64Utf8, jsonToBase64Url } from "./base64.js";
import { InterchainError, type LcdClient, type LcdRequestOptions } from "./types.js";
import { parseXcsPoolRoute, parseXcsSwapContract, readXcsExecutableRoute } from "./xcs-route.js";

const XCS = "osmo1uwk8xc6q0s6t5qcpr6rht3sczu6du83xq8pwxjua0hfj5hzcnh3sqxwvxs";
const ROUTER = "osmo1fy547nr4ewfc38z73ghr6x62p7eguuupm66xwk8v8rjnjyeyxdqs6gdqx7";
const ATOM = "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2";
const SAF =
  "ibc/DBAA4846F611A7603EFCE6F9F46F4F561D48B1F492A576022F000614A17089CE";

function stub(handler: (path: string) => unknown): LcdClient {
  return {
    chainId: "osmosis-1",
    async getJson(path: string, _options?: LcdRequestOptions): Promise<unknown> {
      return handler(path);
    },
  };
}

test("parseXcsSwapContract reads the swaprouter address", () => {
  assert.equal(parseXcsSwapContract({ swap_contract: ROUTER }), ROUTER);
  assert.equal(parseXcsSwapContract({ governor: "osmo1abc" }), null);
  assert.equal(parseXcsSwapContract(null), null);
});

test("parseXcsPoolRoute keeps a route that lands on the output denom", () => {
  const route = parseXcsPoolRoute(
    { pool_route: [{ pool_id: "1", token_out_denom: ATOM }] },
    ATOM,
  );
  assert.deepEqual(route, [{ poolId: "1", tokenOutDenom: ATOM }]);
  assert.equal(
    parseXcsPoolRoute({ pool_route: [{ pool_id: "1", token_out_denom: "uosmo" }] }, ATOM),
    null,
  );
  assert.equal(parseXcsPoolRoute({ pool_route: [] }, ATOM), null);
});

test("readXcsExecutableRoute returns the contract's pools, not an invented path", async () => {
  const configKey = encodeURIComponent(encodeBase64Utf8("config"));
  const query = encodeURIComponent(
    jsonToBase64Url({ get_route: { input_denom: "uosmo", output_denom: ATOM } }),
  );
  const lcd = stub((path) => {
    if (path.endsWith(`/raw/${configKey}`)) {
      return { data: encodeBase64Utf8(JSON.stringify({ swap_contract: ROUTER })) };
    }
    assert.ok(path.includes(`/smart/${query}`), path);
    return { data: { pool_route: [{ pool_id: "1", token_out_denom: ATOM }] } };
  });
  const read = await readXcsExecutableRoute(lcd, XCS, "uosmo", ATOM);
  assert.equal(read.status, "ready");
  if (read.status !== "ready") return;
  assert.equal(read.swapContract, ROUTER);
  assert.deepEqual(read.route, [{ poolId: "1", tokenOutDenom: ATOM }]);
});

test("readXcsExecutableRoute treats a missing table entry as missing", async () => {
  const lcd = stub((path) => {
    if (path.includes("/raw/")) {
      return { data: encodeBase64Utf8(JSON.stringify({ swap_contract: ROUTER })) };
    }
    throw new InterchainError(
      "lcd-unreachable",
      "osmosis-1: https://lcd.example returned HTTP 500: Vec<SwapAmountInRoute> not found",
      { chainId: "osmosis-1", httpStatus: 500 },
    );
  });
  const read = await readXcsExecutableRoute(lcd, XCS, SAF, ATOM);
  assert.deepEqual(read, { status: "missing", swapContract: ROUTER });
});

test("readXcsExecutableRoute stays unreadable when the node does not answer", async () => {
  const lcd = stub(() => {
    throw new InterchainError("lcd-unreachable", "osmosis-1: timed out", {
      chainId: "osmosis-1",
    });
  });
  const read = await readXcsExecutableRoute(lcd, XCS, "uosmo", ATOM);
  assert.deepEqual(read, { status: "unreadable" });
});
