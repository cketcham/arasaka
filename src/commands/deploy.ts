import fs from 'fs';
import path from 'path';
import { ArasakaConfig } from '../types/config.js';
import { ConfigManager } from '../utils/config.js';
import { Logger } from '../utils/logger.js';
import { CommandExecutor } from '../utils/executor.js';
import { TrueNASAPIClient, AppCreateRequest, TrueNASApp } from '../utils/truenas-api.js';

interface DeploymentOptions {
  config: string;
  tag?: string;
  dryRun?: boolean;
}

export async function deployCommand(options: DeploymentOptions): Promise<void> {
  let deployer: Deployer | null = null;
  
  try {
    Logger.info('Starting Arasaka deployment');
    
    // Load and validate configuration
    const config = ConfigManager.loadConfig(options.config);
    const resolvedConfig = ConfigManager.resolveEnvironmentVariables(config);
    
    // Override tag if provided via CLI
    if (options.tag) {
      resolvedConfig.app.tag = options.tag;
    }

    deployer = new Deployer(resolvedConfig, options);
    await deployer.deploy();
    
    Logger.success('Deployment completed successfully');
  } catch (error) {
    Logger.error(`Deployment failed: ${error}`);
    process.exit(1);
  } finally {
    // Cleanup WebSocket connection
    if (deployer) {
      deployer.cleanup();
    }
  }
}

class Deployer {
  private config: ArasakaConfig;
  private options: DeploymentOptions;
  private apiClient: TrueNASAPIClient;
  private actualImageName: string | null = null;

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
    
    Logger.info(`Deploying ${app.name}`);

    if (this.options.dryRun) {
      await this.dryRunDeploy();
      return;
    }

    await this.validateEnvironment();
    await this.buildAndPushImage();
    
    if (!this.actualImageName) {
      throw new Error('Image name could not be determined from Docker push output');
    }
    
    const imageTag = `${this.actualImageName}:${app.tag}`;
    Logger.info(`Using image: ${imageTag}`);
    
    // Check if app exists - if this fails, assume it doesn't exist
    let existingApp = null;
    try {
      existingApp = await this.apiClient.getAppByName(app.name);
    } catch (error) {
      Logger.warn(`Could not check if app exists: ${(error as Error).message}`);
      Logger.info('Proceeding with app creation...');
    }
    
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
    Logger.info(`  - Build and push image for app: ${app.name}`);
    Logger.info(`  - Extract actual image name from push output`);
    Logger.info(`  - Connect to TrueNAS API: ${this.config.server.host}`);
    Logger.info(`  - Check if app '${app.name}' exists`);
    Logger.info(`  - Create or update app accordingly`);
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
    const localTag = `${app.name}:${app.tag}`;
    const dockerfilePath = app.dockerfile || 'Dockerfile';
    
    Logger.info(`Building image: ${localTag} using ${dockerfilePath}`);

    // Build image locally using the specified or default Dockerfile
    const buildArgs = ['build', '-t', localTag];
    
    // Add dockerfile argument if it's not the default
    if (app.dockerfile && app.dockerfile !== 'Dockerfile') {
      buildArgs.push('-f', app.dockerfile);
    }
    
    buildArgs.push('.');

    const buildResult = await CommandExecutor.executeWithOutput('docker', buildArgs);

    if (!buildResult.success) {
      throw new Error(`Docker build failed using ${dockerfilePath}`);
    }

    Logger.info('Image build completed');

    // Get Docker Hub username
    let dockerUsername: string;
    try {
      // Try to get username from `docker info` or whoami
      const whoamiResult = await CommandExecutor.execute('whoami', []);
      if (whoamiResult.success && whoamiResult.stdout) {
        dockerUsername = whoamiResult.stdout.trim();
        Logger.debug(`Using username from whoami: ${dockerUsername}`);
      } else {
        throw new Error('Could not determine username');
      }
    } catch (error) {
      Logger.warn('Could not auto-detect username, using "user" as default');
      dockerUsername = 'user';
    }

    // Create remote tag with username
    const remoteTag = `${dockerUsername}/${app.name}:${app.tag}`;
    
    Logger.info(`Tagging image for push: ${remoteTag}`);
    const tagResult = await CommandExecutor.executeWithOutput('docker', ['tag', localTag, remoteTag]);
    
    if (!tagResult.success) {
      throw new Error(`Failed to tag image: ${localTag} -> ${remoteTag}`);
    }

    // Push image to Docker Hub
    Logger.info(`Pushing image: ${remoteTag}`);
    
    const pushResult = await CommandExecutor.executeWithOutput('docker', ['push', remoteTag]);
    
    if (!pushResult.success) {
      Logger.warn('Docker push failed. Make sure you are logged in to Docker Hub with `docker login`');
      Logger.info('You can login with: docker login');
      throw new Error('Failed to push image to registry. Please ensure you are logged in to Docker Hub and have push permissions.');
    }

