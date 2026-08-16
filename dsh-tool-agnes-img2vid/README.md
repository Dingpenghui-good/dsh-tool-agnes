# DSH Plugin: Agnes AI Image-to-Video

DeepSeek Harness plugin for Agnes AI image-to-video generation.

## Features

- Generate videos from images using Agnes AI
- Integrated as a Cordis plugin for DSH
- Async generation with automatic polling

## Installation

```bash
cd projects/dsh-tool-agnes-img2vid
npm install
```

## Usage in DSH

Add to your agent preset's `agent.cordis.yml`:

```yaml
- id: tool-agnes-img2vid
  name: '@dsh-plugins/agnes-img2vid'
```

## API Key Configuration

The plugin reads the API key from:
1. Environment variable `AGNES_API_KEY`
2. `$DSH_HOME/.credentials.yaml` under `AGNES_API_KEY`

## License

MIT
