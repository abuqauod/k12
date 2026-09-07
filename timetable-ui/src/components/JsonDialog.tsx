import { useState } from 'react'

interface Props {
  title: string
  subtitle: string
  json: string
  filename: string
  onClose: () => void
  onDownload: (filename: string, contents: string) => void
}

export function JsonDialog({ title, subtitle, json, filename, onClose, onDownload }: Props) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div
      className="dialog"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="dialog__panel">
        <div className="dialog__head">
          <div>
            <strong>{title}</strong>
            <div className="mono">{subtitle}</div>
          </div>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="dialog__body">
          <pre>{json}</pre>
        </div>
        <div className="dialog__foot">
          <span className="mono">{(json.length / 1024).toFixed(1)} KB</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn btn--sm" onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              type="button"
              className="btn btn--sm btn--primary"
              onClick={() => onDownload(filename, json)}
            >
              Download
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
