/**
 * Swap tests.
 *
 * Every {@link LcdClient} here is a stub: the module is exercised entirely
 * offline. The recorded bodies are verbatim excerpts of what
 * `https://lcd.osmosis.zone` and `https://sqs.osmosis.zone` returned on
 * 2026-09-06, trimmed to the fields the parsers read, so a shape change
 * upstream shows up as a test that no longer matches reality rather than as a
 * silent regression.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isInterchainError, type LcdClient, type LcdRequestOptions } from "./types.js";
import {
  DEFAULT_TWAP_WINDOW_SECONDS,
  OSMOSIS_SWAP_PATHS,
  applySlippage,
  findOsmosisPools,
  minOutputFromQuote,
  parsePoolDenoms,
  parsePoolSpreadFactor,
  parseRouterQuote,
  parseRouterRoutes,
  parseSinglePoolEstimate,
  parseSpotPrice,
  parseTakerFee,
  quoteOsmosisSwap,
  slippageToTwapParams,
  type OsmosisSwapQuote,
} from "./swap.js";

const ATOM = "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2";
const AKT = "ibc/1480B8FD20AD5FCAE81EA87584D269547DD4D436843C1D20F15E00EB64743EF4";

/* -------------------------------------------------------------------------- *
 * Stubs
 * -------------------------------------------------------------------------- */

interface Recorded {
  readonly path: string;
  readonly query: Readonly<Record<string, string | number | boolean | undefined>>;
}

/** Route table keyed by path; the value may throw to simulate a failure. */
type Handler = (query: Recorded["query"]) => unknown;

function stubLcd(
  chainId: string,
  handlers: Readonly<Record<string, Handler>>,
): LcdClient & { readonly calls: Recorded[] } {
  const calls: Recorded[] = [];
  return {
    chainId,
    calls,
    async getJson(path: string, options?: LcdRequestOptions): Promise<unknown> {
      calls.push({ path, query: options?.query ?? {} });
      const handler = handlers[path];
      if (!handler) throw new Error(`unstubbed path ${path}`);
      return handler(options?.query ?? {});
    },
  };
}

/** Substitute a pool id into a path template the same way the module does. */
function poolPath(template: string, poolId: string): string {
  return template.replace("{pool_id}", poolId);
}

function expectCode(fn: () => unknown | Promise<unknown>, code: string): Promise<void> {
  return (async () => {
    try {
      await fn();
    } catch (error) {
      assert.ok(isInterchainError(error), `expected InterchainError, got ${String(error)}`);
      assert.equal(error.code, code);
      return;
    }
    assert.fail(`expected ${code}, but nothing was thrown`);
  })();
}

/* -------------------------------------------------------------------------- *
 * Recorded bodies
 * -------------------------------------------------------------------------- */

/** `GET https://sqs.osmosis.zone/router/quote?tokenIn=1000000uosmo&tokenOutDenom=<ATOM>` */
const ROUTER_QUOTE_SINGLE = {
  amount_in: { denom: "uosmo", amount: "1000000" },
  amount_out: "22518",
  route: [
    {
      pools: [
        {
          id: 1400,
          type: 2,
          balances: [],
          spread_factor: "0.000000000000000000",
          token_out_denom: ATOM,
          taker_fee: "0.008000000000000000",
          liquidity_cap: "2635",
        },
      ],
      "has-cw-pool": false,
      out_amount: "22518",
      in_amount: "1000000",
    },
  ],
  tokens: [{ denom: "uosmo", liquidity_cap: "2134685" }],
  liquidity_cap: "2635",
  liquidity_cap_overflow: false,
  effective_fee: "0.008000000000000000",
  price_impact: "-0.000060651677841116",
  in_base_out_quote_spot_price: "0.022700973626332612",
};

/** `GET .../router/custom-direct-quote?...&tokenOutDenom=<AKT>,<ATOM>&poolID=1093,4` */
const ROUTER_QUOTE_TWO_HOP = {
  amount_in: { denom: "uosmo", amount: "1000000" },
  amount_out: "22243",
  route: [
    {
      pools: [
        {
          id: 1093,
          type: 2,
          spread_factor: "0.002000000000000000",
          token_out_denom: AKT,
          taker_fee: "0.008000000000000000",
        },
        {
          id: 4,
          type: 0,
          spread_factor: "0.003000000000000000",
          token_out_denom: ATOM,
          taker_fee: "0.001500000000000000",
        },
      ],
      out_amount: "22243",
      in_amount: "1000000",
    },
  ],
  effective_fee: "0.009500000000000000",
  price_impact: "-0.000200000000000000",
  in_base_out_quote_spot_price: "0.022700973626332612",
};

/** `GET https://sqs.osmosis.zone/router/routes?tokenIn=uosmo&tokenOutDenom=<ATOM>` */
const ROUTER_ROUTES = {
  Routes: [
    {
      Pools: [{ ID: 1135, TokenInDenom: "uosmo", TokenOutDenom: ATOM }],
      IsCanonicalOrderboolRoute: false,
    },
    {
      Pools: [
        { ID: 1093, TokenInDenom: "uosmo", TokenOutDenom: AKT },
        { ID: 4, TokenInDenom: AKT, TokenOutDenom: ATOM },
      ],
      IsCanonicalOrderboolRoute: false,
    },
  ],
};

