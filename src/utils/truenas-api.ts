import * as WS from 'ws';
import https from 'https';
import { Logger } from './logger.js';

export interface TrueNASApp {
  id: string;
  name: string;
  state: 'CRASHED' | 'DEPLOYING' | 'RUNNING' | 'STOPPED' | 'STOPPING';
  upgrade_available?: boolean;
  image_updates_available?: boolean;
  custom_app?: boolean;
  version?: string;
  human_version?: string;
  config?: any;
  metadata?: any;
  active_workloads?: any;
}

export interface AppCreateRequest {
  app_name: string;
  custom_app: boolean;
  values: any;
  custom_compose_config?: any;
  custom_compose_config_string?: string;
}

interface DDPMessage {
  msg: string;
  id?: string;
  method?: string;
  params?: any[];
  result?: any;
  error?: any;
  session?: string;
}

export class TrueNASAPIClient {
  private host: string;
  private apiKey: string;
  private ws: WS.WebSocket | null = null;
  private messageId = 0;
  private pendingRequests = new Map<string, {resolve: Function, reject: Function}>();
  private authenticated = false;

  constructor(host: string, apiKey: string) {
    this.host = host;
    this.apiKey = apiKey;
  }

  private generateId(): string {
    return `req_${++this.messageId}_${Date.now()}`;
  }

