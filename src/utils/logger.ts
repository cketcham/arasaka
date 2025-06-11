import chalk from 'chalk';

export class Logger {
  private static formatTime(): string {
    return new Date().toLocaleTimeString('en-US', { hour12: false });
  }

  static info(message: string): void {
    console.log(chalk.blue(`[${this.formatTime()}] INFO: ${message}`));
  }

  static error(message: string): void {
    console.error(chalk.red(`[${this.formatTime()}] ERROR: ${message}`));
  }

  static success(message: string): void {
    console.log(chalk.green(`[${this.formatTime()}] SUCCESS: ${message}`));
  }

  static warn(message: string): void {
    console.warn(chalk.yellow(`[${this.formatTime()}] WARN: ${message}`));
  }

  static debug(message: string): void {
    if (process.env.DEBUG) {
      console.log(chalk.gray(`[${this.formatTime()}] DEBUG: ${message}`));
    }
  }
} 