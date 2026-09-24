import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { qrMatrix, renderQrSvg } from "./qr.js";

const URI =
  "zunia://connect?v=2&sid=Zf3kQ9xTn2LmP8vR4sWb1A&t=78vWrA8rgZkX-X3b2kFXbZ4xGVuugyrwkOCgVtoTI8M&pk=6DGzxA3X-LUeWXgypFq8GG5l4txV91YLSJSpCTDLHjg&r=wss%3A%2F%2Fapi.zunialab.com";

describe("QR helpers", () => {
  it("encodes a pairing URI", () => {
    const { count, path } = qrMatrix(URI);
    assert.ok(count >= 41, `version 6 or more, got ${count} modules`);
    assert.match(path, /^M\d+ \d+h1v1h-1z/);
  });

  it("renders a standalone SVG with a quiet zone and escaped attributes", () => {
    const svg = renderQrSvg(URI, { size: 200, label: 'Scan "me" <now>', dark: "#111" });
    const { count } = qrMatrix(URI);
    assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
    assert.ok(svg.includes(`viewBox="-4 -4 ${count + 8} ${count + 8}"`));
    assert.ok(svg.includes('aria-label="Scan &quot;me&quot; &lt;now&gt;"'));
    assert.ok(svg.includes('fill="#111"'));
  });
});
