import qrcode from "qrcode-generator";

export interface QrSvgOptions {
  /** Width and height in CSS pixels. Default 240. */
  size?: number;
  /** Quiet zone in modules. Default 4, which phone cameras read reliably. */
  margin?: number;
  dark?: string;
  light?: string;
  /** Accessible name. Default "QR code". */
  label?: string;
  /** Default "M". */
  errorCorrection?: "L" | "M" | "Q" | "H";
}

/** Dark modules as one SVG path in module units, plus the module count. */
export function qrMatrix(text: string, errorCorrection: QrSvgOptions["errorCorrection"] = "M"): { count: number; path: string } {
  const qr = qrcode(0, errorCorrection);
  qr.addData(text, "Byte");
  qr.make();
  const count = qr.getModuleCount();
  let path = "";
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) path += `M${col} ${row}h1v1h-1z`;
    }
  }
  return { count, path };
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A standalone SVG string, e.g. for a pairing URI. Works without a DOM. */
export function renderQrSvg(text: string, options: QrSvgOptions = {}): string {
  const { count, path } = qrMatrix(text, options.errorCorrection);
  const margin = options.margin ?? 4;
  const box = count + margin * 2;
  const size = options.size ?? 240;
  const dark = escapeAttribute(options.dark ?? "#000000");
  const light = escapeAttribute(options.light ?? "#ffffff");
  const label = escapeAttribute(options.label ?? "QR code");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-margin} ${-margin} ${box} ${box}" width="${size}" height="${size}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="${label}">` +
    `<rect x="${-margin}" y="${-margin}" width="${box}" height="${box}" fill="${light}"/>` +
    `<path d="${path}" fill="${dark}"/></svg>`
  );
}
