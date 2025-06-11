import fetch from 'node-fetch';
import { Logger } from './logger.js';

export interface TrueNASApp {
  id: string;
  name: string;
  state: 'CRASHED' | 'DEPLOYING' | 'RUNNING' | 'STOPPED' | 'STOPPING';
  upgrade_available: boolean;
  image_updates_available: boolean;
  custom_app: boolean;
  version: string;
  human_version: string;
  config?: any;
}

export interface AppCreateRequest {
  app_name: string;
  image: {
    repository: string;
    tag: string;
  };
  portals?: {
    web_portal?: {
      host: string;
      port: number;
      path?: string;
    };
  };
  networking?: {
    dns_policy?: string;
    enable_resource_limits?: boolean;
  };
  storage?: {
    host_path_volumes?: Array<{
      host_path: string;
      mount_path: string;
    }>;
  };
  resources?: {
    limits?: {
      cpus?: string;
      memory?: string;
    };
  };
}

export class TrueNASAPIClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(host: string, apiKey: string, useHttps: boolean = true) {
    const protocol = useHttps ? 'https' : 'http';
    this.baseUrl = `${protocol}://${host}/api/v2.0`;
    this.apiKey = apiKey;
  }

  private async makeRequest(method: string, endpoint: string, data?: any): Promise<any> {
    const url = `${this.baseUrl}/${endpoint}`;
    
    Logger.debug(`API ${method}: ${url}`);
    
    const options: any = {
      method,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
    };

    if (data) {
      options.body = JSON.stringify(data);
    }

    try {
      const response = await fetch(url, options);
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API request failed: ${response.status} ${response.statusText}\n${errorText}`);
      }

      const responseData = await response.json();
      return responseData;
    } catch (error) {
      Logger.error(`API request failed: ${error}`);
      throw error;
    }
  }

  async queryApps(filters?: any[]): Promise<TrueNASApp[]> {
    const queryData = {
      query_filters: filters || [],
      query_options: {}
    };

    return await this.makeRequest('POST', 'app/query', queryData);
  }

  async getAppByName(appName: string): Promise<TrueNASApp | null> {
    const apps = await this.queryApps([['name', '=', appName]]);
    return apps.length > 0 ? apps[0] : null;
  }

  async createApp(appData: AppCreateRequest): Promise<any> {
    Logger.info(`Creating app: ${appData.app_name}`);
    return await this.makeRequest('POST', 'app/create', appData);
  }

  async updateApp(appId: string, updateData: any): Promise<any> {
    Logger.info(`Updating app: ${appId}`);
    return await this.makeRequest('PUT', `app/id/${appId}`, updateData);
  }

  async startApp(appId: string): Promise<any> {
    Logger.info(`Starting app: ${appId}`);
    return await this.makeRequest('POST', `app/id/${appId}/start`);
  }

  async stopApp(appId: string): Promise<any> {
    Logger.info(`Stopping app: ${appId}`);
    return await this.makeRequest('POST', `app/id/${appId}/stop`);
  }

  async getAppStatus(appId: string): Promise<TrueNASApp> {
    return await this.makeRequest('GET', `app/id/${appId}`);
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.makeRequest('GET', 'system/info');
      return true;
    } catch (error) {
      return false;
    }
  }
} 