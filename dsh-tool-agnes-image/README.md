# DSH Plugin: Agnes AI Image Generation

DeepSeek Harness plugin for Agnes AI text-to-image generation.

## Features

- Generate images using Agnes AI's `agnes-image-2.1-flash` model
- Integrated as a Cordis plugin for DSH
- Tool registration: `generate_image` and `generate_image_simple`

## Installation

```bash
cd projects/dsh-tool-agnes-image
npm install
```

## Usage in DSH

Add to your agent preset's `agent.cordis.yml`:

```yaml
- id: tool-agnes-image
  name: '@dsh-plugins/agnes-image'
```

## API Key Configuration

The plugin reads the API key from:
1. Environment variable `AGNES_API_KEY`
2. `$DSH_HOME/.credentials.yaml` under `AGNES_API_KEY`

## License

MIT
