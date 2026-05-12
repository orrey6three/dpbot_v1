import { config } from "./src/config.js";
console.log(
  "Sessions found:",
  config.sessions.map((s) => ({
    name: s.name,
    apiId: s.apiId,
    hasSession: Boolean(s.stringSession),
  }))
);
