"use client";

import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import type { ZuniaPairing, ZuniaSessionStatus } from "@zunialab/sdk-core";
import { ZUNIA_CONNECT_BUTTON, ZUNIA_DEEP_LINKS } from "@zunialab/sdk-core";
import { isPhoneBrowser } from "@zunialab/sdk-web";
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
  /**
   * Show "Open the Zunia app", the link that pairs Zunia on this same device.
   * Default: only in a phone or tablet browser (`isPhoneBrowser()`), where it comes
   * first. On a computer the link has nothing to open, so only the QR code shows.
   */
  showAppLink?: boolean;
}

/**
 * Link that opens the Zunia app on the same phone, for mobile browsers. For QR
 * pairing it is `pairing.appUri`, which carries the return target.
 */
export function pairingDeepLink(pairing: ZuniaPairing): string {
  if (pairing.transport === "native-ws") return pairing.appUri ?? pairing.uri;
  return `${ZUNIA_DEEP_LINKS.walletConnectPath}?uri=${encodeURIComponent(pairing.uri)}`;
}

const noSubscription = () => () => {};

/** Phone detection that renders the computer layout on the server and fixes it on hydration. */
function usePhoneBrowser(): boolean {
  return useSyncExternalStore(noSubscription, isPhoneBrowser, () => false);
}

function describe(
  status: ZuniaSessionStatus,
  code: string | undefined,
  error: { message: string } | undefined,
  appLink: boolean,
): string {
  if (error && (status === "disconnected" || status === "error")) return error.message;
  if (status === "connecting") return "Preparing a secure session...";
  if (status === "awaiting_wallet") {
    if (code) return "Check that your phone shows this code, then approve there.";
    return appLink ? "Open the Zunia app on this phone, or scan the code with Zunia on another one." : "Scan with the Zunia app on your phone.";
  }
  if (status === "connected") return "Connected.";
  return "";
}

/**
 * QR pairing dialog: shows the code to scan, then the 6-digit code to compare
 * with the phone. The phone also shows the site the relay saw, so a copied QR
 * code on another site does not look like yours.
 */
export function ConnectPairingModal({
  open,
  onOpenChange,
  status,
  pairing,
  verificationCode,
  error,
  title = "Connect with Zunia",
  showAppLink,
}: ConnectPairingModalProps) {
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const phone = usePhoneBrowser();

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
  const appLink = showAppLink ?? phone;
  const message = describe(status, verificationCode, error, appLink);
  const digits = verificationCode ? `${verificationCode.slice(0, 3)} ${verificationCode.slice(3)}` : undefined;
  // The session notices a tap on this link (its href is `pairing.appUri`) and then
  // opens Zunia by itself after each signing request, so the user sees it.
  const link =
    pairing && !digits && appLink ? (
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
          margin: "16px 0 4px",
        }}
      >
        Open the Zunia app
      </a>
    ) : null;

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
        {link}
        {pairing && !digits ? (
          <div style={{ margin: "16px auto", width: appLink ? 160 : 220, borderRadius: 16, overflow: "hidden", background: "#fff" }}>
            <ZuniaQrCode value={pairing.uri} size={appLink ? 160 : 220} label="Pairing QR code" />
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
