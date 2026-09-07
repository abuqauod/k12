/**
 * K-12 shield mark.
 *
 * Vector rather than raster so it stays crisp at every size and follows the
 * theme: shield strokes use `currentColor` (navy `--ink` on light, near-white
 * on dark) while the four nodes keep the brand orange.
 *
 * Proportions follow the artwork — shield roughly 0.8 wide to tall, hexagon
 * dead centre, nodes on a cross at 10% and 89% of the width. Below 40px the
 * inner maze rings are dropped: at sidebar size they collapse into a smudge,
 * and it is the shield outline plus the node cross that still reads as the logo.
 */
export function BrandMark({ size = 30 }: { size?: number }) {
  const detailed = size >= 40
  const id = detailed ? 'k12-lg' : 'k12-sm'
  const stroke = detailed ? 2.6 : 5

  return (
    <svg
      className="brand__mark"
      width={(size * 124) / 158}
      height={size}
      viewBox="0 0 124 158"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={`${id}-node`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ff7300" />
          <stop offset="100%" stopColor="#f9902f" />
        </linearGradient>
      </defs>

      {/* Shield: deep chevron notch at the top, tapering to a rounded point. */}
      <g stroke="currentColor" strokeWidth={stroke} strokeLinejoin="round" strokeLinecap="round">
        <path d="M10 8 H47 L62 48 L77 8 H114 V100 C114 122 92 141 62 151 C32 141 10 122 10 100 Z" />
        <path d="M21 19 H43 L62 62 L81 19 H103 V99 C103 117 84 133 62 142 C40 133 21 117 21 99 Z" />
        {detailed && (
          <>
            <path d="M32 30 H39 L62 76 L85 30 H92 V97 C92 112 77 125 62 133 C47 125 32 112 32 97 Z" />
            <path d="M43 41 H45 L62 80 L79 41 H81 V95 C81 107 72 117 62 124 C52 117 43 107 43 95 Z" />
          </>
        )}
      </g>

      {/* Hexagon core, pointed left and right so the node cross meets it square. */}
      <path
        d="M47 79 L56 64 H68 L77 79 L68 94 H56 Z"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeLinejoin="round"
      />

      {/* Growth arrow. */}
      <g
        stroke="currentColor"
        strokeWidth={detailed ? 2.6 : 4}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M56 88 L70 73" />
        <path d="M61 72 H71 V82" />
      </g>

      {/* Four connected nodes: the network the shield protects. */}
      <g stroke={`url(#${id}-node)`} strokeWidth={detailed ? 3.4 : 5} strokeLinecap="round">
        <path d="M62 64 V38" />
        <path d="M62 94 V124" />
        <path d="M47 79 H27" />
        <path d="M77 79 H97" />
      </g>
      <g fill={`url(#${id}-node)`}>
        <circle cx="62" cy="34" r={detailed ? 6.5 : 9.5} />
        <circle cx="62" cy="128" r={detailed ? 6.5 : 9.5} />
        <circle cx="23" cy="79" r={detailed ? 6.5 : 9.5} />
        <circle cx="101" cy="79" r={detailed ? 6.5 : 9.5} />
      </g>
    </svg>
  )
}

/** Full lockup: shield beside the K-12 wordmark, for the login screen. */
export function BrandLockup({ tagline }: { tagline: string }) {
  return (
    <div className="lockup">
      <BrandMark size={116} />
      <div className="lockup__text">
        <span className="lockup__word">K-12</span>
        <span className="lockup__tagline">{tagline}</span>
      </div>
    </div>
  )
}