    // Set the actual image name (without tag)
    this.actualImageName = `${dockerUsername}/${app.name}`;
    Logger.success(`Image pushed successfully: ${remoteTag}`);
    Logger.info(`Using image name: ${this.actualImageName}`);
  }

  private async createApp(): Promise<void> {
    const { app } = this.config;
    
    if (!this.actualImageName) {
      throw new Error('Image name not available for app creation');
    }
    
    // Create app configuration based on docker-compose.yml if it exists
    const appConfig = await this.generateAppConfig();
    
    // Convert compose config to YAML string
    const composeYaml = `version: '3.8'
services:
  ${app.name}:
    image: ${this.actualImageName}:${app.tag}
    container_name: ${app.name}
    ports:
      - "${appConfig.custom_compose_config.services[app.name].ports[0]}"
    restart: unless-stopped
    networks:
      - default
networks:
  default:
    driver: bridge
`;

    Logger.debug(`Generated Docker Compose YAML:\n${composeYaml}`);

    const createRequest: AppCreateRequest = {
      app_name: app.name,
      custom_app: true,
      values: {},
      custom_compose_config_string: composeYaml
    };

    try {
      Logger.debug(`Sending app creation request: ${JSON.stringify(createRequest, null, 2)}`);
      const result = await this.apiClient.createApp(createRequest);
      Logger.success(`App '${app.name}' created successfully`);
      return result;
    } catch (error) {
      throw new Error(`Failed to create app: ${error}`);
    }
  }

  private async updateApp(existingApp: TrueNASApp): Promise<void> {
    const { app } = this.config;
    
    if (!this.actualImageName) {
      throw new Error('Image name not available for app update');
    }
    
    // Generate update configuration similar to create, but for update
    const appConfig = await this.generateAppConfig();
    
    // For custom apps, we need to update the compose configuration
    const composeYaml = `version: '3.8'
services:
  ${app.name}:
    image: ${this.actualImageName}:${app.tag}
    container_name: ${app.name}
    ports:
      - "${appConfig.custom_compose_config.services[app.name].ports[0]}"
    restart: unless-stopped
    networks:
      - default
networks:
  default:
    driver: bridge
`;

    Logger.debug(`Generated Docker Compose YAML for update:\n${composeYaml}`);

    const updateData = {
      custom_compose_config_string: composeYaml,
      values: {}
    };

    try {
      const result = await this.apiClient.updateApp(existingApp.name, updateData);
      Logger.success(`App '${app.name}' updated successfully`);
      
      // Force pull latest images and redeploy to ensure we get the fresh version
      Logger.info('Forcing image pull to get latest version...');
      await this.apiClient.pullImages(app.name, true);
      
      return result;
    } catch (error) {
      throw new Error(`Failed to update app: ${error}`);
    }
  }

  private async generateAppConfig(): Promise<Partial<AppCreateRequest>> {
    const { app } = this.config;
    
    if (!this.actualImageName) {
      throw new Error('Image name not available for config generation');
    }

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

    // Map common system ports to safe alternatives to avoid conflicts
    let hostPort = detectedPort;
    let containerPort = detectedPort;
    
    // If the detected port is a common system port, map it to a safe host port
    const commonSystemPorts = [80, 443, 22, 21, 25, 53, 110, 143, 993, 995];
    if (commonSystemPorts.includes(detectedPort)) {
      // Map system ports to safe alternatives
      const portMapping: { [key: number]: number } = {
        80: 8080,   // HTTP
        443: 8443,  // HTTPS
        22: 2222,   // SSH
        21: 2121,   // FTP
        25: 2525,   // SMTP
        53: 5353,   // DNS
        110: 1100,  // POP3
        143: 1143,  // IMAP
        993: 9930,  // IMAPS
        995: 9950   // POP3S
      };
      
      hostPort = portMapping[detectedPort] || (detectedPort + 8000);
      containerPort = detectedPort; // Keep the original container port
      Logger.info(`Mapped system port ${containerPort} to host port ${hostPort} to avoid conflicts`);
    }

    // For TrueNAS custom apps, we need to create a Docker Compose config
    const composeConfig = {
      version: '3.8',
      services: {
        [app.name]: {
          image: `${this.actualImageName}:${app.tag}`,
          container_name: app.name,
          ports: [`${hostPort}:${containerPort}`],
          restart: 'unless-stopped',
          networks: ['default']
        }
      },
      networks: {
        default: {
          driver: 'bridge'
        }
      }
    };

    const config: Partial<AppCreateRequest> = {
      custom_app: true,
      values: {},
      custom_compose_config: composeConfig
    };

    Logger.info(`Configured custom app with host port: ${hostPort} -> container port: ${containerPort}, image: ${this.actualImageName}:${app.tag}`);
    Logger.debug(`Docker Compose config: ${JSON.stringify(composeConfig, null, 2)}`);
    return config;
  }

  private async verifyDeployment(): Promise<void> {
    const { app } = this.config;
    
    Logger.info('Verifying deployment');

    try {
      const appStatus = await this.apiClient.getAppByName(app.name);
      
      if (!appStatus) {
        Logger.warn('Unable to verify app status via API, but creation appeared successful');
        Logger.info('You can check the app status in the TrueNAS web interface');
        return;
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
      Logger.warn('Unable to verify app status via API, but creation appeared successful');
      Logger.info('You can check the app status in the TrueNAS web interface');
    }
  }

  cleanup(): void {
    this.apiClient.disconnect();
  }
} 