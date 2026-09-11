/**
 * Index of images that arrived in a session from the user.
 *
 * A picture pasted or uploaded in the GUI reaches the model as an `ImageBlock`
 * whose content it can see, but the block's `attachmentId` is host metadata the
 * model never receives — so the model cannot name the image it is looking at.
 *
 * This index closes that gap from the plugin side: it watches the session event
 * feed and remembers the attachment references that arrived with each user
 * message, so a tool can resolve "the image the user just gave me" without the
 * model ever needing an id.
 *
 * @module dsh-tool-agnes/core/recent-images
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/** How many distinct sessions keep a window; oldest is evicted first. */
const MAX_SESSIONS = 32

/** How many images per session are remembered (most recent kept). */
const MAX_PER_SESSION = 8

/** Extract image attachment references from one message's content blocks. */
function imageRefsIn(content: unknown): ImageAttachmentRef[] {
  if (!Array.isArray(content)) return []
  const refs: ImageAttachmentRef[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const candidate = block as { type?: unknown; attachment?: unknown }
    if (candidate.type !== 'image') continue
    const attachment = candidate.attachment
    if (attachment === null || typeof attachment !== 'object') continue
    const ref = attachment as Partial<ImageAttachmentRef>
    if (typeof ref.attachmentId === 'string' && ref.attachmentId.length > 0) {
      refs.push(attachment as ImageAttachmentRef)
    }
  }
  return refs
}

/**
 * Per-session window of recently supplied images.
 *
 * Session events carry the complete `UserMessage`, so this needs no session-log
 * access (which the session service does not expose) and no persistence: the
 * window only has to outlive the turn in which the user pasted the picture.
 */
export class RecentImageIndex {
  private readonly bySession = new Map<string, ImageAttachmentRef[]>()

  constructor(private readonly ctx: Context) {}

  /**
   * Subscribe to the session event feed for the lifetime of the calling fiber.
   *
   * Constructor-seeded history (a resumed session) never emits on this feed, so
   * images from before this process started are not indexed. That is deliberate:
   * the feature answers "animate the picture the user just gave me", which is
   * always a live event.
   */
  register(): void {
    this.ctx.on('session/event', (session, event) => {
      if (event.type !== 'user/message') return
      const message = event.data as { content?: unknown }
      const refs = imageRefsIn(message.content)
      if (refs.length > 0) this.remember(String(session.id), refs)
    })
  }

  /**
   * Append references to one session's window, evicting the oldest sessions.
   * @param sessionId - owning session.
   * @param refs - newly observed image references.
   */
  private remember(sessionId: string, refs: readonly ImageAttachmentRef[]): void {
    const merged = [...this.bySession.get(sessionId) ?? [], ...refs].slice(-MAX_PER_SESSION)
    // Re-insert so Map iteration order tracks recency for eviction.
    this.bySession.delete(sessionId)
    this.bySession.set(sessionId, merged)
    while (this.bySession.size > MAX_SESSIONS) {
      const oldest = this.bySession.keys().next().value
      if (oldest === undefined) break
      this.bySession.delete(oldest)
    }
  }

  /**
   * The most recent image supplied in one session.
   * @param sessionId - the calling agent's session id.
   * @returns the newest reference, or undefined when the session supplied none.
   */
  latest(sessionId: string | undefined): ImageAttachmentRef | undefined {
    if (sessionId === undefined) return undefined
    const refs = this.bySession.get(sessionId)
    return refs !== undefined && refs.length > 0 ? refs[refs.length - 1] : undefined
  }

  /**
   * How many images one session has supplied, for diagnostics.
   * @param sessionId - the session to inspect.
   * @returns the window size.
   */
  count(sessionId: string | undefined): number {
    if (sessionId === undefined) return 0
    return this.bySession.get(sessionId)?.length ?? 0
  }
}
