/**
 * Agnes AI image generation tool plugin for DeepSeek Harness.
 * Integrates agnes-image-2.1-flash model for text-to-image generation.
 *
 * Two tools are registered:
 *  - generate_image:        full tool — downloads image, saves to attachment store,
 *                           renders [text, image] ContentBlock pair; for subagents
 *                           also calls exec.deferContext so the image appears in
 *                           the parent conversation.
 *  - generate_image_simple: internal helper — same API call but returns plain JSON
 *                           (no attachment persistence, no deferContext).
 * @module @deepseek-ai/dsh-tool-agnes-image
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { detectImage } from '@deepseek-ai/dsh-attachment-local'
import { readCredential } from './credential.ts'
import type { AgnesImageResponse } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-agnes-image'

/** Services required by the image generation plugin. */
export const inject = ['tools'] as const

const BASE_URL = 'https://apihub.agnes-ai.com/v1'
const MODEL = 'agnes-image-2.1-flash'

type GenerateImageArgs = {
  prompt: string
  size: '1K' | '2K' | '3K' | '4K'
  ratio: '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | '3:2' | '2:3'
  format: 'url' | 'b64_json'
}

interface GenerateImageValue {
  url: string
  text: string
  attachment: ImageAttachmentRef
}

interface GenerateImageSimpleValue {
  url: string
  text: string
}

function formatOutputText(args: GenerateImageArgs, response: AgnesImageResponse): string {
  const data = response.data?.[0] ?? null
  const b64 = data?.b64_json ?? null
  const url = data?.url ?? null
  return [
    '**图像已生成**',
    `- **模型**: ${MODEL}`,
    `- **提示词**: ${args.prompt.slice(0, 100)}${args.prompt.length > 100 ? '...' : ''}`,
    data?.size ? `- **分辨率**: ${data.size}` : null,
    data?.width && data?.height ? `- **尺寸**: ${data.width} x ${data.height}` : null,
    data?.ratio ? `- **宽高比**: ${data.ratio}` : null,
    url ? `- **链接**: ${url}` : null,
    b64 ? `- **Base64**: (已截断，长度=${b64.length})` : null,
    response.usage ? `- **Token 消耗**: ${JSON.stringify(response.usage)}` : null,
  ].filter(Boolean).join('\n')
}

/**
 * Render function shared by both tools.
 * Returns [text, image] for the main tool, [text] for the simple variant.
 */
function renderGenerateImage(_args: GenerateImageArgs, value: GenerateImageValue | GenerateImageSimpleValue): ContentBlock[] {
  const typed = value as GenerateImageValue
  if (!(typed.attachment !== undefined)) {
    return [{ type: 'text', text: (value as GenerateImageSimpleValue).text }]
  }
  return [
    { type: 'text', text: typed.text },
    { type: 'image', attachment: typed.attachment },
  ]
}

/** Persist image bytes to the attachment store and return the reference. */
async function saveImageFromUrl(ctx: Context, imageUrl: string, prompt: string): Promise<ImageAttachmentRef> {
  const res = await fetch(imageUrl)
  if (!res.ok) throw new Error(`failed to fetch generated image: HTTP ${res.status}`)
  const buffer = Buffer.from(await res.arrayBuffer())
  const data = new Uint8Array(buffer)

  const imageInfo = await detectImage(data)
  const mediaType: ImageMediaType = imageInfo.mediaType

  const attachments = ctx.get('attachments')
  if (attachments === undefined) {
    throw new Error('attachment service not available — cannot persist generated image')
  }

  const ref = await attachments.saveImage({
    data,
    mediaType,
    name: `agnes-image-${prompt.slice(0, 20)}.png`,
  })
  return ref
}

