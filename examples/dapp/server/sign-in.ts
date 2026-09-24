import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { ZuniaSignInError, createNonce, verifySignIn, type StdSignature, type VerifiedSignIn } from "@zunialab/sdk-core";

const NONCE_TTL_MS = 10 * 60_000;
const MAX_BODY_BYTES = 64 * 1024;

export interface SignInVerifierOptions {
  /**
   * The host your site is served on. Configure it: never read it from the
   * request's Host header, which any script can set to the domain a phishing
   * page collected a signature for.
   */
  domain: string;
  chainId?: string | string[];
}

/**
 * The server half of Sign in with Zunia. Nonces live in memory here; keep them
 * in Redis or your database when more than one process serves the API.
 */
export function createSignInVerifier(options: SignInVerifierOptions) {
  const nonces = new Map<string, number>();
  return {
    issueNonce(): string {
      const now = Date.now();
      for (const [nonce, expiresAt] of nonces) if (expiresAt <= now) nonces.delete(nonce);
      const nonce = createNonce();
      nonces.set(nonce, now + NONCE_TTL_MS);
      return nonce;
    },
    verify(body: { nonce?: unknown; message?: unknown; signature?: unknown }): VerifiedSignIn {
      const { nonce, message, signature } = body;
      if (typeof nonce !== "string" || typeof message !== "string" || typeof signature !== "object" || signature === null) {
        throw new ZuniaSignInError("INVALID_MESSAGE", "Expected nonce, message and signature");
      }
      const expiresAt = nonces.get(nonce);
      // One attempt per nonce, whatever the outcome.
      nonces.delete(nonce);
      if (expiresAt === undefined || expiresAt <= Date.now()) {
        throw new ZuniaSignInError("NONCE_MISMATCH", "Unknown or expired nonce, ask for a new one");
      }
      return verifySignIn({ message, signature: signature as StdSignature, domain: options.domain, nonce, chainId: options.chainId });
    },
  };
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        resolve(typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

/** `POST /api/nonce` and `POST /api/verify` on the Vite dev and preview servers. */
export function signInApi(options: SignInVerifierOptions): Plugin {
  const verifier = createSignInVerifier(options);
  const handle = (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    if (req.method !== "POST" || (req.url !== "/api/nonce" && req.url !== "/api/verify")) return next();
    if (req.url === "/api/nonce") return send(res, 200, { nonce: verifier.issueNonce() });
    readJson(req).then(
      (body) => {
        try {
          const verified = verifier.verify(body);
          send(res, 200, { address: verified.address, chainId: verified.chainId, issuedAt: verified.issuedAt, expirationTime: verified.expirationTime });
        } catch (error) {
          if (error instanceof ZuniaSignInError) send(res, 401, { code: error.code, message: error.message });
          else send(res, 500, { code: "INTERNAL", message: "Verification failed" });
        }
      },
      () => send(res, 400, { code: "BAD_REQUEST", message: "Expected a JSON body" }),
    );
  };
  return {
    name: "zunia-example-sign-in",
    configureServer(server) {
      server.middlewares.use(handle);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handle);
    },
  };
}
