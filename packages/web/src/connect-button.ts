import { ZUNIA_CONNECT_BUTTON, ZUNIA_PROVIDER_GLOBAL } from "@zunialab/sdk-core";
import { ZUNIA_MARK_SVG } from "./mark.js";

function detectInstalled(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean((window as Window & { [ZUNIA_PROVIDER_GLOBAL]?: unknown })[ZUNIA_PROVIDER_GLOBAL]);
}

export type ConnectWithZuniaSize = "sm" | "md" | "lg";

export interface CreateConnectWithZuniaButtonOptions {
  size?: ConnectWithZuniaSize;
  /** When omitted, click opens the install page if the extension is missing. */
  onClick?: (event: MouseEvent) => void | Promise<void>;
  /** Force installed / not-installed copy. Detects `window.zunia` when omitted. */
  installed?: boolean;
  disabled?: boolean;
  className?: string;
  label?: string;
}

const STYLE_ID = "zunia-connect-button-styles";

const HEIGHT: Record<ConnectWithZuniaSize, string> = {
  sm: "30px",
  md: "44px",
  lg: "52px",
};

const PAD: Record<ConnectWithZuniaSize, string> = {
  sm: "0 14px",
  md: "0 20px",
  lg: "0 24px",
};

const TYPE: Record<ConnectWithZuniaSize, string> = {
  sm: "500 12px/1",
  md: "500 14px/1",
  lg: "500 16px/1",
};

/** Injects the official button stylesheet. Safe to call from React or vanilla. */
export function ensureConnectButtonStyles(): void {
  if (typeof document === "undefined") return;
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = `
.zunia-connect-btn {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  width: 100%;
  border: 1px solid transparent;
  border-radius: ${ZUNIA_CONNECT_BUTTON.radius};
  background: ${ZUNIA_CONNECT_BUTTON.bg};
  color: ${ZUNIA_CONNECT_BUTTON.fg};
  font-family: ${ZUNIA_CONNECT_BUTTON.fontFamily};
  letter-spacing: -0.02em;
  cursor: pointer;
  box-shadow: ${ZUNIA_CONNECT_BUTTON.glow};
  transition: filter 160ms ease, opacity 160ms ease, box-shadow 160ms ease;
  -webkit-tap-highlight-color: transparent;
}
.zunia-connect-btn:hover:not(:disabled) {
  background: ${ZUNIA_CONNECT_BUTTON.bgHover};
  filter: brightness(1.05);
}
.zunia-connect-btn:active:not(:disabled) {
  background: ${ZUNIA_CONNECT_BUTTON.bgActive};
  filter: brightness(0.98);
}
.zunia-connect-btn:disabled { opacity: 0.45; cursor: not-allowed; box-shadow: none; }
.zunia-connect-btn:focus-visible {
  outline: 2px solid color-mix(in srgb, #FF1B0C 45%, transparent);
  outline-offset: 2px;
}
.zunia-connect-btn__mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: ${ZUNIA_CONNECT_BUTTON.mark};
  flex: none;
}
.zunia-connect-btn__mark svg { display: block; }
.zunia-connect-btn[data-size="sm"] { height: ${HEIGHT.sm}; padding: ${PAD.sm}; gap: 8px; font: ${TYPE.sm} ${ZUNIA_CONNECT_BUTTON.fontFamily}; }
.zunia-connect-btn[data-size="md"] { height: ${HEIGHT.md}; padding: ${PAD.md}; font: ${TYPE.md} ${ZUNIA_CONNECT_BUTTON.fontFamily}; }
.zunia-connect-btn[data-size="lg"] { height: ${HEIGHT.lg}; padding: ${PAD.lg}; font: ${TYPE.lg} ${ZUNIA_CONNECT_BUTTON.fontFamily}; }
.zunia-connect-btn[data-busy="true"] { pointer-events: none; }
.zunia-connect-btn__spin {
  width: 12px;
  height: 12px;
  border: 2px solid color-mix(in srgb, ${ZUNIA_CONNECT_BUTTON.fg} 22%, transparent);
  border-top-color: ${ZUNIA_CONNECT_BUTTON.fg};
  border-radius: 50%;
  animation: zunia-connect-spin .7s linear infinite;
}
@keyframes zunia-connect-spin { to { transform: rotate(360deg); } }
`;
}

function defaultClick(installed: boolean, onClick?: CreateConnectWithZuniaButtonOptions["onClick"]) {
  return (event: MouseEvent) => {
    if (onClick) {
      void onClick(event);
      return;
    }
    if (!installed && typeof window !== "undefined") {
      window.open(ZUNIA_CONNECT_BUTTON.installUrl, "_blank", "noopener,noreferrer");
    }
  };
}

/**
 * Vanilla DOM factory for the official Connect with Zunia button.
 * Use this from any web app that is not on React.
 */
export function createConnectWithZuniaButton(
  options: CreateConnectWithZuniaButtonOptions = {},
): HTMLButtonElement {
  ensureConnectButtonStyles();
  const size = options.size ?? "md";
  const installed = options.installed ?? detectInstalled();
  const button = document.createElement("button");
  button.type = "button";
  button.className = ["zunia-connect-btn", options.className].filter(Boolean).join(" ");
  button.dataset.size = size;
  button.disabled = Boolean(options.disabled);
  const label = options.label ?? ZUNIA_CONNECT_BUTTON.label;
  button.setAttribute("aria-label", label);
  button.innerHTML = `<span class="zunia-connect-btn__mark">${ZUNIA_MARK_SVG}</span><span>${label}</span>`;
  button.addEventListener("click", defaultClick(installed, options.onClick));
  return button;
}
