/**
 * Agnes AI video generation tool plugin for DeepSeek Harness.
 * Integrates agnes-video-v2.0 model for text-to-video generation.
 * @module @deepseek-ai/dsh-tool-agnes-video
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readCredential } from './credential.ts'
import type {
  AgnesVideoCreateResponse,
  AgnesVideoPollResponse,
  VideoTaskStatus,
} from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-agnes-video'

/** Services required by the video generation plugin. */
export const inject = ['tools'] as const

const BASE_URL = 'https://apihub.agnes-ai.com/v1'
const POLL_BASE = 'https://apihub.agnes-ai.com'

const DEFAULT_POLL_INTERVAL_MS = 5000
const DEFAULT_TIMEOUT_MS = 300000 // 5 minutes

type GenerateVideoArgs = {
  prompt: string
  duration: number
  width: number
  height: number
  frameRate: number
  seed?: number
  negativePrompt?: string
  imageUrl?: string
}

interface GenerateVideoValue {
  taskId: string
  status: VideoTaskStatus
  videoUrl?: string
  prompt: string
  width: number
  height: number
  duration: number
  frameRate: number
  progress?: number
  errorMessage?: string
}

/** Render a human-readable video generation result */
function renderVideoResult(result: GenerateVideoValue): string {
  if (result.status === 'completed' && result.videoUrl) {
    return [
      '**视频已生成**',
      `- **任务ID**: ${result.taskId}`,
      `- **提示词**: ${result.prompt}`,
      `- **分辨率**: ${result.width}x${result.height}@${result.frameRate}fps`,
      `- **时长**: ~${result.duration}s`,
      `- **链接**: ${result.videoUrl}`,
    ].join('\n')
  }
  if (result.status === 'failed') {
    return `视频生成失败: ${result.errorMessage || '未知错误'}\n\n任务ID: ${result.taskId}\n提示词: ${result.prompt}`
  }
  return `视频生成中...\n任务ID: ${result.taskId}\n状态: ${result.status}${result.progress !== undefined ? `, 进度: ${result.progress}%` : ''}`
}

/** Calculate num_frames following the 8n+1 rule, capped at 441. */
function calculateNumFrames(durationSeconds: number, frameRate: number): number {
  const target = Math.floor(durationSeconds * frameRate)
  const n = Math.floor((target - 1) / 8)
  return Math.max(8 * n + 1, 1)
}

/** Resolve the API key */
async function getApiKey(ctx: Context): Promise<string> {
  return readCredential(ctx)
}

