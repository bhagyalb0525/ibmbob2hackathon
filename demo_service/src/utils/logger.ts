/**
 * Structured JSON Logger for demo_service
 * Emits machine-readable JSON logs for consumption by the triage agent and dashboard.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  service: string;
  message: string;
  context?: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

class Logger {
  private serviceName: string;

  constructor(serviceName = 'checkout-service') {
    this.serviceName = serviceName;
  }

  private emit(level: LogLevel, message: string, context?: Record<string, unknown>, err?: Error): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      service: this.serviceName,
      message,
    };

    if (context && Object.keys(context).length > 0) {
      entry.context = context;
    }

    if (err) {
      entry.error = {
        name: err.name,
        message: err.message,
        stack: err.stack,
      };
    }

    const jsonString = JSON.stringify(entry);

    if (level === 'error') {
      console.error(jsonString);
    } else if (level === 'warn') {
      console.warn(jsonString);
    } else {
      console.log(jsonString);
    }
  }

  public info(message: string, context?: Record<string, unknown>): void {
    this.emit('info', message, context);
  }

  public warn(message: string, context?: Record<string, unknown>): void {
    this.emit('warn', message, context);
  }

  public error(message: string, contextOrError?: Record<string, unknown> | Error, err?: Error): void {
    if (contextOrError instanceof Error) {
      this.emit('error', message, undefined, contextOrError);
    } else {
      this.emit('error', message, contextOrError, err);
    }
  }

  public debug(message: string, context?: Record<string, unknown>): void {
    this.emit('debug', message, context);
  }
}

export const logger = new Logger();
