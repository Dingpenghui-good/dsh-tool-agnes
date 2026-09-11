/**
 * Resolve a model-supplied image reference into something Agnes can fetch.
 *
 * Agnes image-to-video needs the image available to *its* servers, which used
 * to mean "a public URL only". Probing the live gateway showed that `POST
 * /v1/videos` accepts a `data:` URL in `image` exactly like an HTTP URL, so an
 * image that only exists locally can be inlined instead. That makes three
 * source kinds usable:
 *
 *   - `https://…`            a public URL, passed through untouched
 *   - `data:image/…;base64`  already inline, passed through untouched
 *   - `attachment:<id>`      a DSH attachment, read from the attachment store
 *   - anything else          a local file path (or `file://` URL), read inline
 *
 * @module dsh-tool-agnes/core/image-source
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sniffImageMediaType, toDataUrl } from './media.ts'

/** Where a resolved image came from. */
export type ImageSourceKind = 'remote-url' | 'inline'

/** A resolved, provider-consumable image reference. */
export interface ResolvedImageSource {
  /** The value to send as the provider's `image` field. */
  value: string
  /** How it was resolved. */
  kind: ImageSourceKind
  /** Bytes inlined, when the source was local. */
  inlinedBytes?: number
  /** Human-readable origin, for the result summary. */
  origin: string
}

/** Options controlling resolution. */
export interface ResolveImageSourceOptions {
  /** Largest local image accepted before inlining is refused. */
  maxInlineBytes: number
}

/** Whether a string is an absolute HTTP(S) URL. */
function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

/**
 * Locate the DSH attachments root.
 * @returns the absolute attachments directory.
 */
function attachmentsRoot(): string {
  const home = process.env.DSH_HOME?.trim()
  return join(home !== undefined && home.length > 0 ? home : join(homedir(), '.dsh'), 'attachments')
}

/**
 * Read the bytes behind one DSH attachment id.
 *
 * The attachment service exposes no id-only reader (its `readImage` needs a
 * full reference with media type and dimensions), so the content-addressed
 * object path is derived instead. The id is the sha256 of the stored bytes,
 * and objects live under a two-character prefix directory.
 *
 * @param id - the attachment id.
 * @returns the stored image bytes.
 * @throws Error when the object is not on disk.
 */
async function readAttachmentBytes(id: string): Promise<Uint8Array> {
  if (!/^[0-9a-f]{32,128}$/i.test(id)) {
    throw new Error(`"${id}" is not a valid attachment id (expected a hex digest)`)
  }
  const path = join(attachmentsRoot(), 'v1', 'objects', id.slice(0, 2), id)
  try {
    return new Uint8Array(await readFile(path))
  } catch {
    throw new Error(
      `attachment ${id} was not found under ${attachmentsRoot()}. `
      + 'Pass a public http(s) URL, a local file path, or a data: URL instead.',
    )
  }
}

/**
 * Wrap already-obtained image bytes as an inline source.
 *
 * Shared by the local-file path and by the "image the user just pasted" path,
 * so both enforce the same size ceiling and media-type verification.
 *
 * @param bytes - the encoded image.
 * @param origin - human-readable provenance, for the result summary.
 * @param options - inlining limits.
 * @returns the value to send as the provider's `image` field.
 * @throws Error when the image is too large to inline.
 */
export function inlineImageBytes(
  bytes: Uint8Array,
  origin: string,
  options: ResolveImageSourceOptions,
): ResolvedImageSource {
  if (bytes.byteLength > options.maxInlineBytes) {
    throw new Error(
      `the image at ${origin} is ${(bytes.byteLength / (1024 * 1024)).toFixed(1)} MB, above the `
      + `${(options.maxInlineBytes / (1024 * 1024)).toFixed(0)} MB inlining limit. `
      + 'Downscale it, or host it at a public URL and pass that URL instead.',
    )
  }
  return {
    value: toDataUrl(bytes, sniffImageMediaType(bytes)),
    kind: 'inline',
    inlinedBytes: bytes.byteLength,
    origin,
  }
}

/**
 * Resolve one image reference for the Agnes video endpoint.
 *
 * @param source - what the model supplied.
 * @param options - inlining limits.
 * @returns the value to send, its kind, and where it came from.
 * @throws Error when the source cannot be read or is too large to inline.
 */
export async function resolveImageSource(
  source: string,
  options: ResolveImageSourceOptions,
): Promise<ResolvedImageSource> {
  const trimmed = source.trim()
  if (trimmed.length === 0) throw new Error('no image source was supplied')

  if (isHttpUrl(trimmed)) {
    return { value: trimmed, kind: 'remote-url', origin: trimmed }
  }
  if (/^data:image\//i.test(trimmed)) {
    return { value: trimmed, kind: 'inline', origin: 'inline data URL' }
  }

  if (trimmed.toLowerCase().startsWith('attachment:')) {
    const id = trimmed.slice('attachment:'.length).trim()
    return inlineImageBytes(await readAttachmentBytes(id), `attachment:${id}`, options)
  }

  const path = trimmed.startsWith('file://') ? fileURLToPath(trimmed) : resolvePath(trimmed)
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await readFile(path))
  } catch (error) {
    throw new Error(
      `could not read an image from ${path}: ${error instanceof Error ? error.message : String(error)}. `
      + 'Pass a public http(s) URL, an existing local file path, an attachment:<id>, or a data: URL.',
    )
  }
  return inlineImageBytes(bytes, path, options)
}