/** `GET .../osmosis/poolmanager/v1beta1/pools/1` — a balancer pool. */
const BALANCER_POOL = {
  pool: {
    "@type": "/osmosis.gamm.v1beta1.Pool",
    id: "1",
    pool_params: { swap_fee: "0.002000000000000000", exit_fee: "0.000000000000000000" },
    pool_assets: [
      { token: { denom: ATOM, amount: "231337665666" }, weight: "536870912000000" },
      { token: { denom: "uosmo", amount: "10219149797382" }, weight: "536870912000000" },
    ],
  },
};

/** `GET .../pools/1400` — a concentrated-liquidity pool: no `pool_params`. */
const CL_POOL = {
  pool: {
    "@type": "/osmosis.concentratedliquidity.v1beta1.Pool",
    id: "1400",
    token0: "uosmo",
    token1: ATOM,
    spread_factor: "0.000500000000000000",
  },
};

/** `GET .../pools/1211` — a cosmwasm pool: the fee lives in the contract. */
const CW_POOL = {
  pool: {
    "@type": "/osmosis.cosmwasmpool.v1beta1.CosmWasmPool",
    contract_address: "osmo1gyg0pys40ex2f6a4dytd3ewpx2xfrsnt3rdc2t4j3s3jc9qx8kqsny066c",
    pool_id: "1211",
    code_id: "148",
  },
};

/** `GET .../pools/1/total_pool_liquidity` */
const POOL_1_LIQUIDITY = {
  liquidity: [
    { denom: ATOM, amount: "231337665666" },
    { denom: "uosmo", amount: "10219149797382" },
  ],
};

/* -------------------------------------------------------------------------- *
 * Slippage arithmetic
 * -------------------------------------------------------------------------- */

describe("applySlippage", () => {
  it("reduces by the tolerance and rounds down", () => {
    assert.equal(applySlippage("1000000", 1), "990000");
    assert.equal(applySlippage("22518", 0.5), "22405"); // 22405.41 floored
    assert.equal(applySlippage("101", 1), "99"); // 99.99 floored, never 100
  });

  it("passes the amount through at 0% and zeroes it at 100%", () => {
    assert.equal(applySlippage("22518", 0), "22518");
    assert.equal(applySlippage("22518", 100), "0");
  });

  it("keeps full precision past Number.MAX_SAFE_INTEGER", () => {
    // uint128 amounts are routine for 18-decimal EVM-origin denoms; a float
    // implementation would round this and quietly move the floor.
    assert.equal(
      applySlippage("123456789012345678901234567890", 10),
      "111111110111111111011111111101",
    );
  });

  it("rejects a non-integer amount", async () => {
    await expectCode(() => applySlippage("1.5", 1), "invalid-request");
    await expectCode(() => applySlippage("-1", 1), "invalid-request");
    await expectCode(() => applySlippage("1e6", 1), "invalid-request");
    await expectCode(() => applySlippage("", 1), "invalid-request");
  });

  it("rejects a tolerance outside 0..100", async () => {
    await expectCode(() => applySlippage("100", -1), "invalid-request");
    await expectCode(() => applySlippage("100", 101), "invalid-request");
    await expectCode(() => applySlippage("100", Number.NaN), "invalid-request");
    await expectCode(() => applySlippage("100", Number.POSITIVE_INFINITY), "invalid-request");
  });
});

/* -------------------------------------------------------------------------- *
 * XCS slippage forms
 * -------------------------------------------------------------------------- */

describe("slippageToTwapParams", () => {
  it("produces exactly the object the crosschain-swaps README shows", () => {
    // Byte-for-byte against the spec sample: string percentage, numeric window,
    // and no extra keys — the contract's serde rejects unknown fields.
    assert.deepEqual(slippageToTwapParams(20, 10), {
      twap: { slippage_percentage: "20", window_seconds: 10 },
    });
    assert.equal(
      JSON.stringify(slippageToTwapParams(20, 10)),
      '{"twap":{"slippage_percentage":"20","window_seconds":10}}',
    );
  });

  it("keeps exactly two keys inside twap", () => {
    const built = slippageToTwapParams(1);
    assert.deepEqual(Object.keys(built), ["twap"]);
    assert.deepEqual(Object.keys(built.twap), ["slippage_percentage", "window_seconds"]);
  });

  it("defaults the window", () => {
    assert.equal(slippageToTwapParams(1).twap.window_seconds, DEFAULT_TWAP_WINDOW_SECONDS);
  });

  it("never emits exponent notation, which Decimal cannot parse", () => {
    assert.equal(String(1e-7), "1e-7");
    assert.equal(slippageToTwapParams(1e-7).twap.slippage_percentage, "0.0000001");
    assert.equal(slippageToTwapParams(0.5).twap.slippage_percentage, "0.5");
  });

  it("rejects an impossible tolerance or window", async () => {
    await expectCode(() => slippageToTwapParams(101), "invalid-request");
    await expectCode(() => slippageToTwapParams(-1), "invalid-request");
    await expectCode(() => slippageToTwapParams(1, 1.5), "invalid-request");
    await expectCode(() => slippageToTwapParams(1, -1), "invalid-request");
  });
});