  private async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WS.WebSocket.OPEN) {
      return;
    }

    return new Promise((resolve, reject) => {
      const wsUrl = `wss://${this.host}/websocket`;
      Logger.info(`Connecting to TrueNAS WebSocket: ${wsUrl}`);
      
      this.ws = new WS.WebSocket(wsUrl, {
        rejectUnauthorized: false // Allow self-signed certificates
      });

      this.ws.on('open', () => {
        Logger.debug('WebSocket connected, sending connect message');
        this.send({
          msg: 'connect',
          version: '1',
          support: ['1']
        });
      });

      this.ws.on('message', (data: WS.Data) => {
        try {
          const message: DDPMessage = JSON.parse(data.toString());
          this.handleMessage(message, resolve, reject);
        } catch (error: any) {
          Logger.error(`Failed to parse WebSocket message: ${error}`);
        }
      });

      this.ws.on('error', (error: any) => {
        Logger.error(`WebSocket error: ${error}`);
        reject(error);
      });

      this.ws.on('close', () => {
        Logger.debug('WebSocket closed');
        this.authenticated = false;
      });
    });
  }

  private handleMessage(message: DDPMessage, connectResolve?: Function, connectReject?: Function): void {
    Logger.debug(`Received message: ${JSON.stringify(message)}`);

    switch (message.msg) {
      case 'connected':
        Logger.success('WebSocket connected successfully');
        if (connectResolve) connectResolve();
        break;
        
      case 'failed':
        Logger.error('WebSocket connection failed');
        if (connectReject) connectReject(new Error('WebSocket connection failed'));
        break;
        
      case 'result':
        if (message.id && this.pendingRequests.has(message.id)) {
          const request = this.pendingRequests.get(message.id)!;
          this.pendingRequests.delete(message.id);
          request.resolve(message.result);
        }
        break;
        
      case 'error':
        if (message.id && this.pendingRequests.has(message.id)) {
          const request = this.pendingRequests.get(message.id)!;
          this.pendingRequests.delete(message.id);
          request.reject(new Error(message.error || 'Unknown error'));
        }
        break;
    }
  }

  private send(message: any): void {
    if (!this.ws || this.ws.readyState !== WS.WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }
    Logger.debug(`Sending message: ${JSON.stringify(message)}`);
    this.ws.send(JSON.stringify(message));
  }

  private async callMethod(method: string, params: any[] = []): Promise<any> {
    await this.connect();
    await this.authenticate();

    return new Promise((resolve, reject) => {
      const id = this.generateId();
      this.pendingRequests.set(id, { resolve, reject });

      this.send({
        id,
        msg: 'method',
        method,
        params
      });

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Method ${method} timed out`));
        }
      }, 30000);
    });
  }

  private async authenticate(): Promise<void> {
    if (this.authenticated) {
      return;
    }

    Logger.info('Authenticating with API key');
    
    try {
      // Use auth.login_with_api_key method for API key authentication
      const result = await this.callMethodNoAuth('auth.login_with_api_key', [this.apiKey]);
      this.authenticated = true;
      Logger.success('Authentication successful');
    } catch (error) {
      Logger.error(`Authentication failed: ${error}`);
      throw error;
    }
  }

  private async callMethodNoAuth(method: string, params: any[] = []): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.generateId();
      this.pendingRequests.set(id, { resolve, reject });

      this.send({
        id,
        msg: 'method',
        method,
        params
      });

      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Method ${method} timed out`));
        }
      }, 30000);
    });
  }

  async testConnection(): Promise<boolean> {
    try {
      const result = await this.callMethod('system.info');
      Logger.success(`Connected to TrueNAS ${result.version}`);
      return true;
    } catch (error) {
      Logger.error(`Connection test failed: ${error}`);
      return false;
    }
  }

  async getAppByName(appName: string): Promise<TrueNASApp | null> {
    try {
      Logger.info(`Getting app by name: ${appName}`);
      const result = await this.callMethod('app.get_instance', [appName]);
      return result;
    } catch (error) {
      Logger.warn(`Could not get app '${appName}': ${(error as Error).message}`);
      return null;
    }
  }

  async createApp(appData: AppCreateRequest): Promise<any> {
    Logger.info(`Creating app: ${appData.app_name}`);
    
    try {
      // app.create returns a job ID
      const jobId = await this.callMethod('app.create', [appData]);
      Logger.info(`App creation job started: ${jobId}`);
      
      // Wait for job completion
      const result = await this.waitForJob(jobId);
      Logger.success(`App '${appData.app_name}' created successfully`);
      return result;
    } catch (error) {
      Logger.error(`Failed to create app: ${error}`);
      throw error;
    }
  }

  private async waitForJob(jobId: number): Promise<any> {
    Logger.info(`Waiting for job ${jobId} to complete...`);
    
    while (true) {
      try {
        const jobs = await this.callMethod('core.get_jobs', [[['id', '=', jobId]]]);
        
        if (jobs.length === 0) {
          throw new Error(`Job ${jobId} not found`);
        }
        
        const job = jobs[0];
        Logger.debug(`Job ${jobId} state: ${job.state}, progress: ${job.progress?.percent || 0}%`);
        
        if (job.state === 'SUCCESS') {
          Logger.success(`Job ${jobId} completed successfully`);
          return job.result;
        } else if (job.state === 'FAILED') {
          throw new Error(`Job ${jobId} failed: ${job.error || 'Unknown error'}`);
        }
        
        // Wait 2 seconds before checking again
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        Logger.error(`Error checking job status: ${error}`);
        throw error;
      }
    }
  }

  async updateApp(appName: string, updateData: any): Promise<any> {
    Logger.info(`Updating app: ${appName}`);
    
    try {
      // app.update returns a job ID
      const jobId = await this.callMethod('app.update', [appName, updateData]);
      Logger.info(`App update job started: ${jobId}`);
      
      // Wait for job completion
      const result = await this.waitForJob(jobId);
      Logger.success(`App '${appName}' updated successfully`);
      return result;
    } catch (error) {
      Logger.error(`Failed to update app: ${error}`);
      throw error;
    }
  }

  async startApp(appId: string): Promise<any> {
    Logger.info(`Starting app: ${appId}`);
    return await this.callMethod('app.start', [appId]);
  }

  async stopApp(appId: string): Promise<any> {
    Logger.info(`Stopping app: ${appId}`);
    return await this.callMethod('app.stop', [appId]);
  }

  async getAppStatus(appId: string): Promise<TrueNASApp> {
    return await this.callMethod('app.get_instance', [appId]);
  }

  async pullImages(appName: string, redeploy: boolean = true): Promise<any> {
    Logger.info(`Pulling images for app: ${appName}`);
    
    try {
      // app.pull_images returns a job ID
      const jobId = await this.callMethod('app.pull_images', [appName, { redeploy }]);
      Logger.info(`Image pull job started: ${jobId}`);
      
      // Wait for job completion
      const result = await this.waitForJob(jobId);
      Logger.success(`Images pulled successfully for app '${appName}'`);
      return result;
    } catch (error) {
      Logger.error(`Failed to pull images: ${error}`);
      throw error;
    }
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.authenticated = false;
    this.pendingRequests.clear();
  }
} 