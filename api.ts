export {
  definePluginEntry,
  type OpenClawConfig,
  type OpenClawPluginApi,
  type OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/plugin-entry";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";

export interface PluginSubsystemLogger {
  trace(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

// Vibrant Discord blurple (38;5;69 from 256-color palette)
export const LOG_PREFIX = "\x1b[38;5;69mdiscord-activity:\x1b[0m";

let backendLogger: PluginSubsystemLogger = createSubsystemLogger("plugins");

function formatPrefixed(message: string): string {
  return message.startsWith(LOG_PREFIX) ? message : `${LOG_PREFIX} ${message}`;
}

export const logger: PluginSubsystemLogger = {
  trace(message: string, meta?: Record<string, unknown>): void {
    backendLogger.trace(formatPrefixed(message), meta);
  },
  debug(message: string, meta?: Record<string, unknown>): void {
    backendLogger.debug(formatPrefixed(message), meta);
  },
  info(message: string, meta?: Record<string, unknown>): void {
    backendLogger.info(formatPrefixed(message), meta);
  },
  warn(message: string, meta?: Record<string, unknown>): void {
    backendLogger.warn(formatPrefixed(message), meta);
  },
};

export interface ExternalApiLogger {
  trace?: (message: string, ...args: unknown[]) => void;
  debug?: (message: string, ...args: unknown[]) => void;
  info?: (message: string, ...args: unknown[]) => void;
  warn?: (message: string, ...args: unknown[]) => void;
  error?: (message: string, ...args: unknown[]) => void;
}

export function setApiLogger(apiLogger: ExternalApiLogger): void {
  const defaultLogger = createSubsystemLogger("plugins");
  backendLogger = {
    trace: (msg, meta) =>
      apiLogger.trace
        ? apiLogger.trace(msg, meta)
        : defaultLogger.trace(msg, meta),
    debug: (msg, meta) =>
      apiLogger.debug
        ? apiLogger.debug(msg, meta)
        : defaultLogger.debug(msg, meta),
    info: (msg, meta) =>
      apiLogger.info
        ? apiLogger.info(msg, meta)
        : defaultLogger.info(msg, meta),
    warn: (msg, meta) =>
      apiLogger.warn
        ? apiLogger.warn(msg, meta)
        : defaultLogger.warn(msg, meta),
  };
}

export function resetApiLogger(): void {
  backendLogger = createSubsystemLogger("plugins");
}
