"use client";

import { useMemo } from "react";
import { qrMatrix } from "@zunialab/sdk-web";

export interface ZuniaQrCodeProps {
  value: string;
  /** CSS pixels. Default 220. */
  size?: number;
  /** Quiet zone in modules. Default 4. */
  margin?: number;
  dark?: string;
  light?: string;
  label?: string;
  className?: string;
}

/** An offline QR code: the value never leaves the page. */
export function ZuniaQrCode({ value, size = 220, margin = 4, dark = "#000", light = "#fff", label = "QR code", className }: ZuniaQrCodeProps) {
  const { count, path } = useMemo(() => qrMatrix(value), [value]);
  const box = count + margin * 2;
  return (
    <svg
      viewBox={`${-margin} ${-margin} ${box} ${box}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      role="img"
      aria-label={label}
      className={className}
    >
      <rect x={-margin} y={-margin} width={box} height={box} fill={light} />
      <path d={path} fill={dark} />
    </svg>
  );
}
