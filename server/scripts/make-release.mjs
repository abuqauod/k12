#!/usr/bin/env node
/**
 * Builds a folder (and a zip) containing exactly what a shared host needs:
 * compiled JS and a trimmed package.json, and nothing that only makes sense
 * on the dev machine (src/, devDependencies, local .env, the Docker files).
 * There's no migrations/ folder to ship — MongoDB has no schema to migrate;
 * `npm run migrate` (run once after deploy) just creates indexes.
 *
 * Deliberately does NOT ship node_modules or package-lock.json — the native
 * `@node-rs/argon2` binary must be installed on the target host's own OS/CPU,
 * not copied from whatever machine ran this script. Run `npm install` on the
 * server itself (cPanel's "Run NPM Install" button does exactly this).
 *
 * Usage: npm run release
 */
import { execSync } from 'node:child_process'
import { createWriteStream, mkdirSync, rmSync } from 'node:fs'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const releaseDir = join(root, 'release')
const stageDir = join(releaseDir, 'timetable-server')
const zipPath = join(releaseDir, 'timetable-server.zip')

function log(message) {
  console.log(`  ${message}`)
}

async function main() {
  console.log('Building...')
  // execSync always runs through a shell (cmd.exe on Windows, /bin/sh
  // elsewhere), which is what resolves npm's .cmd shim on Windows. The
  // command is a fixed literal, never user input.
  execSync('npm run build', { cwd: root, stdio: 'inherit' })

  console.log('Staging release bundle...')
  rmSync(releaseDir, { recursive: true, force: true })
  mkdirSync(stageDir, { recursive: true })

  await cp(join(root, 'dist'), join(stageDir, 'dist'), { recursive: true })
  log('dist/')

  await cp(join(root, 'public'), join(stageDir, 'public'), { recursive: true })
  log('public/ (the platform-admin console)')

  await cp(join(root, '.env.example'), join(stageDir, '.env.example'))
  log('.env.example')

  // Trimmed package.json: production dependencies and the scripts that make
  // sense once dist/ already exists. No devDependencies, no build/release
  // scripts that assume src/ is present.
  const full = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const trimmed = {
    name: full.name,
    private: true,
    version: full.version,
    type: full.type,
    engines: full.engines,
    scripts: {
      start: 'node dist/server.js',
      migrate: 'node dist/migrate.js',
      seed: 'node dist/seed.js',
      smoke: 'node dist/smoke.js',
      'smoke-admin': 'node dist/smokeAdmin.js',
      'create-admin': 'node dist/createAdmin.js',
    },
    dependencies: full.dependencies,
  }
  await writeFile(join(stageDir, 'package.json'), JSON.stringify(trimmed, null, 2) + '\n')
  log('package.json (production-only)')

  await writeFile(
    join(stageDir, 'DEPLOY.md'),
    `# Deploying this bundle

1. Get a MongoDB connection string — most shared hosts (Hostinger's hPanel
   included) don't offer MongoDB natively, so this is normally a free
   MongoDB Atlas cluster (atlas.mongodb.com), not something on the host
   itself. Add a database user, and allow network access from anywhere
   (0.0.0.0/0) since a shared host's outbound IP isn't fixed.
2. Upload this whole folder to the shared host (outside \`public_html\` /
   the domain's document root — it must not be web-accessible).
3. In your host's Node.js app panel (cPanel: **Setup Node.js App**;
   Hostinger hPanel: **Advanced → Node.js**) → Create Application:
   - Application root: this folder
   - Application startup file: \`dist/server.js\`
   - Node version: 20 LTS or newer
4. Copy \`.env.example\` to \`.env\` next to \`package.json\` and fill in real
   values (or set the same variables in the panel's "Environment Variables"
   section — either works, the panel's own settings win if both are set):
   \`\`\`
   DATABASE_URL=mongodb+srv://user:pass@cluster.xxxxx.mongodb.net/timetable?retryWrites=true&w=majority
   JWT_SECRET=<a long random string>
   CORS_ORIGINS=https://your-frontend-domain.com
   \`\`\`
5. Click **Run NPM Install** in the Node.js app screen. This installs the
   native argon2 module for the host's own OS — do not copy node_modules/
   from your dev machine.
6. Open this app's terminal (or SSH in) and run, once:
   \`\`\`
   npm run migrate
   npm run create-admin -- you@example.com 'a strong password'
   \`\`\`
   (\`migrate\` creates indexes — safe to re-run on every future deploy too.
   \`create-admin\` is your own platform-admin login for the console below.)
7. Restart the app.
8. Check \`https://<your-app-domain>/health\` returns \`{"ok":true}\`, then
   sign in at \`https://<your-app-domain>/console\` with the account from
   step 6 to create and manage schools.

See the main README's "Deploying to shared hosting" section for the full
walkthrough and troubleshooting notes.
`,
  )
  log('DEPLOY.md')

  console.log('Zipping...')
  await zipDirectory(stageDir, zipPath)
  log(`release/timetable-server.zip`)

  console.log(`\nDone. Upload release/timetable-server.zip (or the release/timetable-server/ folder) to your host.`)
}

async function zipDirectory(sourceDir, outPath) {
  const { default: archiver } = await import('archiver')
  await mkdir(dirname(outPath), { recursive: true })
  await new Promise((resolve, reject) => {
    const output = createWriteStream(outPath)
    const archive = archiver('zip', { zlib: { level: 9 } })
    output.on('close', resolve)
    archive.on('error', reject)
    archive.pipe(output)
    archive.directory(sourceDir, false)
    archive.finalize()
  })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
