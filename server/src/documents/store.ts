import { createHash } from 'node:crypto'
import type { Readable } from 'node:stream'
import { ObjectId } from 'mongodb'
import { gridFsBucket } from '../db.js'

/**
 * Where document bytes live (SAMS 2.1). Routes only see this interface, so
 * GridFS can be swapped for object storage (S3 and the like) without
 * touching them.
 *
 * GridFS sits outside `TenantScope`, so tenant isolation is done here:
 * every file carries its tenant in `metadata.tenantId`, and `open` and
 * `remove` match on it together with the id. A file id from another
 * tenant reads as missing.
 */
export interface StoredFile {
  fileId: string
  size: number
  sha256: string
}

export interface DocumentStore {
  put(tenantId: string, data: Buffer, meta: { fileName: string; mime: string }): Promise<StoredFile>
  /** Null when the file does not exist for this tenant. */
  open(tenantId: string, fileId: string): Promise<{ stream: Readable; size: number } | null>
  remove(tenantId: string, fileId: string): Promise<void>
}

const BUCKET = 'documentFiles'

function toObjectId(fileId: string): ObjectId | null {
  return ObjectId.isValid(fileId) && fileId.length === 24 ? new ObjectId(fileId) : null
}

export const gridFsStore: DocumentStore = {
  async put(tenantId, data, meta) {
    const bucket = await gridFsBucket(BUCKET)
    const upload = bucket.openUploadStream(meta.fileName, { metadata: { tenantId, mime: meta.mime } })
    await new Promise<void>((resolve, reject) => {
      upload.once('finish', () => resolve())
      upload.once('error', reject)
      upload.end(data)
    })
    return {
      fileId: upload.id.toString(),
      size: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
    }
  },

  async open(tenantId, fileId) {
    const id = toObjectId(fileId)
    if (!id) return null
    const bucket = await gridFsBucket(BUCKET)
    const [file] = await bucket.find({ _id: id, 'metadata.tenantId': tenantId }).limit(1).toArray()
    if (!file) return null
    return { stream: bucket.openDownloadStream(id), size: file.length }
  },

  async remove(tenantId, fileId) {
    const id = toObjectId(fileId)
    if (!id) return
    const bucket = await gridFsBucket(BUCKET)
    const [file] = await bucket.find({ _id: id, 'metadata.tenantId': tenantId }).limit(1).toArray()
    if (file) await bucket.delete(id)
  },
}

/**
 * The file's real type, from its first bytes. The client's claimed
 * Content-Type is ignored: a renamed HTML file must not be served back
 * as something a browser would run. Only types the UI can preview are
 * accepted.
 */
export function sniffMime(data: Buffer): string | null {
  const starts = (bytes: number[], offset = 0) => bytes.every((b, i) => data[offset + i] === b)
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf' // %PDF-
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp' // RIFF....WEBP
  return null
}
