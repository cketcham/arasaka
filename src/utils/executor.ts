import { spawn, SpawnOptions } from 'child_process';
import { Logger } from './logger.js';

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
}

export class CommandExecutor {
  static async execute(
    command: string,
    args: string[] = [],
    options: SpawnOptions = {}
  ): Promise<ExecutionResult> {
    return new Promise((resolve) => {
      Logger.debug(`Executing: ${command} ${args.join(' ')}`);
      
      const process = spawn(command, args, {
        ...options,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      process.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      process.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      process.on('close', (exitCode) => {
        const result: ExecutionResult = {
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: exitCode || 0,
          success: (exitCode || 0) === 0
        };

        if (result.success) {
          Logger.debug(`Command completed successfully`);
        } else {
          Logger.debug(`Command failed with exit code ${result.exitCode}`);
        }

        resolve(result);
      });

      process.on('error', (error) => {
        Logger.error(`Failed to execute command: ${error.message}`);
        resolve({
          stdout: '',
          stderr: error.message,
          exitCode: 1,
          success: false
        });
      });
    });
  }

  static async executeWithOutput(
    command: string,
    args: string[] = [],
    options: SpawnOptions = {}
  ): Promise<ExecutionResult> {
    return new Promise((resolve) => {
      Logger.debug(`Executing with output: ${command} ${args.join(' ')}`);
      
      const process = spawn(command, args, {
        ...options,
        stdio: ['pipe', 'inherit', 'inherit']
      });

      let stdout = '';
      let stderr = '';

      process.on('close', (exitCode) => {
        const result: ExecutionResult = {
          stdout,
          stderr,
          exitCode: exitCode || 0,
          success: (exitCode || 0) === 0
        };

        resolve(result);
      });

      process.on('error', (error) => {
        Logger.error(`Failed to execute command: ${error.message}`);
        resolve({
          stdout: '',
          stderr: error.message,
          exitCode: 1,
          success: false
        });
      });
    });
  }
} 