describe("minOutputFromQuote", () => {
  const quote = {
    inputDenom: "uosmo",
    inputAmount: "1000000",
    outputDenom: ATOM,
    outputAmount: "22518",
    priceImpact: 0.006,
    poolFee: 0.8,
    minReceived: "22292",
    slippagePercent: 1,
    route: [],
  } as const;

  it("uses the quote's own floor by default", () => {
    assert.deepEqual(minOutputFromQuote(quote), { min_output_amount: "22292" });
    assert.equal(
      JSON.stringify(minOutputFromQuote(quote)),
      '{"min_output_amount":"22292"}',
    );
  });

  it("recomputes at an explicit tolerance", () => {
    assert.deepEqual(minOutputFromQuote(quote, 5), { min_output_amount: "21392" });
  });

  it("rejects a quote whose amounts are not integers", async () => {
    await expectCode(
      () => minOutputFromQuote({ ...quote, minReceived: "22292.4" }),
      "invalid-request",
    );
  });
});

/* -------------------------------------------------------------------------- *
 * Parsers
 * -------------------------------------------------------------------------- */

describe("parseSinglePoolEstimate", () => {
  it("reads the verified body", () => {
    assert.equal(parseSinglePoolEstimate({ token_out_amount: "22411" }), "22411");
  });

  it("rejects malformed bodies", async () => {
    for (const bad of [
      null,
      undefined,
      42,
      "22411",
      [],
      {},
      { token_out_amount: null },
      { token_out_amount: "22.4" },
      { token_out_amount: "-1" },
      { token_out_amount: {} },
      { tokenOutAmount: "22411" },
    ]) {
      await expectCode(() => parseSinglePoolEstimate(bad), "malformed-response");
    }
  });

  it("accepts a numeric amount but not a lossy one", async () => {
    assert.equal(parseSinglePoolEstimate({ token_out_amount: 22411 }), "22411");
    await expectCode(
      () => parseSinglePoolEstimate({ token_out_amount: 1e300 }),
      "malformed-response",
    );
  });
});

describe("parsePoolDenoms", () => {
  it("reads the verified body", () => {
    assert.deepEqual(parsePoolDenoms(POOL_1_LIQUIDITY), [ATOM, "uosmo"]);
  });

  it("drops unreadable entries instead of failing the response", () => {
    assert.deepEqual(
      parsePoolDenoms({ liquidity: [{ denom: "uosmo" }, {}, null, { denom: "" }] }),
      ["uosmo"],
    );
  });

  it("rejects a body with no liquidity array", async () => {
    for (const bad of [null, {}, { liquidity: null }, { liquidity: "uosmo" }, []]) {
      await expectCode(() => parsePoolDenoms(bad), "malformed-response");
    }
  });
});

describe("parsePoolSpreadFactor", () => {
  it("reads each pool type's spelling", () => {
    assert.equal(parsePoolSpreadFactor(BALANCER_POOL), "0.002000000000000000");
    assert.equal(parsePoolSpreadFactor(CL_POOL), "0.000500000000000000");
  });

  it("returns null rather than failing when the fee is not in the document", () => {
    // A cosmwasm pool keeps its fee in the contract; a quote is still useful.
    assert.equal(parsePoolSpreadFactor(CW_POOL), null);
    assert.equal(parsePoolSpreadFactor({}), null);
    assert.equal(parsePoolSpreadFactor(null), null);
    assert.equal(parsePoolSpreadFactor({ pool: { pool_params: { swap_fee: 7 } } }), "7");
  });
});

describe("parseSpotPrice / parseTakerFee", () => {
  it("reads the verified bodies", () => {
    assert.equal(
      parseSpotPrice({ spot_price: "0.022637663000000000000000000000000000" }),
      "0.022637663000000000000000000000000000",
    );
    assert.equal(parseTakerFee({ taker_fee: "0.008000000000000000" }), "0.008000000000000000");
  });

  it("returns null on anything else, because both are optional", () => {
    assert.equal(parseSpotPrice({}), null);
    assert.equal(parseSpotPrice(null), null);
    assert.equal(parseSpotPrice({ spot_price: "abc" }), null);
    assert.equal(parseTakerFee({ taker_fee: [] }), null);
  });
});