/** Plugin entry point: register tools into the given context. */
export function apply(ctx: Context): void {
  // ──────────────────────────────────────────────
  // Main tool: generate_image
  //   Downloads image → persists to attachment store
  //   Returns { url, text, attachment }
  //   render() → [text, image] ContentBlock pair (inline preview in conversation)
  //   deferContext() → injects image block for subagent → parent propagation
  // ──────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'generate_image',
    description: `调用 Agnes AI 图像生成模型生成图像。
返回生成图像的 URL，并将图像以内联预览形式嵌入对话。
适用于：角色立绘、场景概念图、UI 原型、产品插图等所有图像生成需求。
模型: ${MODEL}`,
    parameters: {
      prompt: { type: 'string', required: true, description: '图像生成提示词，使用英文效果最佳' },
      size:   { type: 'string', enum: ['1K', '2K', '3K', '4K'], default: '1K', description: '图像分辨率档位：1K / 2K / 3K / 4K' },
      ratio:  { type: 'string', enum: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'], default: '1:1', description: '宽高比：1:1 | 16:9 | 9:16 | 4:3 | 3:4 | 3:2 | 2:3' },
      format: { type: 'string', enum: ['url', 'b64_json'], default: 'url', description: '返回格式：url 或 b64_json' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url:         { type: 'string', required: true, description: '生成图像的 HTTP URL' },
          attachment: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              attachmentId: { type: 'string', required: true, description: '图像存储 ID' },
              mediaType:    { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true, description: '媒体类型' },
              bytes:        { type: 'integer', required: true, description: '编码字节数' },
              width:        { type: 'integer', required: true, description: '图片宽度（像素）' },
              height:       { type: 'integer', required: true, description: '图片高度（像素）' },
            },
          },
          text: { type: 'string', required: true, description: '结构化的图像生成摘要（模型可见）' },
        },
      },
      render: renderGenerateImage,
    },
    async execute(args, exec) {
      const apiKey = await readCredential(ctx)
      const typedArgs = args as GenerateImageArgs

      const body = {
        model: MODEL,
        prompt: typedArgs.prompt,
        size: typedArgs.size,
        ratio: typedArgs.ratio,
        format: typedArgs.format,
        stream: false,
      }

      const resp = await fetch(`${BASE_URL}/images/generations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: exec.signal,
      })

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '')
        throw new Error(`Agnes image API error ${resp.status}: ${errText || resp.statusText}`)
      }

      const data = (await resp.json()) as AgnesImageResponse
      const imageData = data.data?.[0] ?? null
      if (!imageData) throw new Error('No image data returned from Agnes API')

      const url = imageData.url ?? ''
      const text = formatOutputText(typedArgs, data)

      // Save to attachment store for inline preview in the conversation UI
      let attachment: ImageAttachmentRef | undefined
      if (url) {
        try {
          attachment = await saveImageFromUrl(ctx, url, typedArgs.prompt)
        } catch (err) {
          console.warn('[agnes-image] Failed to persist image to attachment store:', err)
        }
      }

      const value: GenerateImageValue = {
        url,
        text,
        attachment: attachment!,
      }

      // Inject image block into conversation so subagents propagating results
      // to their parent also surface the image inline.
      if (exec.parent !== undefined && attachment !== undefined) {
        exec.deferContext(createUserMessage({
          content: renderGenerateImage(typedArgs, value),
          source: { kind: 'plugin', plugin: 'tool-agnes-image' },
        }))
      }

      return value
    },
  }))

  // ──────────────────────────────────────────────
  // Internal helper: generate_image_simple
  //   Same API call but returns plain JSON (no attachment persistence,
  //   no deferContext). Used as a fallback when generate_image is unavailable.
  // ──────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'generate_image_simple',
    description: `【内部辅助工具】调用 Agnes AI 生成图像并仅返回 JSON 结果，不持久化到对话附件。
当 generate_image 工具不可用时使用此工具。
模型: ${MODEL}`,
    parameters: {
      prompt: { type: 'string', required: true, description: '图像生成提示词，使用英文效果最佳' },
      size:   { type: 'string', enum: ['1K', '2K', '3K', '4K'], default: '1K', description: '图像分辨率档位：1K / 2K / 3K / 4K' },
      ratio:  { type: 'string', enum: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'], default: '1:1', description: '宽高比：1:1 | 16:9 | 9:16 | 4:3 | 3:4 | 3:2 | 2:3' },
      format: { type: 'string', enum: ['url', 'b64_json'], default: 'url', description: '返回格式：url 或 b64_json' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url:  { type: 'string', required: true, description: '生成图像的 HTTP URL' },
          text: { type: 'string', required: true, description: '图像生成结果摘要' },
        },
      },
      render: renderGenerateImage,
    },
    async execute(args, exec) {
      const apiKey = await readCredential(ctx)
      const typedArgs = args as GenerateImageArgs

      const body = {
        model: MODEL,
        prompt: typedArgs.prompt,
        size: typedArgs.size,
        ratio: typedArgs.ratio,
        format: typedArgs.format,
        stream: false,
      }

      const resp = await fetch(`${BASE_URL}/images/generations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: exec.signal,
      })

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '')
        throw new Error(`Agnes image API error ${resp.status}: ${errText || resp.statusText}`)
      }

      const data = (await resp.json()) as AgnesImageResponse
      const imageData = data.data?.[0] ?? null
      if (!imageData) throw new Error('No image data returned from Agnes API')

      const url = imageData.url ?? ''
      const text = formatOutputText(typedArgs, data)

      return { url, text } as GenerateImageSimpleValue
    },
  }))
}
