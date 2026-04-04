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

  static getTimestamp() {
    const now = new Date();
    return now.toLocaleString("en-GB", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });
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