describe("parseRouterQuote", () => {
  it("reads the verified single-route body", () => {
    const quote = parseRouterQuote(ROUTER_QUOTE_SINGLE);
    assert.equal(quote.inDenom, "uosmo");
    assert.equal(quote.inAmount, "1000000");
    assert.equal(quote.outAmount, "22518");
    assert.equal(quote.effectiveFeeFraction, "0.008000000000000000");
    assert.equal(quote.priceImpactFraction, "-0.000060651677841116");
    assert.equal(quote.spotPrice, "0.022700973626332612");
    assert.equal(quote.splits.length, 1);
    // SQS reports pool ids as JSON numbers; the contract wants strings.
    assert.deepEqual(quote.splits[0]?.pools, [
      {
        poolId: "1400",
        tokenOutDenom: ATOM,
        spreadFactor: "0.000000000000000000",
        takerFee: "0.008000000000000000",
        poolType: 2,
      },
    ]);
  });

  it("reads a two-hop custom-direct-quote body in order", () => {
    const quote = parseRouterQuote(ROUTER_QUOTE_TWO_HOP);
    assert.deepEqual(
      quote.splits[0]?.pools.map((leg) => [leg.poolId, leg.tokenOutDenom]),
      [
        ["1093", AKT],
        ["4", ATOM],
      ],
    );
  });

  it("falls back to the totals when a split omits its own amounts", () => {
    const body = {
      ...ROUTER_QUOTE_SINGLE,
      route: [{ pools: ROUTER_QUOTE_SINGLE.route[0]?.pools }],
    };
    const quote = parseRouterQuote(body);
    assert.equal(quote.splits[0]?.inAmount, "1000000");
    assert.equal(quote.splits[0]?.outAmount, "22518");
  });

  it("drops a split with an unreadable leg rather than reporting a hole in it", () => {
    const body = {
      ...ROUTER_QUOTE_SINGLE,
      route: [
        { pools: [{ id: 1400 }], in_amount: "1000000", out_amount: "22518" },
        ROUTER_QUOTE_SINGLE.route[0],
      ],
    };
    assert.equal(parseRouterQuote(body).splits.length, 1);
  });

  it("reports an empty route as no-route, not as malformed", async () => {
    await expectCode(
      () => parseRouterQuote({ ...ROUTER_QUOTE_SINGLE, route: [] }),
      "no-route",
    );
  });

  it("rejects malformed bodies", async () => {
    for (const bad of [
      null,
      "quote",
      [],
      {},
      { amount_out: "1" },
      { amount_in: { denom: "uosmo" }, amount_out: "1", route: [] },
      { amount_in: { denom: "uosmo", amount: "1" }, amount_out: "1" },
      { amount_in: { denom: "uosmo", amount: "1" }, amount_out: "1", route: {} },
    ]) {
      await expectCode(() => parseRouterQuote(bad), "malformed-response");
    }
  });
});

describe("parseRouterRoutes", () => {
  it("reads the verified PascalCase body and its numeric ids", () => {
    const routes = parseRouterRoutes(ROUTER_ROUTES, "uosmo", ATOM);
    assert.equal(routes.length, 2);
    assert.deepEqual(routes[0]?.pools, [
      { poolId: "1135", tokenInDenom: "uosmo", tokenOutDenom: ATOM },
    ]);
    assert.equal(routes[1]?.pools.length, 2);
    assert.equal(routes[1]?.tokenInDenom, "uosmo");
    assert.equal(routes[1]?.tokenOutDenom, ATOM);
  });

  it("accepts the snake_case spelling too, in case the casing is normalised", () => {
    const routes = parseRouterRoutes(
      { routes: [{ pools: [{ id: "5", token_in_denom: "uosmo", token_out_denom: ATOM }] }] },
      "uosmo",
      ATOM,
    );
    assert.equal(routes[0]?.pools[0]?.poolId, "5");
  });

  it("filters routes that do not start and end where the caller asked", () => {
    assert.deepEqual(parseRouterRoutes(ROUTER_ROUTES, "uosmo", AKT), []);
  });

  it("rejects a body with no route array", async () => {
    for (const bad of [null, {}, [], { Routes: "x" }]) {
      await expectCode(() => parseRouterRoutes(bad, "uosmo", ATOM), "malformed-response");
    }
  });
});

/* -------------------------------------------------------------------------- *
 * findOsmosisPools
 * -------------------------------------------------------------------------- */

