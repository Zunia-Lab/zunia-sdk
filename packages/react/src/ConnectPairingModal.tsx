"use client";

import type { CreateConnectSessionResponse, ZuniaSessionStatus } from "@zunialab/sdk-core";
import { ZUNIA_CONNECT_BUTTON } from "@zunialab/sdk-core";

export function ConnectPairingModal({
  open,
  onOpenChange,
  status,
  pairing,
  statusLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: ZuniaSessionStatus | string;
  pairing?: CreateConnectSessionResponse;
  statusLabel?: string;
}) {
  if (!open) return null;

  const label =
    statusLabel ??
    (status === "connecting"
      ? "Preparing secure session…"
      : status === "awaiting_wallet"
        ? "Scan with the Zunia mobile app or open the deep link."
        : status === "error"
          ? "Connection failed"
          : String(status));

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Connect with Zunia"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.55)",
        padding: 16,
      }}
      onClick={() => onOpenChange(false)}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 360,
          borderRadius: 18,
          background: "#111",
          color: "#fff",
          padding: 24,
          fontFamily: ZUNIA_CONNECT_BUTTON.fontFamily,
          textAlign: "center",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontSize: 12, letterSpacing: "0.08em", opacity: 0.7 }}>
          CONNECT WITH ZUNIA
        </div>
        <div
          style={{
            margin: "16px auto",
            width: 200,
            height: 200,
            borderRadius: 16,
            background: "#fff",
            color: "#111",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 12,
            fontFamily: "ui-monospace, monospace",
            fontSize: 9,
            wordBreak: "break-all",
          }}
        >
          {pairing?.qrPayload?.slice(0, 120) ?? "…"}
        </div>
        <p style={{ fontSize: 13, opacity: 0.8, margin: "0 0 16px" }}>{label}</p>
        {pairing?.deepLink ? (
          <a
            href={pairing.deepLink}
            style={{
              display: "inline-block",
              padding: "10px 16px",
              borderRadius: 12,
              background: ZUNIA_CONNECT_BUTTON.bg,
              color: "#fff",
              textDecoration: "none",
              fontWeight: 500,
              marginBottom: 12,
            }}
          >
            Open Zunia app
          </a>
        ) : null}
        <div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            style={{
              background: "transparent",
              border: "none",
              color: "rgba(255,255,255,0.7)",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
