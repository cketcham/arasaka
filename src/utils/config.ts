import fs from 'fs';
import path from 'path';
import { userInfo } from 'os';
import yaml from 'js-yaml';
import { ArasakaConfig } from '../types/config.js';
import { Logger } from './logger.js';

export class ConfigManager {
  static loadConfig(configPath: string): ArasakaConfig {
    const fullPath = path.resolve(configPath);
    
    if (!fs.existsSync(fullPath)) {
      Logger.error(`Configuration file not found: ${fullPath}`);
      process.exit(1);
    }

    try {
      const configContent = fs.readFileSync(fullPath, 'utf8');
      const config = yaml.load(configContent) as ArasakaConfig;
      
      this.validateConfig(config);
      this.setDefaults(config);
      
      return config;
    } catch (error) {
      Logger.error(`Failed to parse configuration file: ${error}`);
      process.exit(1);
    }
  }

  private static validateConfig(config: ArasakaConfig): void {
    const required = [
      'app.name',
      'app.image',
      'server.host'
    ];

    for (const field of required) {
      const value = this.getNestedValue(config, field);
      if (!value) {
        Logger.error(`Missing required configuration field: ${field}`);
        process.exit(1);
      }
    }

    // Validate that either composeFile or dockerfile exists (or can use defaults)
    const hasComposeFile = config.app.composeFile && fs.existsSync(config.app.composeFile);
    const hasDockerfile = config.app.dockerfile && fs.existsSync(config.app.dockerfile);
    const hasDefaultDockerfile = fs.existsSync('Dockerfile');
    
    if (!hasComposeFile && !hasDockerfile && !hasDefaultDockerfile) {
      Logger.error('No composeFile, dockerfile, or default Dockerfile found. At least one is required for deployment.');
      process.exit(1);
    }
  }

  private static setDefaults(config: ArasakaConfig): void {
    // Set default values
    config.app.tag = config.app.tag || 'latest';
    
    // Auto-detect files if not specified
    if (!config.app.composeFile && fs.existsSync('docker-compose.yml')) {
      config.app.composeFile = 'docker-compose.yml';
      Logger.debug('Auto-detected docker-compose.yml');
    }
    
    if (!config.app.dockerfile && fs.existsSync('Dockerfile')) {
      config.app.dockerfile = 'Dockerfile';
      Logger.debug('Auto-detected Dockerfile');
    }
    
    // Set default port if not specified
    config.app.port = config.app.port || 8080;
    
    // Set default user to current system user if not specified
    if (!config.server.user) {
      try {
        config.server.user = userInfo().username;
        Logger.debug(`Using current user as default: ${config.server.user}`);
      } catch (error) {
        Logger.warn('Could not determine current user, please specify in config');
        config.server.user = 'admin'; // fallback
      }
    }
    
    // Set deployment defaults
    config.deployment = config.deployment || {};
    config.deployment.rollback = config.deployment.rollback || { enabled: true, keepVersions: 3 };
    config.deployment.cleanup = config.deployment.cleanup || { enabled: true, keepImages: 3 };
    config.deployment.verifyDeployment = config.deployment.verifyDeployment !== false; // Default to true
  }

  private static getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }

  static resolveEnvironmentVariables(config: ArasakaConfig): ArasakaConfig {
    // Replace environment variables in config
    const configStr = JSON.stringify(config);
    const resolvedStr = configStr.replace(/\$\{([^}]+)\}/g, (match, envVar) => {
      const value = process.env[envVar];
      if (!value) {
        Logger.warn(`Environment variable ${envVar} not found, using default`);
        return match;
      }
      return value;
    });
    
    return JSON.parse(resolvedStr);
  }
} 