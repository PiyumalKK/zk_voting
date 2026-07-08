import { NextRequest, NextResponse } from "next/server";
import { createSign } from "crypto";
import { readFileSync } from "fs";

/**
 * Admin signing proxy for the CUSTOM chain backend.
 *
 * The Go node authenticates admin writes with an RSA signature over
 * "<unix-seconds>\n<path>\n<body>" (X-Admin-Signature + X-Admin-Timestamp,
 * RSA-SHA256 / PKCS#1 v1.5 — see internal/api/middleware.go's
 * AdminSignedMessage). Binding path + timestamp prevents a captured signature
 * from being replayed later or against a different endpoint. The key must
 * never reach the browser, so the admin page calls THIS route instead: it
 * checks a dashboard password, signs server-side, and forwards to the node.
 *
 * Environment (server-side only — no NEXT_PUBLIC_ prefix):
 *   ADMIN_API_PASSWORD       password the admin page must present (x-admin-password header)
 *   ADMIN_PRIVATE_KEY_PATH   path to the RSA private key PEM
 *                            (e.g. ../blockchain/data_3001/keys/admin_private.pem)
 *   ADMIN_PRIVATE_KEY_PEM    alternatively, the PEM content itself
 *   CHAIN_API_URL            Go node base URL (default http://localhost:3001)
 */

const NODE_ACTIONS: Record<string, string> = {
  "add-voter": "/add-voter",
  "set-question": "/set-question",
  "set-candidates": "/set-candidates",
  "start-registration": "/start-registration",
  "start-voting": "/start-voting",
  "end-election": "/end-election",
  "reset-election": "/reset-election",
};

function loadPrivateKey(): string | null {
  if (process.env.ADMIN_PRIVATE_KEY_PEM) return process.env.ADMIN_PRIVATE_KEY_PEM;
  const keyPath = process.env.ADMIN_PRIVATE_KEY_PATH;
  if (!keyPath) return null;
  try {
    return readFileSync(keyPath, "utf8");
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;

  const configuredPassword = process.env.ADMIN_API_PASSWORD;
  if (!configuredPassword) {
    return NextResponse.json(
      {
        error:
          "Admin proxy not configured: set ADMIN_API_PASSWORD (and ADMIN_PRIVATE_KEY_PATH) in the Next.js environment.",
      },
      { status: 503 },
    );
  }

  const presented = req.headers.get("x-admin-password") ?? "";
  if (presented !== configuredPassword) {
    return NextResponse.json({ error: "Invalid admin password" }, { status: 401 });
  }

  // Login probe — password checked above, nothing to forward.
  if (action === "verify") {
    return NextResponse.json({ ok: true });
  }

  const nodePath = NODE_ACTIONS[action];
  if (!nodePath) {
    return NextResponse.json({ error: `Unknown admin action: ${action}` }, { status: 404 });
  }

  const privateKey = loadPrivateKey();
  if (!privateKey) {
    return NextResponse.json(
      { error: "Admin proxy misconfigured: RSA key not found (ADMIN_PRIVATE_KEY_PATH / ADMIN_PRIVATE_KEY_PEM)." },
      { status: 503 },
    );
  }

  // Sign "<unix-seconds>\n<node-path>\n<body>" — the node rebuilds the same
  // string (AdminSignedMessage) and verifies it, so the body forwarded below
  // must be byte-identical to what is signed here.
  const bodyStr = JSON.stringify((await req.json().catch(() => ({}))) ?? {});
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signer = createSign("RSA-SHA256");
  signer.update(`${timestamp}\n${nodePath}\n${bodyStr}`, "utf8");
  signer.end();
  const signature = signer.sign(privateKey).toString("base64");

  const chainApiUrl = (
    process.env.CHAIN_API_URL ||
    process.env.NEXT_PUBLIC_CHAIN_API_URL ||
    "http://localhost:3001"
  ).replace(/\/$/, "");

  let nodeRes: Response;
  try {
    nodeRes = await fetch(`${chainApiUrl}${nodePath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Signature": signature,
        "X-Admin-Timestamp": timestamp,
      },
      body: bodyStr,
    });
  } catch {
    return NextResponse.json({ error: `Cannot reach the blockchain node at ${chainApiUrl}` }, { status: 502 });
  }

  const text = await nodeRes.text();
  return new NextResponse(text, {
    status: nodeRes.status,
    headers: { "Content-Type": nodeRes.headers.get("Content-Type") ?? "text/plain" },
  });
}
