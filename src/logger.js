const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
};

class Logger {
  constructor(context = "App") {
    this.context = context;
  }

  static getLogTimezone() {
    return process.env.LOG_TIMEZONE || process.env.TZ || "Asia/Yekaterinburg";
  }

  static getOffsetLabel(timeZone) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        timeZoneName: "shortOffset",
      }).formatToParts(new Date());
      const tzPart = parts.find((part) => part.type === "timeZoneName");
      return tzPart?.value || "GMT+5";
    } catch (_) {
      return "GMT+5";
    }
  }

  static getTimestamp() {
    const timeZone = Logger.getLogTimezone();
    const base = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date());

    return `${base} ${Logger.getOffsetLabel(timeZone)}`;
  }

  log(message, context = this.context) {
    this.print("LOG", colors.green, message, context);
  }

  error(message, trace = "", context = this.context) {
    this.print("ERROR", colors.red, message, context);
    if (trace) console.error(`${colors.red}${trace}${colors.reset}`);
  }

  warn(message, context = this.context) {
    this.print("WARN", colors.yellow, message, context);
  }

  debug(message, context = this.context) {
    this.print("DEBUG", colors.magenta, message, context);
  }

  verbose(message, context = this.context) {
    this.print("VERBOSE", colors.cyan, message, context);
  }

  /**
   * @param {string} text
   * @param {number} [max]
   */
  static truncate(text, max = 400) {
    const s = String(text ?? "");
    if (s.length <= max) return s;
    return `${s.slice(0, max)}…`;
  }

  print(level, color, message, context) {
    const pid = process.pid;
    const timestamp = Logger.getTimestamp();
    const formattedLevel = level.padEnd(7);
    
    process.stdout.write(
      `${colors.green}[Bot] ${pid}  - ${colors.reset}` +
      `${timestamp}   ` +
      `${color}${formattedLevel}${colors.reset} ` +
      `${colors.yellow}[${context}]${colors.reset} ` +
      `${color}${message}${colors.reset}\n`
    );
  }
}

export const logger = new Logger();
export { Logger };
