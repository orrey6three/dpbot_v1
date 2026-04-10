import http from "node:http";
import { URL } from "node:url";
import { Logger } from "./logger.js";

const logger = new Logger("HTTPServer");

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on("data", (chunk) => {
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });

    req.on("error", reject);
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
        const update = await readBody(req);
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
        sendJson(res, 400, { ok: false, error: "invalid json" });
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