/** Plugin entry point: register tools into the given context. */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'generate_video',
    description: `调用 Agnes AI 视频生成模型创建视频。
支持文生视频和图生视频，返回视频 URL 和结构化结果摘要。
适用于：动态效果演示、视频内容创作、概念可视化等需求。
模型: agnes-video-v2.0`,
    parameters: {
      prompt:         { type: 'string', required: true, description: '视频生成提示词，使用英文效果最佳' },
      duration:       { type: 'integer', default: 8, description: '视频时长（秒，默认8）' },
      width:          { type: 'integer', default: 1920, description: '视频宽度（像素，默认1920）' },
      height:         { type: 'integer', default: 1080, description: '视频高度（像素，默认1080）' },
      frameRate:      { type: 'integer', default: 24, description: '帧率（fps，默认24）' },
      seed:           { type: 'integer', description: '随机种子，用于可复现结果' },
      negativePrompt: { type: 'string', description: '负向提示词' },
      imageUrl:       { type: 'string', description: '图生视频：输入图片URL' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId:       { type: 'string', required: true, description: '视频生成任务ID' },
          status:       { type: 'string', enum: ['queued', 'processing', 'completed', 'failed'], required: true, description: '任务状态' },
          videoUrl:     { type: 'string', description: '视频完成后的下载地址' },
          prompt:       { type: 'string', required: true, description: '原始提示词' },
          width:        { type: 'integer', description: '视频宽度' },
          height:       { type: 'integer', description: '视频高度' },
          duration:     { type: 'integer', description: '视频时长（秒）' },
          frameRate:    { type: 'integer', description: '帧率' },
          progress:     { type: 'integer', description: '当前进度百分比' },
          errorMessage: { type: 'string', description: '失败原因' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderVideoResult(value as GenerateVideoValue) }],
    },
    async execute(args, exec) {
      const typedArgs = args as GenerateVideoArgs
      const apiKey = await getApiKey(ctx)
      const numFrames = calculateNumFrames(typedArgs.duration, typedArgs.frameRate)

      // ── Step 1: Create task ────────────────────────────────────────────
      const createBody: Record<string, unknown> = {
        model: 'agnes-video-v2.0',
        prompt: typedArgs.prompt,
        width: typedArgs.width,
        height: typedArgs.height,
        num_frames: numFrames,
        frame_rate: typedArgs.frameRate,
      }
      if (typedArgs.seed !== undefined) createBody.seed = typedArgs.seed
      if (typedArgs.negativePrompt) createBody.negative_prompt = typedArgs.negativePrompt
      if (typedArgs.imageUrl) createBody.image = typedArgs.imageUrl

      const createResp = await fetch(`${BASE_URL}/videos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify(createBody),
        signal: exec.signal,
      })

      if (!createResp.ok) {
        const errText = await createResp.text().catch(() => '')
        throw new Error(`Agnes video API error ${createResp.status}: ${errText || createResp.statusText}`)
      }

      const createData = (await createResp.json()) as AgnesVideoCreateResponse
      const taskId = String(createData.video_id ?? createData.task_id ?? createData.id ?? `task_${Date.now()}`)

      // ── Step 2: Poll until complete or failed ──────────────────────────
      const pollStart = Date.now()
      let status: VideoTaskStatus = 'queued'
      let progress = 0
      let videoUrl: string | undefined
      let errorMessage: string | undefined

      while (true) {
        if (exec.signal.aborted) throw new DOMException('Video generation aborted', 'AbortError')
        if (Date.now() - pollStart > DEFAULT_TIMEOUT_MS) {
          throw new Error(`Video generation timed out after ${DEFAULT_TIMEOUT_MS / 1000}s for task ${taskId}`)
        }
        await new Promise<void>(r => setTimeout(r, DEFAULT_POLL_INTERVAL_MS))

        const pollResp = await fetch(`${POLL_BASE}/agnesapi?video_id=${taskId}`, {
          headers: { 'Authorization': `Bearer ${apiKey}` },
          signal: exec.signal,
        })

        if (!pollResp.ok) throw new Error(`Poll request failed: ${pollResp.status}`)
        const pollData = (await pollResp.json()) as AgnesVideoPollResponse
        status = pollData.status
        progress = pollData.progress ?? progress
        errorMessage = typeof pollData.error === 'string'
          ? pollData.error
          : pollData.error?.message

        if (status === 'completed') {
          videoUrl = pollData.metadata?.url
          break
        }
        if (status === 'failed') break
      }

      const value: GenerateVideoValue = {
        taskId,
        status,
        prompt: typedArgs.prompt,
        width: typedArgs.width,
        height: typedArgs.height,
        duration: typedArgs.duration,
        frameRate: typedArgs.frameRate,
        ...(videoUrl !== undefined ? { videoUrl } : {}),
        ...(status !== 'completed' && progress !== undefined ? { progress } : {}),
        ...(status === 'failed' && errorMessage !== undefined ? { errorMessage } : {}),
      }

      if (exec.parent !== undefined) {
        exec.deferContext(createUserMessage({
          content: [{ type: 'text', text: renderVideoResult(value) }],
          source: { kind: 'plugin', plugin: 'tool-agnes-video' },
        }))
      }

      return value
    },
  }))
}
