import cron from "node-cron";

/**
 * Раз в сутки дергает HTTPS endpoint основного приложения (DPS):
 * GET /api/cron/votes-cleanup с тем же секретом, что на сайте (CRON_SECRET).
 *
 * Переменные окружения:
 * - DPS_CRON_VOTES_URL — полный URL, например https://dps.example.com/api/cron/votes-cleanup
 * - DPS_CRON_SECRET — тот же секрет, что CRON_SECRET на хостинге Next
 * - DPS_VOTES_CRON_SCHEDULE — опционально, cron-выражение (по умолчанию 04:00 по LOG_TIMEZONE)
 */
export function startVotesCleanupScheduler(logger) {
  const url = (process.env.DPS_CRON_VOTES_URL || "").trim();
  const secret = (process.env.DPS_CRON_SECRET || "").trim();

  if (!url || !secret) {
    logger?.warn?.(
      "[votes-cron] выключен: задайте DPS_CRON_VOTES_URL и DPS_CRON_SECRET (как на сайте CRON_SECRET)"
    );
    return () => {};
  }

  const schedule = (process.env.DPS_VOTES_CRON_SCHEDULE || "0 4 * * *").trim();
  const tz = process.env.LOG_TIMEZONE || process.env.TZ || "Asia/Yekaterinburg";

  const task = cron.schedule(
    schedule,
    async () => {
      const log = logger?.log?.bind(logger) || console.log;
      const warn = logger?.warn?.bind(logger) || console.warn;
      try {
        log(`[votes-cron] запрос ${url}`);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 120000);
        const res = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${secret}`,
          },
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        const text = await res.text();
        if (!res.ok) {
          warn(`[votes-cron] HTTP ${res.status}: ${text.slice(0, 500)}`);
          return;
        }
        log(`[votes-cron] ok: ${text.slice(0, 200)}`);
      } catch (err) {
        warn(`[votes-cron] ошибка: ${err.message}`);
      }
    },
    { timezone: tz }
  );

  logger?.log?.(`[votes-cron] активен: ${schedule} (${tz}) → ${url}`);

  return () => {
    task.stop();
    logger?.log?.("[votes-cron] остановлен");
  };
}
