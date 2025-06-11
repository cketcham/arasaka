export interface ArasakaConfig {
  app: {
    name: string;
    image: string;
    tag?: string;
    composeFile?: string;
    dockerfile?: string;
    port?: number;  // Default port if not specified in compose/docker files
  };
  server: {
    host: string;
    user: string;
    apiKey?: string;
  };
  deployment: {
    rollback?: {
      enabled: boolean;
      keepVersions?: number;
    };
    cleanup?: {
      enabled: boolean;
      keepImages?: number;
    };
    verifyDeployment?: boolean;  // Whether to verify the app is running after deployment
  };
}

export interface DeploymentOptions {
  config: string;
  tag?: string;
  dryRun?: boolean;
} 