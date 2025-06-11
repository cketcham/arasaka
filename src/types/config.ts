export interface ArasakaConfig {
  app: {
    name: string;
    tag?: string;
    composeFile?: string;
    dockerfile?: string;
    port?: number;  // Default port if not specified in compose/docker files
  };
  server: {
    host: string;
    user: string;
    apiKey: string;
  };
}
