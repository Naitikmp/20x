import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { join } from 'path'

const execFileAsync = promisify(execFile)

/**
 * Detect which agents and tools are installed on this system.
 * @returns {Promise<Record<string, { installed: boolean, version: string | null }>>}
 */
export async function detectInstalledAgents() {
  const isWin = process.platform === 'win32'

  function findGlabPath() {
    if (!isWin) return 'glab'
    const home = process.env.USERPROFILE || ''
    const commonPaths = [
      join(home, 'AppData', 'Local', 'Programs', 'glab', 'glab.exe'),
      join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'glab.exe'),
      'C:\\Program Files\\glab\\glab.exe',
      'C:\\Program Files\\GitLab\\glab\\glab.exe'
    ]
    for (const p of commonPaths) {
      if (existsSync(p)) {
        return p
      }
    }
    return 'glab'
  }

  /**
   * Run a command and extract a version string from stdout.
   * On Windows, shell: true is required to resolve .cmd/.bat wrappers.
   * @param {string} cmd
   * @param {string[]} args
   * @returns {Promise<{ installed: boolean, version: string | null }>}
   */
  async function probe(cmd, args) {
    try {
      const { stdout } = await execFileAsync(cmd, args, {
        timeout: 10000,
        shell: isWin,
        windowsHide: true
      })
      const raw = stdout.trim()
      // Extract version-like string (e.g. "v22.1.0", "2.44.0", "1.0.3")
      const match = raw.match(/(\d+\.\d+[\w.\-]*)/)
      return { installed: true, version: match ? match[1] : raw.split('\n')[0] }
    } catch {
      return { installed: false, version: null }
    }
  }

  const glabPath = findGlabPath()

  // Run all probes in parallel — shell:true on Windows resolves .cmd automatically
  const [nodejs, npm, pnpm, git, gh, glab, claudeCode, opencode, codex] = await Promise.all([
    probe('node', ['--version']),
    probe('npm', ['--version']),
    probe('pnpm', ['--version']),
    probe('git', ['--version']),
    probe('gh', ['--version']),
    probe(glabPath, ['--version']),
    probe('claude', ['--version']),
    probe('opencode', ['--version']),
    probe('codex', ['--version'])
  ])

  return { nodejs, npm, pnpm, git, gh, glab, claudeCode, opencode, codex }
}
