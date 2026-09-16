"use client";

import {
  forwardRef,
  useEffect,
  type ButtonHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";
import { ZUNIA_CONNECT_BUTTON } from "@zunialab/sdk-core";
import {
  ensureConnectButtonStyles,
  type ConnectWithZuniaSize,
} from "@zunialab/sdk-web";
import { ZuniaMark } from "./ZuniaMark.js";

export interface ConnectWithZuniaButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  size?: ConnectWithZuniaSize;
  /** True when `window.zunia` (or your session) is ready. */
  installed?: boolean;
  loading?: boolean;
  label?: string;
  /** Default true so the button fills a dialog column. */
  fullWidth?: boolean;
  children?: ReactNode;
}

/**
 * Official Connect with Zunia button for React dApps and the dashboard.
 *
 * If `installed` is false and no `onClick` is provided, the button opens
 * https://zunialab.com so the user can install the wallet.
 */
export const ConnectWithZuniaButton = forwardRef<
  HTMLButtonElement,
  ConnectWithZuniaButtonProps
>(function ConnectWithZuniaButton(
  {
    size = "md",
    installed = true,
    loading = false,
    disabled,
    label,
    fullWidth = true,
    className,
    onClick,
    type = "button",
    children,
    style,
    ...rest
  },
  ref,
) {
  useEffect(() => {
    ensureConnectButtonStyles();
  }, []);

  const text =
    children ??
    label ??
    (installed ? ZUNIA_CONNECT_BUTTON.label : ZUNIA_CONNECT_BUTTON.installLabel);

  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    if (onClick) {
      onClick(event);
      return;
    }
    if (!installed && typeof window !== "undefined") {
      window.open(ZUNIA_CONNECT_BUTTON.installUrl, "_blank", "noopener,noreferrer");
    }
  }

  return (
    <button
      ref={ref}
      type={type}
      className={["zunia-connect-btn", className].filter(Boolean).join(" ")}
      data-size={size}
      data-busy={loading || undefined}
      disabled={disabled || loading}
      aria-label={typeof text === "string" ? text : ZUNIA_CONNECT_BUTTON.label}
      aria-busy={loading || undefined}
      onClick={handleClick}
      style={{ width: fullWidth ? "100%" : "auto", ...style }}
      {...rest}
    >
      {loading ? (
        <span className="zunia-connect-btn__spin" aria-hidden />
      ) : (
        <span className="zunia-connect-btn__mark">
          <ZuniaMark size={size === "sm" ? 14 : 16} />
        </span>
      )}
      <span>{text}</span>
    </button>
  );
});
