/** A campus of a school. Every tenant has at least one (a "Main" branch is
 * backfilled for schools that predate the concept), so a single-site school
 * can ignore branches entirely. */
export interface Branch {
  id: string
  name: string
  /** Lowercase, url-safe, unique within the school. */
  code: string
  address: string | null
  /** IANA zone, e.g. "Asia/Amman" — the absence sweep reads local time here. */
  timezone: string
  active: boolean
}
