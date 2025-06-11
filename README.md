# Arasaka CLI

A command line tool for deploying Docker applications to your TrueNAS server using the TrueNAS API.

## Features

- 🚀 **Native TrueNAS integration** using the official TrueNAS API
- 🔄 **Automatic app creation/updates** based on existing app state
- 🧹 **Clean API-based management** instead of manual Docker Compose handling
- 💚 **Health checks** to verify deployments
- 🔍 **Dry run mode** to preview deployments
- 📝 **Comprehensive logging** with timestamped output
- ⚡ **Efficient deployment** using TrueNAS's native app management

## Installation

1. Clone this repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build the project:
   ```bash
   npm run build
   ```
4. Link for global usage (optional):
   ```bash
   npm link
   ```

## Configuration

Create an `arasaka.yaml` file in your project directory:

```yaml
app:
  name: "my-web-app"
  image: "my-web-app"
  tag: "latest"
  
  # Build configuration - flexible options:
  composeFile: "docker-compose.yml"  # Optional, auto-detected if exists
  # dockerfile: "Dockerfile"         # Optional, auto-detected if exists  
  # dockerfile: "Dockerfile.prod"    # Use custom Dockerfile name
  # port: 8080                       # Optional, auto-detected from files

server:
  host: "arasaka"  # Defaults to "arasaka", can override with TRUENAS_HOST
  # user: "your-username"  # Optional, used for SSH-based operations (if needed)
  apiKey: "${TRUENAS_API_KEY}"  # Required for TrueNAS API access

deployment:
  verifyDeployment: true  # Verify app is running after deployment
  rollback:
    enabled: true
    keepVersions: 3
  cleanup:
    enabled: true
    keepImages: 3
```

### Flexible Build Configuration

The tool supports multiple ways to configure your deployment:

#### Option 1: Just a Dockerfile
If you only have a `Dockerfile`, the tool will:
- Auto-detect the `Dockerfile` 
- Extract port information from `EXPOSE` directives
- Use default configuration for the rest

#### Option 2: Just a docker-compose.yml
If you only have a `docker-compose.yml`, the tool will:
- Auto-detect the `docker-compose.yml`
- Extract port mappings, volumes, and other configuration
- Use the image specified in your config for building

#### Option 3: Both files
If you have both files, the tool will:
- Use the `Dockerfile` for building the image
- Use `docker-compose.yml` for extracting deployment configuration
- docker-compose.yml settings take precedence for port mapping

#### Option 4: Custom paths
You can specify custom paths:
```yaml
app:
  dockerfile: "docker/Dockerfile.production"
  composeFile: "deploy/docker-compose.prod.yml"
```

#### Auto-detection
The tool automatically detects:
- `Dockerfile` in the current directory
- `docker-compose.yml` in the current directory  
- Port numbers from `EXPOSE` directives in Dockerfile
- Port mappings from docker-compose.yml
- Volume mounts from docker-compose.yml

### Environment Variables

You **must** set the TrueNAS API key:

```bash
export TRUENAS_API_KEY="your-api-key"     # Required for API authentication
export TRUENAS_HOST="your-truenas-ip"     # Override server.host (optional)
export TRUENAS_USER="admin"               # Override server.user (optional)
```

### TrueNAS API Key Setup

1. Log into your TrueNAS web interface
2. Go to **System** → **API Keys**
3. Click **Add** to create a new API key
4. Give it a descriptive name like "Arasaka CLI"
5. Copy the generated API key and set it as `TRUENAS_API_KEY`

## Usage

### Deploy Application

```bash
# Deploy using default config (arasaka.yaml)
arasaka deploy

# Deploy with custom config file
arasaka deploy -c my-config.yaml

# Deploy with specific image tag
arasaka deploy -t v1.2.3

# Dry run (preview what would be deployed)
arasaka deploy --dry-run
```

### Command Options

- `-c, --config <file>`: Configuration file (default: arasaka.yaml)
- `-t, --tag <tag>`: Override image tag (default: from config)
- `--dry-run`: Show what would be deployed without actually deploying

## Deployment Process

The tool performs these steps:

1. **Validation**: Checks local requirements (Docker) and TrueNAS API connectivity
2. **Build**: Builds the Docker image locally
3. **Query**: Checks if the app already exists in TrueNAS
4. **Deploy**: Creates a new app or updates existing app using TrueNAS API
5. **Verify**: Checks app status and optionally performs health checks

## How It Works

This tool uses the [TrueNAS API](https://api.truenas.com/v25.10.0/api_methods_app.query.html) to manage applications:

- **app.query**: Check if an app with the given name exists
- **app.create**: Create new applications
- **app.update**: Update existing applications

This is much cleaner than manually managing Docker Compose files and provides better integration with TrueNAS's native app management system.

## Troubleshooting

### API Authentication Issues

If you get API authentication errors:

1. Verify your API key is correct: `echo $TRUENAS_API_KEY`
2. Check that the API key has sufficient permissions
3. Test manual API access: `curl -H "Authorization: Bearer $TRUENAS_API_KEY" https://arasaka/api/v2.0/system/info`

### Docker Build Failures

- Ensure you have a valid `Dockerfile` in the current directory
- Check Docker is running locally: `docker info`

### App Creation/Update Failures

- Check the TrueNAS logs for detailed error messages
- Verify your docker-compose.yml is valid
- Ensure the TrueNAS server has enough resources

### Enable Debug Logging

```bash
DEBUG=1 arasaka deploy
```

## Development

### Run in Development Mode

```bash
npm run dev deploy --dry-run
```

### Build

```bash
npm run build
```

## License

MIT 