describe("findOsmosisPools", () => {
  it("asks the router first and passes a bare denom as tokenIn", async () => {
    const router = stubLcd("sqs", { [OSMOSIS_SWAP_PATHS.routerRoutes]: () => ROUTER_ROUTES });
    const lcd = stubLcd("osmosis-1", {});
    const routes = await findOsmosisPools(
      { tokenInDenom: "uosmo", tokenOutDenom: ATOM, router },
      lcd,
    );
    assert.equal(routes.length, 2);
    // /router/routes takes a denom, unlike /router/quote which takes amount+denom.
    assert.deepEqual(router.calls[0]?.query, { tokenIn: "uosmo", tokenOutDenom: ATOM });
    assert.equal(lcd.calls.length, 0);
  });

  it("caps the number of routes", async () => {
    const router = stubLcd("sqs", { [OSMOSIS_SWAP_PATHS.routerRoutes]: () => ROUTER_ROUTES });
    const routes = await findOsmosisPools(
      { tokenInDenom: "uosmo", tokenOutDenom: ATOM, router, maxRoutes: 1 },
      stubLcd("osmosis-1", {}),
    );
    assert.equal(routes.length, 1);
  });

  it("falls back to testing candidate pools for the pair", async () => {
    const lcd = stubLcd("osmosis-1", {
      [poolPath(OSMOSIS_SWAP_PATHS.totalPoolLiquidity, "1")]: () => POOL_1_LIQUIDITY,
      [poolPath(OSMOSIS_SWAP_PATHS.totalPoolLiquidity, "2")]: () => ({
        liquidity: [{ denom: "uosmo" }, { denom: AKT }],
      }),
    });
    const routes = await findOsmosisPools(
      {
        tokenInDenom: "uosmo",
        tokenOutDenom: ATOM,
        candidatePoolIds: ["1", "2"],
      },
      lcd,
    );
    assert.deepEqual(routes, [
      {
        pools: [{ poolId: "1", tokenInDenom: "uosmo", tokenOutDenom: ATOM }],
        tokenInDenom: "uosmo",
        tokenOutDenom: ATOM,
      },
    ]);
  });

  it("skips a candidate whose pool query fails", async () => {
    const lcd = stubLcd("osmosis-1", {
      [poolPath(OSMOSIS_SWAP_PATHS.totalPoolLiquidity, "9")]: () => {
        throw new Error("HTTP 500");
      },
      [poolPath(OSMOSIS_SWAP_PATHS.totalPoolLiquidity, "1")]: () => POOL_1_LIQUIDITY,
    });
    const routes = await findOsmosisPools(
      { tokenInDenom: "uosmo", tokenOutDenom: ATOM, candidatePoolIds: ["9", "1"] },
      lcd,
    );
    assert.equal(routes.length, 1);
  });

  it("refuses to guess with neither a router nor candidates", async () => {
    await expectCode(
      () =>
        findOsmosisPools(
          { tokenInDenom: "uosmo", tokenOutDenom: ATOM },
          stubLcd("osmosis-1", {}),
        ),
      "no-route",
    );
  });
});

/* -------------------------------------------------------------------------- *
 * quoteOsmosisSwap — router path
 * -------------------------------------------------------------------------- */

function routerClient(body: unknown = ROUTER_QUOTE_SINGLE) {
  return stubLcd("sqs", {
    [OSMOSIS_SWAP_PATHS.routerQuote]: () => body,
    [OSMOSIS_SWAP_PATHS.routerCustomDirectQuote]: () => ROUTER_QUOTE_TWO_HOP,
  });
}

