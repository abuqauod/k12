/** ArrangeMySchool logo — a circular badge mark, served as a static asset
 * (public/logo.jpg) rather than inlined, since it's a full-color raster
 * illustration rather than a line icon that could follow the theme via
 * `currentColor`. */
export function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <img
      className="brand__mark"
      src="/logo.jpg"
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      style={{ objectFit: 'contain' }}
    />
  )
}

/** Full lockup for the sign-in screens: the logo seated in a white round
 * badge (the JPG's own white background becomes the badge, so it reads as
 * intentional on the dark brand panel), beside the wordmark. */
export function BrandLockup({ tagline }: { tagline: string }) {
  return (
    <div className="lockup">
      <span className="lockup__badge">
        <BrandMark size={96} />
      </span>
      <div className="lockup__text">
        <span className="lockup__word">ArrangeMySchool</span>
        <span className="lockup__tagline">{tagline}</span>
      </div>
    </div>
  )
}
