import fs from 'fs';
import path from 'path';
import { DeploymentOptions, ArasakaConfig } from '../types/config.js';
import { ConfigManager } from '../utils/config.js';
import { Logger } from '../utils/logger.js';
import { CommandExecutor } from '../utils/executor.js';
import { TrueNASAPIClient, AppCreateRequest, TrueNASApp } from '../utils/truenas-api.js';

export async function deployCommand(options: DeploymentOptions): Promise<void> {
  try {
    Logger.info('Starting Arasaka deployment');
    
    // Load and validate configuration
    const config = ConfigManager.loadConfig(options.config);
    const resolvedConfig = ConfigManager.resolveEnvironmentVariables(config);
    
    // Override tag if provided via CLI
    if (options.tag) {
      resolvedConfig.app.tag = options.tag;
    }

    const deployer = new Deployer(resolvedConfig, options);
    await deployer.deploy();
    
    Logger.success('Deployment completed successfully');
  } catch (error) {
    Logger.error(`Deployment failed: ${error}`);
    process.exit(1);
  }
}

class Deployer {
  private config: ArasakaConfig;
  private options: DeploymentOptions;
  private apiClient: TrueNASAPIClient;

  constructor(config: ArasakaConfig, options: DeploymentOptions) {
    this.config = config;
    this.options = options;
    
    if (!config.server.apiKey) {
      throw new Error('API key is required for TrueNAS API access. Please set TRUENAS_API_KEY environment variable or add apiKey to config.');
    }
    
    this.apiClient = new TrueNASAPIClient(
      config.server.host,
      config.server.apiKey
    );
  }

  async deploy(): Promise<void> {
    const { app } = this.config;
    const imageTag = `${app.image}:${app.tag}`;
    
    Logger.info(`Deploying ${app.name} with image ${imageTag}`);

    if (this.options.dryRun) {
      await this.dryRunDeploy();
      return;
    }

    await this.validateEnvironment();
    await this.buildAndPushImage();
    
    // Check if app exists
    const existingApp = await this.apiClient.getAppByName(app.name);
    
    if (existingApp) {
      Logger.info(`App '${app.name}' exists, updating...`);
      await this.updateApp(existingApp);
    } else {
      Logger.info(`App '${app.name}' does not exist, creating...`);
      await this.createApp();
    }
    
    await this.verifyDeployment();
  }

  private async dryRunDeploy(): Promise<void> {
    const { app } = this.config;
    Logger.info('DRY RUN - Would perform the following actions:');
    Logger.info(`  - Build image: ${app.image}:${app.tag}`);
    Logger.info(`  - Connect to TrueNAS API: ${this.config.server.host}`);
    Logger.info(`  - Check if app '${app.name}' exists`);
    Logger.info(`  - Create or update app accordingly`);
    Logger.info(`  - Verify deployment: ${this.config.deployment.verifyDeployment ? 'enabled' : 'disabled'}`);
  }

  private async validateEnvironment(): Promise<void> {
    Logger.info('Validating environment');

    // Check local requirements
    const checks = [
      { command: 'docker', description: 'Docker' }
    ];

    for (const check of checks) {
      const result = await CommandExecutor.execute('which', [check.command]);
      if (!result.success) {
        throw new Error(`${check.description} not found in PATH`);
      }
    }

    // Test API connectivity
    Logger.info('Testing TrueNAS API connectivity');
    const apiConnected = await this.apiClient.testConnection();
    if (!apiConnected) {
      throw new Error('Failed to connect to TrueNAS API. Please check your API key and network connectivity.');
    }

    Logger.info('Environment validation completed');
  }

  private async buildAndPushImage(): Promise<void> {
    const { app } = this.config;
    const imageTag = `${app.image}:${app.tag}`;
    const dockerfilePath = app.dockerfile || 'Dockerfile';
    
    Logger.info(`Building image: ${imageTag} using ${dockerfilePath}`);

    // Build image locally using the specified or default Dockerfile
    const buildArgs = ['build', '-t', imageTag];
    
    // Add dockerfile argument if it's not the default
    if (app.dockerfile && app.dockerfile !== 'Dockerfile') {
      buildArgs.push('-f', app.dockerfile);
    }
    
    buildArgs.push('.');

    const buildResult = await CommandExecutor.executeWithOutput('docker', buildArgs);

    if (!buildResult.success) {
      throw new Error(`Docker build failed using ${dockerfilePath}`);
    }

    // Note: For TrueNAS apps, you might want to push to a registry
    // or use TrueNAS's built-in image management
    Logger.info('Image build completed');
  }

