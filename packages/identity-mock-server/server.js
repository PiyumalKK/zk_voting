"use strict";

/**
 * A tiny stand-in for a real government identity-management system, so
 * zk_voting's bulk-import "Identity-management API" option has something
 * real to pull from during development. No auth, no database — see data.js
 * for the whole "backend."
 *
 * Two pages:
 *   GET /          — Database: read-only view of every division, GN officer
 *                    and voter on record.
 *   GET /api.html  — API Configuration: pick which divisions (and, within
 *                    them, which specific officers/voters) this server
 *                    exposes, then publish that scope.
 *
 * Three external-facing endpoints (the whole point of this server) —
 * field names match zk_voting's bulk-import rows exactly:
 *   GET /api/divisions   → [{ name }]
 *   GET /api/gn-officers → [{ username, division }]
 *   GET /api/voters      → [{ nic, phone, division }]
 * They only ever return whatever scope was last published on the API
 * Configuration page — nothing published means an empty array, by design.
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const data = require("./data");

const PORT = Number(process.env.PORT) || 4500;
const PUBLIC_DIR = path.join(__dirname, "public");

const sendJson = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
};

const sendFile = (res, filePath, contentType) => {
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  });
};

const readJsonBody = req =>
  new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 1_000_000) req.destroy(); // guard against a runaway body on a tool with no auth
    });
    req.on("end", () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  // -- Pages -----------------------------------------------------------------
  if (req.method === "GET" && pathname === "/") {
    return sendFile(res, path.join(PUBLIC_DIR, "index.html"), "text/html; charset=utf-8");
  }
  if (req.method === "GET" && pathname === "/api.html") {
    return sendFile(res, path.join(PUBLIC_DIR, "api.html"), "text/html; charset=utf-8");
  }
  if (req.method === "GET" && pathname === "/styles.css") {
    return sendFile(res, path.join(PUBLIC_DIR, "styles.css"), "text/css; charset=utf-8");
  }

  // -- Admin (drives both pages; not part of the identity-management contract) -
  if (req.method === "GET" && pathname === "/api/db") {
    return sendJson(res, 200, data.getDatabase());
  }
  if (req.method === "GET" && pathname === "/api/config") {
    return sendJson(res, 200, data.getConfig());
  }
  // Each section publishes independently: divisions, officers and voters are
  // three separate applies, not one combined submit — see the API
  // Configuration page, where each has its own Apply button.
  if (req.method === "POST" && pathname === "/api/config/divisions") {
    try {
      const body = await readJsonBody(req);
      return sendJson(res, 200, data.setDivisions(body.divisionIds));
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }
  if (req.method === "POST" && pathname === "/api/config/officers") {
    try {
      const body = await readJsonBody(req);
      return sendJson(res, 200, data.setOfficers(body.officerUsernames));
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }
  if (req.method === "POST" && pathname === "/api/config/voters") {
    try {
      const body = await readJsonBody(req);
      return sendJson(res, 200, data.setVoters(body.voterNics));
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }
  if (req.method === "POST" && pathname === "/api/config/clear") {
    return sendJson(res, 200, data.clearConfig());
  }

  // -- External identity-management API ---------------------------------------
  if (req.method === "GET" && pathname === "/api/divisions") {
    return sendJson(res, 200, data.getPublishedDivisions());
  }
  if (req.method === "GET" && pathname === "/api/gn-officers") {
    return sendJson(res, 200, data.getPublishedOfficers());
  }
  if (req.method === "GET" && pathname === "/api/voters") {
    return sendJson(res, 200, data.getPublishedVoters());
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`Identity Management Server (mock) running at http://localhost:${PORT}`);
  console.log(`  Database:          http://localhost:${PORT}/`);
  console.log(`  API Configuration: http://localhost:${PORT}/api.html`);
});