describe("quoteOsmosisSwap via the router", () => {
  it("shapes the verified body into a SwapQuote", async () => {
    const router = routerClient();
    const quote = await quoteOsmosisSwap(
      {
        tokenInDenom: "uosmo",
        tokenInAmount: "1000000",
        tokenOutDenom: ATOM,
        slippagePercent: 1,
        router,
      },
      stubLcd("osmosis-1", {}),
    );

    assert.equal(quote.source, "router");
    assert.equal(quote.outputAmount, "22518");
    assert.equal(quote.minReceived, "22292"); // 22518 * 0.99, floored
    assert.equal(quote.slippagePercent, 1);
    assert.deepEqual(quote.route, [{ poolId: "1400", tokenOutDenom: ATOM }]);
    assert.deepEqual(router.calls[0]?.query, {
      tokenIn: "1000000uosmo",
      tokenOutDenom: ATOM,
    });
  });

  it("reports fee and price impact as two separate numbers", async () => {
    const quote = await quoteOsmosisSwap(
      { tokenInDenom: "uosmo", tokenInAmount: "1000000", tokenOutDenom: ATOM, router: routerClient() },
      stubLcd("osmosis-1", {}),
    );
    // effective_fee 0.008 -> 0.8%; price_impact -0.0000606 -> +0.00606% cost.
    assert.ok(Math.abs(quote.poolFee - 0.8) < 1e-9);
    assert.ok(Math.abs(quote.priceImpact - 0.0060651677841116) < 1e-12);
    assert.equal(quote.effectiveFeeFraction, "0.008000000000000000");
  });

  it("uses custom-direct-quote with positional lists when a route is forced", async () => {
    const router = routerClient();
    const quote = await quoteOsmosisSwap(
      {
        tokenInDenom: "uosmo",
        tokenInAmount: "1000000",
        tokenOutDenom: ATOM,
        router,
        route: [
          { poolId: "1093", tokenOutDenom: AKT },
          { poolId: "4", tokenOutDenom: ATOM },
        ],
      },
      stubLcd("osmosis-1", {}),
    );
    assert.equal(router.calls[0]?.path, OSMOSIS_SWAP_PATHS.routerCustomDirectQuote);
    assert.deepEqual(router.calls[0]?.query, {
      tokenIn: "1000000uosmo",
      tokenOutDenom: `${AKT},${ATOM}`,
      poolID: "1093,4",
    });
    assert.equal(quote.outputAmount, "22243");
  });

  it("passes singleRoute through only when asked", async () => {
    const router = routerClient();
    await quoteOsmosisSwap(
      {
        tokenInDenom: "uosmo",
        tokenInAmount: "1000000",
        tokenOutDenom: ATOM,
        router,
        singleRoute: true,
      },
      stubLcd("osmosis-1", {}),
    );
    assert.equal(router.calls[0]?.query.singleRoute, true);
  });

  it("warns and shows the largest split when the router splits the order", async () => {
    const split = {
      ...ROUTER_QUOTE_SINGLE,
      amount_out: "30000",
      route: [
        { pools: [{ id: 1, token_out_denom: ATOM }], in_amount: "400000", out_amount: "9000" },
        { pools: [{ id: 2, token_out_denom: ATOM }], in_amount: "600000", out_amount: "21000" },
      ],
    };
    const quote = await quoteOsmosisSwap(
      { tokenInDenom: "uosmo", tokenInAmount: "1000000", tokenOutDenom: ATOM, router: routerClient(split) },
      stubLcd("osmosis-1", {}),
    );
    assert.equal(quote.splits.length, 2);
    assert.deepEqual(quote.route, [{ poolId: "2", tokenOutDenom: ATOM }]);
    assert.ok(quote.warnings.some((w) => w.includes("split")));
  });

  it("turns the router's HTTP 400 into no-route", async () => {
    // SQS answers 400 for an unknown denom; LcdClient reports that as a fatal
    // `lcd-unreachable` with the status attached, and we reinterpret it.
    const router = stubLcd("sqs", {
      [OSMOSIS_SWAP_PATHS.routerQuote]: () => {
        throw Object.assign(new Error("HTTP 400"), {
          name: "InterchainError",
          code: "lcd-unreachable",
          httpStatus: 400,
        });
      },
    });
    await expectCode(
      () =>
        quoteOsmosisSwap(
          { tokenInDenom: "unope", tokenInAmount: "1000000", tokenOutDenom: ATOM, router },
          stubLcd("osmosis-1", {}),
        ),
      "no-route",
    );
  });

  it("leaves a timeout as lcd-unreachable, because the pair may be fine", async () => {
    const router = stubLcd("sqs", {
      [OSMOSIS_SWAP_PATHS.routerQuote]: () => {
        throw Object.assign(new Error("timed out"), {
          name: "InterchainError",
          code: "lcd-unreachable",
        });
      },
    });
    await expectCode(
      () =>
        quoteOsmosisSwap(
          { tokenInDenom: "uosmo", tokenInAmount: "1", tokenOutDenom: ATOM, router },
          stubLcd("osmosis-1", {}),
        ),
      "lcd-unreachable",
    );
  });

  it("rejects a quote below an explicit floor", async () => {
    await expectCode(
      () =>
        quoteOsmosisSwap(
          {
            tokenInDenom: "uosmo",
            tokenInAmount: "1000000",
            tokenOutDenom: ATOM,
            router: routerClient(),
            minOutputAmount: "30000",
          },
          stubLcd("osmosis-1", {}),
        ),
      "slippage-exceeded",
    );
  });
});

/* -------------------------------------------------------------------------- *
 * quoteOsmosisSwap — poolmanager path
 * -------------------------------------------------------------------------- */

/** An Osmosis LCD serving the verified poolmanager bodies for pools 1093 and 4. */
function poolmanagerLcd(estimates: Readonly<Record<string, string>>): LcdClient & {
  readonly calls: Recorded[];
} {
  const handlers: Record<string, Handler> = {
    [OSMOSIS_SWAP_PATHS.tradingPairTakerFee]: () => ({ taker_fee: "0.001000000000000000" }),
  };
  for (const [poolId, out] of Object.entries(estimates)) {
    handlers[poolPath(OSMOSIS_SWAP_PATHS.estimateSinglePoolSwapExactAmountIn, poolId)] =
      () => ({ token_out_amount: out });
    handlers[poolPath(OSMOSIS_SWAP_PATHS.pool, poolId)] = () => BALANCER_POOL;
    handlers[poolPath(OSMOSIS_SWAP_PATHS.spotPrice, poolId)] = () => ({
      spot_price: "0.150000000000000000",
    });
    handlers[poolPath(OSMOSIS_SWAP_PATHS.totalPoolLiquidity, poolId)] = () =>
      POOL_1_LIQUIDITY;
  }
  return stubLcd("osmosis-1", handlers);
}

