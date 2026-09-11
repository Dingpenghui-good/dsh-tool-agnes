/**
 * Agnes AI text-to-image generation tool for DeepSeek Harness.
 *
 * Registers one model-facing tool, `generate_image`, which calls the Agnes
 * OpenAI-compatible image endpoint, persists the result as a durable
 * attachment, and renders it inline in the conversation.
 *
 * @module @dingpenghui/agnes-image
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readCredential } from '../../_core/credential.ts'
import { AGNES_BASE_URL } from '../../_core/http.ts'
import { IMAGE_MODELS, fetchImageBytes, generateImage } from '../../_core/image.ts'
import { sniffImageMediaType } from '../../_core/media.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-agnes-image'

/** Services required by the image generation plugin. */
export const inject = ['tools'] as const

/** Resolution tiers accepted by the Agnes image endpoint. */
const SIZES = ['1K', '2K', '3K', '4K'] as const

/** Aspect ratios accepted by the Agnes image endpoint. */
const RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'] as const

/** Deployment configuration for the image tool. */
export interface Config {
  /** Image model id sent to the endpoint. */
  model: string
  /** Resolution tier used when the model omits `size`. */
  defaultSize: (typeof SIZES)[number]
  /** Aspect ratio used when the model omits `ratio`. */
  defaultRatio: (typeof RATIOS)[number]
  /** Whether the generated image is persisted and rendered inline. */
  persistAttachment: boolean
  /** Whether a nested dispatch (PTC sub-call) also ferries the image outward. */
  ferryContext: boolean
  /** Per-request time budget in milliseconds. */
  timeoutMs: number
}

/** Schemastery configuration for the image tool. */
export const Config: z<Config> = z.object({
  model: z.string().default(IMAGE_MODELS[0]),
  defaultSize: z.union([...SIZES]).default('1K'),
  defaultRatio: z.union([...RATIOS]).default('1:1'),
  persistAttachment: z.boolean().default(true),
  ferryContext: z.boolean().default(true),
  timeoutMs: z.natural().default(240_000),
})

/** Model-facing argument shape of `generate_image`. */
type GenerateImageArgs = {
  prompt: string
  size?: (typeof SIZES)[number]
  ratio?: (typeof RATIOS)[number]
}

/**
 * Attachment projection. Deliberately narrow: the output schema is enforced
 * with `additionalProperties: false`, so a durable reference carrying extra
 * fields (a display name, original dimensions) would be rejected verbatim.
 */
interface AttachmentSummary {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
}

/** Canonical value of `generate_image`. */
interface GenerateImageValue {
  url?: string
  text: string
  attachment?: AttachmentSummary
}

/**
 * Project a durable attachment reference onto the always-valid summary.
 * @param ref - the reference returned by the attachment store.
 * @returns the projection declared by the tool's output schema.
 */
function summarizeAttachment(ref: ImageAttachmentRef): AttachmentSummary {
  return {
    attachmentId: String(ref.attachmentId),
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
  }
}

/**
 * Rebuild the image content block from the canonical summary.
 * @param attachment - the projected summary.
 * @returns the model/UI-facing image block.
 */
function imageBlock(attachment: AttachmentSummary): ContentBlock {
  return {
    type: 'image',
    attachment: {
      attachmentId: attachment.attachmentId,
      mediaType: attachment.mediaType,
      bytes: attachment.bytes,
      width: attachment.width,
      height: attachment.height,
    },
  } as unknown as ContentBlock
}

