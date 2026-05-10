import http from "node:http";
import { URL } from "node:url";
import { Logger } from "./logger.js";

const logger = new Logger("HTTPServer");

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        fail(Object.assign(new Error("payload too large"), { code: "PAYLOAD_TOO_LARGE" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (settled) return;
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        const parsed = raw ? JSON.parse(raw) : {};
        settled = true;
        resolve(parsed);
      } catch (err) {
        fail(err);
      }
    });

    req.on("error", fail);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function createServer({ config, state, onWebhookUpdate }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === config.healthPath) {
      const payload = {
        ok: state.transportHealthy,
        mode: state.mode,
        activeAccount: state.activeAccount,
        activeSession: state.activeSession,
        activeAccountUsername: state.activeAccountUsername,
        lastFailoverAt: state.lastFailoverAt,
        lastMessageAt: state.lastMessageAt,
        lastWebhookAt: state.lastWebhookAt,
        lastError: state.lastError,
        startedAt: state.startedAt,
      };
      sendJson(res, state.transportHealthy ? 200 : 503, payload);
      return;
    }

    if (req.method === "GET" && url.pathname === config.statusPath) {
      sendJson(res, 200, {
        mode: state.mode,
        transportHealthy: state.transportHealthy,
        activeAccount: state.activeAccount,
        activeSession: state.activeSession,
        activeAccountUsername: state.activeAccountUsername,
        lastFailoverAt: state.lastFailoverAt,
        lastMessageAt: state.lastMessageAt,
        lastWebhookAt: state.lastWebhookAt,
        lastError: state.lastError,
        startedAt: state.startedAt,
      });
      return;
    }

    if (
      req.method === "POST" &&
      config.mode === "webhook" &&
      url.pathname === config.webhookPath
    ) {
      if (
        config.webhookSecretToken &&
        req.headers["x-telegram-bot-api-secret-token"] !== config.webhookSecretToken
      ) {
        sendJson(res, 403, { ok: false, error: "invalid secret token" });
        return;
      }

      try {
        const update = await readBody(req, config.webhookMaxBodyBytes);
        state.lastWebhookAt = new Date().toISOString();
        sendJson(res, 200, { ok: true });
        queueMicrotask(() => {
          Promise.resolve(onWebhookUpdate?.(update)).catch((err) => {
            state.lastError = err.message;
            logger.error(`Webhook error: ${err.message}`);
          });
        });
      } catch (err) {
        state.lastError = err.message;
        const tooLarge = err.code === "PAYLOAD_TOO_LARGE";
        sendJson(res, tooLarge ? 413 : 400, {
          ok: false,
          error: tooLarge ? "payload too large" : "invalid json",
        });
      }
      return;
    }

    sendJson(res, 404, { ok: false, error: "not found" });
  });

  return {
    start() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.httpPort, "0.0.0.0", () => {
          server.removeListener("error", reject);
          logger.log(`Server is listening on port ${config.httpPort}`);
          resolve();
        });
      });
    },
    stop() {
      return new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}

