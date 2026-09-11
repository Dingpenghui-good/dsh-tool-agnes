/**
 * Media sniffing and delivery helpers.
 *
 * The attachment store requires the caller to declare a media type and then
 * verifies it against the decoded bytes, so guessing "image/png" is not an
 * option. The dedicated image inspector is not part of
 * `@deepseek-ai/dsh-attachment-local`'s public entry point, and pulling in a
 * full decoder just to read four bytes would add a native dependency to a
 * plugin that otherwise needs none.
 *
 * @module dsh-tool-agnes/core/media
 */

/**
 * Raster formats accepted by the DSH attachment path.
 *
 * Declared here rather than imported from `@deepseek-ai/dsh-attachment` so the
 * video plugins do not need an attachment dependency merely to read four magic
 * bytes; the values are structurally identical to that package's
 * `ImageMediaType`.
 */
export type RasterMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/**
 * Identify an encoded raster image from its magic bytes.
 * @param bytes - the encoded image.
 * @returns the detected media type.
 * @throws Error when the bytes are not one of the four accepted raster formats.
 */
export function sniffImageMediaType(bytes: Uint8Array): RasterMediaType {
  const at = (offset: number): number => bytes[offset] ?? -1
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png'
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg'
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'image/gif'
  if (
    at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46
    && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50
  ) return 'image/webp'
  throw new Error('the generated image is not a PNG, JPEG, GIF, or WebP raster')
}

/**
 * Whether bytes look like an ISO base media file (MP4/MOV), which is what the
 * Agnes video CDN serves.
 * @param bytes - the downloaded video.
 * @returns true when the `ftyp` box is where an ISO BMFF file puts it.
 */
export function looksLikeMp4(bytes: Uint8Array): boolean {
  return bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70
}

/**
 * Render a byte count for a human reader.
 * @param bytes - byte count.
 * @returns a compact `MB`/`KB` string.
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

/**
 * Encode image bytes as a `data:` URL.
 *
 * Verified against the live gateway: `POST /v1/videos` accepts a data URL in
 * its `image` field exactly like a public HTTP URL, which is what removes the
 * "the provider must be able to fetch your image" requirement.
 *
 * @param bytes - the encoded image.
 * @param mediaType - its verified media type.
 * @returns the data URL.
 */
export function toDataUrl(bytes: Uint8Array, mediaType: RasterMediaType): string {
  return `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`
}

