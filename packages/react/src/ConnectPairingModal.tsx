"use client";

import { useEffect, useId, useRef } from "react";
import type { ZuniaPairing, ZuniaSessionStatus } from "@zunialab/sdk-core";
import { ZUNIA_CONNECT_BUTTON, ZUNIA_DEEP_LINKS } from "@zunialab/sdk-core";
import { ZuniaQrCode } from "./ZuniaQrCode.js";

export interface ConnectPairingModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: ZuniaSessionStatus;
  pairing?: ZuniaPairing;
  /** The 6-digit code from the session. The phone must show the same one. */
  verificationCode?: string;
  error?: { message: string };
  title?: string;
}

/** Link that opens the Zunia app on the same phone, for mobile browsers. */
export function pairingDeepLink(pairing: ZuniaPairing): string {
  return pairing.transport === "native-ws" ? pairing.uri : `${ZUNIA_DEEP_LINKS.walletConnectPath}?uri=${encodeURIComponent(pairing.uri)}`;
}

function describe(status: ZuniaSessionStatus, code: string | undefined, error: { message: string } | undefined): string {
  if (error && (status === "disconnected" || status === "error")) return error.message;
  if (status === "connecting") return "Preparing a secure session...";
  if (status === "awaiting_wallet") {
    return code ? "Check that your phone shows this code, then approve there." : "Scan with the Zunia app on your phone.";
  }
  if (status === "connected") return "Connected.";
  return "";
}

/**
 * QR pairing dialog: shows the code to scan, then the 6-digit code to compare
 * with the phone. The phone also shows the site the relay saw, so a copied QR
 * code on another site does not look like yours.
 */
export function ConnectPairingModal({ open, onOpenChange, status, pairing, verificationCode, error, title = "Connect with Zunia" }: ConnectPairingModalProps) {
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    dialog.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  if (!open) return null;
  const message = describe(status, verificationCode, error);
  const digits = verificationCode ? `${verificationCode.slice(0, 3)} ${verificationCode.slice(3)}` : undefined;

  return (
    <div
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
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{
          width: "100%",
          maxWidth: 360,
          borderRadius: 18,
          background: "#111",
          color: "#fff",
          padding: 24,
          fontFamily: ZUNIA_CONNECT_BUTTON.fontFamily,
          textAlign: "center",
          outline: "none",
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id={titleId} style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
          {title}
        </h2>
        {pairing && !digits ? (
          <div style={{ margin: "16px auto", width: 220, borderRadius: 16, overflow: "hidden", background: "#fff" }}>
            <ZuniaQrCode value={pairing.uri} size={220} label="Pairing QR code" />
          </div>
        ) : null}
        {digits ? (
          <div
            aria-label={`Verification code ${verificationCode}`}
            style={{ margin: "20px 0 8px", fontSize: 40, fontWeight: 600, letterSpacing: "0.08em", fontVariantNumeric: "tabular-nums" }}
          >
            {digits}
          </div>
        ) : null}
        {message ? (
          <p role="status" style={{ fontSize: 13, opacity: 0.8, margin: "0 0 16px" }}>
            {message}
          </p>
        ) : null}
        {pairing && !digits ? (
          <a
            href={pairingDeepLink(pairing)}
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
            Open the Zunia app
          </a>
        ) : null}
        <div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            style={{ background: "transparent", border: "none", color: "rgba(255,255,255,0.7)", cursor: "pointer", fontSize: 13 }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