describe("quoteOsmosisSwap via poolmanager", () => {
  it("chains single-pool estimates along a forced route", async () => {
    const lcd = poolmanagerLcd({ "1093": "5000", "4": "22243" });
    const quote = await quoteOsmosisSwap(
      {
        tokenInDenom: "uosmo",
        tokenInAmount: "1000000",
        tokenOutDenom: ATOM,
        route: [
          { poolId: "1093", tokenOutDenom: AKT },
          { poolId: "4", tokenOutDenom: ATOM },
        ],
      },
      lcd,
    );

    assert.equal(quote.source, "poolmanager");
    assert.equal(quote.outputAmount, "22243");
    // Each leg's estimate is fed the previous leg's output, which is the whole
    // point of chaining: EstimateSwapExactAmountIn is unreachable over REST.
    const estimates = lcd.calls.filter((c) => c.path.includes("/estimate/"));
    assert.deepEqual(estimates.map((c) => c.query.token_in), [
      "1000000uosmo",
      `5000${AKT}`,
    ]);
    assert.deepEqual(estimates.map((c) => c.query.token_out_denom), [AKT, ATOM]);
    assert.deepEqual(quote.route, [
      { poolId: "1093", tokenOutDenom: AKT },
      { poolId: "4", tokenOutDenom: ATOM },
    ]);
  });

  it("adds the two per-leg fees and compounds across legs", async () => {
    const lcd = poolmanagerLcd({ "1093": "5000", "4": "22243" });
    const quote = await quoteOsmosisSwap(
      {
        tokenInDenom: "uosmo",
        tokenInAmount: "1000000",
        tokenOutDenom: ATOM,
        route: [
          { poolId: "1093", tokenOutDenom: AKT },
          { poolId: "4", tokenOutDenom: ATOM },
        ],
      },
      lcd,
    );
    // Per leg the taker fee comes off first and the spread off the remainder:
    // (1 - 0.001)(1 - 0.002) = 0.997002. Two legs: 1 - 0.997002^2 = 0.00598700…
    assert.ok(Math.abs(quote.poolFee - (1 - 0.997002 ** 2) * 100) < 1e-9);
    assert.deepEqual(
      quote.splits[0]?.pools.map((leg) => leg.spreadFactor),
      ["0.002000000000000000", "0.002000000000000000"],
    );
  });

  it("discovers a route from candidate pools when there is no router", async () => {
    const lcd = poolmanagerLcd({ "1": "22411" });
    const quote = await quoteOsmosisSwap(
      {
        tokenInDenom: "uosmo",
        tokenInAmount: "1000000",
        tokenOutDenom: ATOM,
        candidatePoolIds: ["1"],
      },
      lcd,
    );
    assert.equal(quote.outputAmount, "22411");
    assert.deepEqual(quote.route, [{ poolId: "1", tokenOutDenom: ATOM }]);
  });

  it("picks the candidate with the best output", async () => {
    const lcd = poolmanagerLcd({ "1": "22411", "2": "23000" });
    const quote = await quoteOsmosisSwap(
      {
        tokenInDenom: "uosmo",
        tokenInAmount: "1000000",
        tokenOutDenom: ATOM,
        candidatePoolIds: ["1", "2"],
      },
      lcd,
    );
    assert.equal(quote.outputAmount, "23000");
    assert.deepEqual(quote.route, [{ poolId: "2", tokenOutDenom: ATOM }]);
  });

  it("degrades to a warning when the fee and spot price cannot be read", async () => {
    const lcd = stubLcd("osmosis-1", {
      [poolPath(OSMOSIS_SWAP_PATHS.estimateSinglePoolSwapExactAmountIn, "1")]: () => ({
        token_out_amount: "22411",
      }),
      [poolPath(OSMOSIS_SWAP_PATHS.pool, "1")]: () => CW_POOL,
      [OSMOSIS_SWAP_PATHS.tradingPairTakerFee]: () => {
        throw new Error("HTTP 500");
      },
      [poolPath(OSMOSIS_SWAP_PATHS.spotPrice, "1")]: () => ({}),
    });
    const quote = await quoteOsmosisSwap(
      {
        tokenInDenom: "uosmo",
        tokenInAmount: "1000000",
        tokenOutDenom: ATOM,
        route: [{ poolId: "1", tokenOutDenom: ATOM }],
      },
      lcd,
    );
    assert.equal(quote.outputAmount, "22411");
    assert.equal(quote.poolFee, 0);
    assert.equal(quote.priceImpact, 0);
    assert.equal(quote.effectiveFeeFraction, null);
    assert.ok(quote.warnings.some((w) => w.includes("lower bound")));
    assert.ok(quote.warnings.some((w) => w.includes("Spot price unavailable")));
  });

  it("turns a poolmanager HTTP 500 into no-route", async () => {
    const lcd = stubLcd("osmosis-1", {
      [poolPath(OSMOSIS_SWAP_PATHS.estimateSinglePoolSwapExactAmountIn, "1")]: () => {
        throw Object.assign(new Error("HTTP 500"), {
          name: "InterchainError",
          code: "lcd-unreachable",
          httpStatus: 500,
        });
      },
      [poolPath(OSMOSIS_SWAP_PATHS.pool, "1")]: () => BALANCER_POOL,
      [OSMOSIS_SWAP_PATHS.tradingPairTakerFee]: () => ({ taker_fee: "0.001" }),
      [poolPath(OSMOSIS_SWAP_PATHS.spotPrice, "1")]: () => ({ spot_price: "0.15" }),
    });
    await expectCode(
      () =>
        quoteOsmosisSwap(
          {
            tokenInDenom: "uosmo",
            tokenInAmount: "1000000",
            tokenOutDenom: "unope",
            route: [{ poolId: "1", tokenOutDenom: "unope" }],
          },
          lcd,
        ),
      "no-route",
    );
  });

  it("fails with malformed-response when a pool answers with the wrong shape", async () => {
    const lcd = stubLcd("osmosis-1", {
      [poolPath(OSMOSIS_SWAP_PATHS.estimateSinglePoolSwapExactAmountIn, "1")]: () => ({
        result: "22411",
      }),
      [poolPath(OSMOSIS_SWAP_PATHS.pool, "1")]: () => BALANCER_POOL,
      [OSMOSIS_SWAP_PATHS.tradingPairTakerFee]: () => ({ taker_fee: "0.001" }),
      [poolPath(OSMOSIS_SWAP_PATHS.spotPrice, "1")]: () => ({ spot_price: "0.15" }),
    });
    await expectCode(
      () =>
        quoteOsmosisSwap(
          {
            tokenInDenom: "uosmo",
            tokenInAmount: "1000000",
            tokenOutDenom: ATOM,
            route: [{ poolId: "1", tokenOutDenom: ATOM }],
          },
          lcd,
        ),
      "malformed-response",
    );
  });
});