/**
 * Register the Agnes image tool.
 * @param ctx - plugin context.
 * @param config - resolved deployment configuration.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'generate_image',
    description: `Generate an image with the Agnes AI image model and embed the result inline in the conversation.
Use it for illustrations, character art, concept art, UI mockups, product shots, posters, and any other still-image request.
Write a specific, descriptive English prompt (subject, composition, lighting, style) rather than a short phrase.
Returns the image URL plus a durable attachment reference.

The endpoint is text-to-image only: it rejects image-to-image input and any batch size other than one.

Endpoint: ${AGNES_BASE_URL}/images/generations · model: ${config.model}`,
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'Image description. English and specific (subject, composition, lighting, style) works best.',
      },
      size: {
        type: 'string',
        enum: [...SIZES],
        default: config.defaultSize,
        description: 'Resolution tier: 1K / 2K / 3K / 4K.',
      },
      ratio: {
        type: 'string',
        enum: [...RATIOS],
        default: config.defaultRatio,
        description: 'Aspect ratio: 1:1 | 16:9 | 9:16 | 4:3 | 3:4 | 3:2 | 2:3 | 21:9.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: {
            type: 'string',
            description: 'Remote HTTP URL of the generated image.',
          },
          text: {
            type: 'string',
            required: true,
            description: 'Model-visible summary of the generation.',
          },
          attachment: {
            type: 'object',
            additionalProperties: false,
            properties: {
              attachmentId: { type: 'string', required: true, description: 'Durable attachment id.' },
              mediaType: { type: 'string', required: true, description: 'Verified media type.' },
              bytes: { type: 'integer', required: true, description: 'Encoded byte length.' },
              width: { type: 'integer', required: true, description: 'Encoded width in pixels.' },
              height: { type: 'integer', required: true, description: 'Encoded height in pixels.' },
            },
            description: 'Durable copy of the generated image, when persistence succeeded.',
          },
        },
      },
      render: (_args, value) => {
        const typed = value as GenerateImageValue
        const blocks: ContentBlock[] = [{ type: 'text', text: typed.text }]
        if (typed.attachment !== undefined) blocks.push(imageBlock(typed.attachment))
        return blocks
      },
    },
    presentCall: (args): ToolCallView => ({
      card: 'generic',
      title: `Generate image · ${args.size ?? config.defaultSize} ${args.ratio ?? config.defaultRatio}`,
      kind: 'other',
      rawInput: { prompt: args.prompt },
    }),
    presentResult: (_args, result): ToolResultView => ({
      card: 'generic',
      title: result.isError ? 'Image generation failed' : 'Image generation',
      content: result.content,
    }),
    async execute(args, exec) {
      const typed = args as GenerateImageArgs
      const apiKey = await readCredential(ctx)
      const size = typed.size ?? config.defaultSize
      const ratio = typed.ratio ?? config.defaultRatio

      const generated = await generateImage({
        apiKey,
        model: config.model,
        prompt: typed.prompt,
        size,
        ratio,
        signal: exec.signal,
        timeoutMs: config.timeoutMs,
      })

      // Persisting is best-effort. A storage failure must not fail the call:
      // the model already holds the URL it can report, and the reason is
      // surfaced in the summary instead of being logged out of reach.
      let attachment: AttachmentSummary | undefined
      let persistNote: string | undefined
      if (config.persistAttachment) {
        const attachments = ctx.get('attachments')
        if (attachments === undefined) {
          persistNote = 'the attachment service is unavailable'
        } else {
          try {
            const bytes = await fetchImageBytes(generated.image, exec.signal)
            const ref = await attachments.saveImage({
              data: bytes,
              mediaType: sniffImageMediaType(bytes),
              name: `agnes-image-${typed.prompt.slice(0, 24)}`,
            })
            attachment = summarizeAttachment(ref)
          } catch (error) {
            persistNote = error instanceof Error ? error.message : String(error)
          }
        }
      } else {
        persistNote = 'disabled by configuration'
      }

      const lines = [
        '**Image generated**',
        `- model: ${config.model}`,
        `- size: ${size} (${ratio})`,
        `- prompt: ${typed.prompt.slice(0, 120)}${typed.prompt.length > 120 ? '…' : ''}`,
        generated.image.url !== undefined ? `- url: ${generated.image.url}` : '- url: (base64 response)',
        attachment !== undefined
          ? `- attachment: attachment:${attachment.attachmentId} (${attachment.width}x${attachment.height} ${attachment.mediaType}, ${attachment.bytes} bytes)`
          : `- attachment: not persisted (${persistNote ?? 'unknown reason'})`,
        attachment !== undefined
          ? '- pass that attachment reference to generate_img2vid to animate this image'
          : null,
      ].filter((line): line is string => line !== null)

      const value: GenerateImageValue = {
        text: lines.join('\n'),
        ...(generated.image.url !== undefined ? { url: generated.image.url } : {}),
        ...(attachment !== undefined ? { attachment } : {}),
      }

      // Under PTC the model reaches this tool through a `run_code` sub-call, so
      // the image must ride the deferred context to reach the outer result.
      if (config.ferryContext && exec.parent !== undefined && attachment !== undefined) {
        exec.deferContext(createUserMessage({
          content: [{ type: 'text', text: value.text }, imageBlock(attachment)],
          source: {
            kind: 'plugin',
            plugin: name,
            form: 'notice',
            summary: `generated image: ${typed.prompt.slice(0, 80)}`,
          },
        }))
      }

      return value
    },
  }))
}