  private async createApp(): Promise<void> {
    const { app } = this.config;
    
    // Create app configuration based on docker-compose.yml if it exists
    const appConfig = await this.generateAppConfig();
    
    const createRequest: AppCreateRequest = {
      app_name: app.name,
      image: {
        repository: app.image,
        tag: app.tag || 'latest'
      },
      ...appConfig
    };

    try {
      const result = await this.apiClient.createApp(createRequest);
      Logger.success(`App '${app.name}' created successfully`);
      return result;
    } catch (error) {
      throw new Error(`Failed to create app: ${error}`);
    }
  }

  private async updateApp(existingApp: TrueNASApp): Promise<void> {
    const { app } = this.config;
    
    // Generate update configuration
    const appConfig = await this.generateAppConfig();
    
    const updateData = {
      image: {
        repository: app.image,
        tag: app.tag || 'latest'
      },
      ...appConfig
    };

    try {
      const result = await this.apiClient.updateApp(existingApp.id, updateData);
      Logger.success(`App '${app.name}' updated successfully`);
      return result;
    } catch (error) {
      throw new Error(`Failed to update app: ${error}`);
    }
  }

  private async generateAppConfig(): Promise<Partial<AppCreateRequest>> {
    const { app } = this.config;
    const config: Partial<AppCreateRequest> = {};

    // Start with default port
    let detectedPort = app.port || 8080;
    let detectedPath = '/';

    // Try to read docker-compose.yml for additional configuration
    if (app.composeFile && fs.existsSync(app.composeFile)) {
      try {
        const composeContent = fs.readFileSync(app.composeFile, 'utf8');
        Logger.debug('Found docker-compose.yml, extracting configuration...');
        
        // Extract port mappings (simplified)
        const portMatch = composeContent.match(/ports:\s*\n\s*-\s*"(\d+):(\d+)"/);
        if (portMatch) {
          detectedPort = parseInt(portMatch[1]);
          Logger.debug(`Detected port from compose file: ${detectedPort}`);
        }

        // Extract volumes (simplified)
        const volumeMatches = composeContent.match(/volumes:\s*\n((?:\s*-\s*.+\n)*)/);
        if (volumeMatches) {
          const volumeLines = volumeMatches[1].trim().split('\n');
          const hostPathVolumes = volumeLines
            .map(line => {
              const volumeMatch = line.match(/\s*-\s*(.+):(.+)/);
              if (volumeMatch) {
                return {
                  host_path: volumeMatch[1].trim(),
                  mount_path: volumeMatch[2].trim()
                };
              }
              return null;
            })
            .filter(vol => vol !== null);

          if (hostPathVolumes.length > 0) {
            config.storage = { host_path_volumes: hostPathVolumes };
            Logger.debug(`Detected ${hostPathVolumes.length} volume mounts from compose file`);
          }
        }
        
      } catch (error) {
        Logger.warn(`Could not parse docker-compose.yml: ${error}`);
      }
    }

    // Try to read Dockerfile for EXPOSE directive
    const dockerfilePath = app.dockerfile || 'Dockerfile';
    if (fs.existsSync(dockerfilePath)) {
      try {
        const dockerfileContent = fs.readFileSync(dockerfilePath, 'utf8');
        Logger.debug(`Found ${dockerfilePath}, extracting configuration...`);
        
        // Extract EXPOSE directive (only if no compose file specified port)
        const exposeMatch = dockerfileContent.match(/EXPOSE\s+(\d+)/);
        if (exposeMatch && !app.composeFile) {
          detectedPort = parseInt(exposeMatch[1]);
          Logger.debug(`Detected port from Dockerfile: ${detectedPort}`);
        }
        
      } catch (error) {
        Logger.warn(`Could not parse ${dockerfilePath}: ${error}`);
      }
    }

    // Set portal configuration
    config.portals = {
      web_portal: {
        host: '0.0.0.0',
        port: detectedPort,
        path: detectedPath
      }
    };

    // Set default networking
    config.networking = {
      dns_policy: 'ClusterFirst',
      enable_resource_limits: false
    };

    Logger.info(`Configured app with port: ${detectedPort}, path: ${detectedPath}`);
    return config;
  }

  private async verifyDeployment(): Promise<void> {
    const { app, deployment } = this.config;
    
    if (!deployment.verifyDeployment) {
      Logger.info('Deployment verification skipped');
      return;
    }
    
    Logger.info('Verifying deployment');

    try {
      const appStatus = await this.apiClient.getAppByName(app.name);
      
      if (!appStatus) {
        throw new Error('App not found after deployment');
      }

      Logger.info(`App status: ${appStatus.state}`);
      
      if (appStatus.state === 'RUNNING') {
        Logger.success('Deployment verification successful');
      } else if (appStatus.state === 'DEPLOYING') {
        Logger.info('App is still deploying, this is normal');
      } else {
        Logger.warn(`App is in ${appStatus.state} state`);
      }
      
    } catch (error) {
      throw new Error(`Failed to verify deployment: ${error}`);
    }
  }
} 