/* -------------------------------------------------------------------------- *
 * Guards
 * -------------------------------------------------------------------------- */

describe("quoteOsmosisSwap guards", () => {
  const base = {
    tokenInDenom: "uosmo",
    tokenInAmount: "1000000",
    tokenOutDenom: ATOM,
  } as const;

  it("refuses a chain that is not Osmosis", async () => {
    await expectCode(
      () => quoteOsmosisSwap({ ...base, router: routerClient() }, stubLcd("safrochain-1", {})),
      "unsupported-chain",
    );
  });

  it("accepts mainnet and the testnet, whose ids share no prefix", async () => {
    for (const chainId of ["osmosis-1", "osmo-test-5"]) {
      const quote = await quoteOsmosisSwap(
        { ...base, router: routerClient() },
        stubLcd(chainId, {}),
      );
      assert.equal(quote.outputAmount, "22518");
    }
  });

  it("can be told to allow a fork or devnet chain id", async () => {
    const quote = await quoteOsmosisSwap(
      { ...base, router: routerClient(), allowAnyChainId: true },
      stubLcd("my-devnet", {}),
    );
    assert.equal(quote.source, "router");
  });

  it("rejects unusable requests before making any call", async () => {
    const lcd = stubLcd("osmosis-1", {});
    const router = routerClient();
    for (const bad of [
      { ...base, tokenInAmount: "0" },
      { ...base, tokenInAmount: "-1" },
      { ...base, tokenInAmount: "1.5" },
      { ...base, tokenInDenom: "" },
      { ...base, tokenOutDenom: "" },
      { ...base, tokenOutDenom: "uosmo" },
      { ...base, slippagePercent: 200 },
      { ...base, route: [] },
      { ...base, route: [{ poolId: "1", tokenOutDenom: AKT }] },
    ]) {
      await expectCode(() => quoteOsmosisSwap({ ...bad, router }, lcd), "invalid-request");
    }
    assert.equal(router.calls.length, 0);
    assert.equal(lcd.calls.length, 0);
  });

  it("refuses to quote with neither a router nor pool candidates", async () => {
    await expectCode(() => quoteOsmosisSwap(base, stubLcd("osmosis-1", {})), "no-route");
  });

  it("honours a path override so a non-standard gateway can be used", async () => {
    const router = stubLcd("sqs", { "/v2/router/quote": () => ROUTER_QUOTE_SINGLE });
    const quote = await quoteOsmosisSwap(
      { ...base, router, paths: { routerQuote: "/v2/router/quote" } },
      stubLcd("osmosis-1", {}),
    );
    assert.equal(quote.outputAmount, "22518");
  });
});

/* -------------------------------------------------------------------------- *
 * The quote -> memo hand-off
 * -------------------------------------------------------------------------- */

describe("quote to XCS slippage", () => {
  it("feeds minOutputFromQuote the floor the quote derived", async () => {
    const quote: OsmosisSwapQuote = await quoteOsmosisSwap(
      {
        tokenInDenom: "uosmo",
        tokenInAmount: "1000000",
        tokenOutDenom: ATOM,
        slippagePercent: 2.5,
        router: routerClient(),
      },
      stubLcd("osmosis-1", {}),
    );
    assert.equal(quote.minReceived, "21955"); // 22518 * 0.975 = 21955.05
    assert.deepEqual(minOutputFromQuote(quote), { min_output_amount: "21955" });
    // Both slippage forms are objects with exactly one key, which is what the
    // XCS `slippage` field accepts.
    assert.equal(Object.keys(minOutputFromQuote(quote)).length, 1);
    assert.equal(Object.keys(slippageToTwapParams(quote.slippagePercent)).length, 1);
  });
});
