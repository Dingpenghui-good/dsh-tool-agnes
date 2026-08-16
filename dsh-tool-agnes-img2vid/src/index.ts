/**
 * Agnes AI image-to-video generation tool plugin for DeepSeek Harness.
 * Integrates agnes-video-v2.0 model for image-to-video animation.
 *
 * Registers one tool:
 *  - generate_img2vid: POST to /v1/videos with an image URL, then polls
 *                      until completion. Returns video URL and structured result.
 * @module @deepseek-ai/dsh-tool-agnes-img2vid
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readCredential } from './credential.ts'
import type { AgnesVideoCreateResponse, AgnesVideoPollResponse, VideoTaskStatus } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-agnes-img2vid'

/** Services required by the image-to-video generation plugin. */
export const inject = ['tools'] as const

const BASE_URL = 'https://apihub.agnes-ai.com/v1'
const POLL_BASE = 'https://apihub.agnes-ai.com'

const DEFAULT_POLL_INTERVAL_MS = 5000
const DEFAULT_TIMEOUT_MS = 300000 // 5 minutes

type GenerateImg2VidArgs = {
  imageUrl: string
  prompt?: string
  duration: number
  width: number
  height: number
  frameRate: number
  seed?: number
  negativePrompt?: string
}

interface GenerateImg2VidValue {
  taskId: string
  status: VideoTaskStatus
  videoUrl?: string
  imageUrl: string
  prompt?: string
  width: number
  height: number
  duration: number
  frameRate: number
  progress?: number
  errorMessage?: string
}

/** Render a human-readable image-to-video generation result */
function renderImg2VidResult(result: GenerateImg2VidValue): string {
  if (result.status === 'completed' && result.videoUrl) {
    return [
      '**图生视频已生成**',
      `- **任务ID**: ${result.taskId}`,
      `- **原图**: ${result.imageUrl}`,
      result.prompt ? `- **提示词**: ${result.prompt}` : null,
      `- **分辨率**: ${result.width}x${result.height}@${result.frameRate}fps`,
      `- **时长**: ~${result.duration}s`,
      `- **链接**: ${result.videoUrl}`,
    ].filter(Boolean).join('\n')
  }
  if (result.status === 'failed') {
    return `图生视频生成失败: ${result.errorMessage || '未知错误'}\n\n任务ID: ${result.taskId}\n原图: ${result.imageUrl}`
  }
  return `图生视频中...\n任务ID: ${result.taskId}\n状态: ${result.status}${result.progress !== undefined ? `, 进度: ${result.progress}%` : ''}`
}

/** Calculate num_frames following the 8n+1 rule, capped at 441. */
function calculateNumFrames(durationSeconds: number, frameRate: number): number {
  const target = Math.floor(durationSeconds * frameRate)
  const n = Math.floor((target - 1) / 8)
  return Math.max(8 * n + 1, 1)
}

/** Plugin entry point: register tools into the given context. */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'generate_img2vid',
    description: `调用 Agnes AI 视频生成模型，根据输入图片生成动态视频。
支持文字提示增强画面语义，返回视频 URL 和结构化结果摘要。
适用于：照片动效、产品演示动画、概念可视化等图生视频需求。
模型: agnes-video-v2.0`,
    parameters: {
      imageUrl:     { type: 'string', required: true, description: '输入图片的 HTTP/HTTPS URL（必填）' },
      prompt:       { type: 'string', description: '视频生成提示词，用于增强语义（英文效果最佳，可选）' },
      duration:     { type: 'integer', default: 8, description: '视频时长（秒，默认8）' },
      width:        { type: 'integer', default: 1920, description: '视频宽度（像素，默认1920）' },
      height:       { type: 'integer', default: 1080, description: '视频高度（像素，默认1080）' },
      frameRate:    { type: 'integer', default: 24, description: '帧率（fps，默认24）' },
      seed:         { type: 'integer', description: '随机种子，用于可复现结果' },
      negativePrompt: { type: 'string', description: '负向提示词' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId:       { type: 'string', required: true, description: '视频生成任务ID' },
          status:       { type: 'string', enum: ['queued', 'processing', 'completed', 'failed'], required: true, description: '任务状态' },
          videoUrl:     { type: 'string', description: '视频完成后的下载地址' },
          imageUrl:     { type: 'string', required: true, description: '输入的原图 URL' },
          prompt:       { type: 'string', description: '原始提示词' },
          width:        { type: 'integer', description: '视频宽度' },
          height:       { type: 'integer', description: '视频高度' },
          duration:     { type: 'integer', description: '视频时长（秒）' },
          frameRate:    { type: 'integer', description: '帧率' },
          progress:     { type: 'integer', description: '当前进度百分比' },
          errorMessage: { type: 'string', description: '失败原因' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderImg2VidResult(value as GenerateImg2VidValue) }],
    },
    async execute(args, exec) {
      const typedArgs = args as GenerateImg2VidArgs
      const apiKey = await readCredential(ctx)
      const numFrames = calculateNumFrames(typedArgs.duration, typedArgs.frameRate)

      // ── Step 1: Create task ────────────────────────────────────────────
      const createBody: Record<string, unknown> = {
        model: 'agnes-video-v2.0',
        image: typedArgs.imageUrl,
        width: typedArgs.width,
        height: typedArgs.height,
        num_frames: numFrames,
        frame_rate: typedArgs.frameRate,
      }
      if (typedArgs.prompt) createBody.prompt = typedArgs.prompt
      if (typedArgs.seed !== undefined) createBody.seed = typedArgs.seed
      if (typedArgs.negativePrompt) createBody.negative_prompt = typedArgs.negativePrompt

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
        if (exec.signal.aborted) throw new DOMException('Image-to-video generation aborted', 'AbortError')
        if (Date.now() - pollStart > DEFAULT_TIMEOUT_MS) {
          throw new Error(`Image-to-video generation timed out after ${DEFAULT_TIMEOUT_MS / 1000}s for task ${taskId}`)
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

      const value: GenerateImg2VidValue = {
        taskId,
        status,
        imageUrl: typedArgs.imageUrl,
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
          content: [{ type: 'text', text: renderImg2VidResult(value) }],
          source: { kind: 'plugin', plugin: 'tool-agnes-img2vid' },
        }))
      }

      return value
    },
  }))
}
