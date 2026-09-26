/**
 * Code 128 (set B) as SVG, for the number on an ID card: printable ASCII,
 * the start, the data, the mod-103 check symbol and the stop. Scanners at
 * the library desk read it as the typed number.
 */

// Bar/space widths (in modules) of values 0–106; 104 is Start B, 106 Stop.
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
]
const START_B = 104
const STOP = 106

/** The symbol values for `text` (Code 128 B, with the check value). */
export function code128Values(text: string): number[] {
  const values = [START_B]
  for (const ch of text) {
    const c = ch.charCodeAt(0)
    // Set B covers space (32) to DEL-1 (126); anything else becomes "?".
    values.push(c >= 32 && c <= 126 ? c - 32 : 31)
  }
  const check = values.reduce((sum, v, i) => sum + v * (i === 0 ? 1 : i), 0) % 103
  return [...values, check, STOP]
}

/** Bar and space widths, alternating from a bar, in modules. */
export function code128Modules(text: string): number[] {
  return code128Values(text).flatMap((v) => [...PATTERNS[v]!].map(Number))
}

/** An SVG barcode `height` units tall with a 10-module quiet zone each side. */
export function code128Svg(text: string, height = 40): string {
  const widths = code128Modules(text)
  const quiet = 10
  let x = quiet
  const bars: string[] = []
  widths.forEach((w, i) => {
    if (i % 2 === 0) bars.push(`<rect x="${x}" y="0" width="${w}" height="${height}"/>`)
    x += w
  })
  const total = x + quiet
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${height}" preserveAspectRatio="none" role="img" aria-label="${text.replace(/[<>&"]/g, '')}"><rect width="${total}" height="${height}" fill="#fff"/><g fill="#000">${bars.join('')}</g></svg>`
}
