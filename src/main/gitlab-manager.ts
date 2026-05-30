import { execFile, spawn, type ChildProcess } from 'child_process'
import { promisify } from 'util'
import { shell } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import type { GitHubRepo } from './github-manager'

const execFileAsync = promisify(execFile)

const GLAB_API_MAX_BUFFER = 10 * 1024 * 1024

export interface GlabCliStatus {
  installed: boolean
  authenticated: boolean
  username?: string
}

export async function findGlabPath(): Promise<string> {
  const isWin = process.platform === 'win32'
  if (!isWin) return 'glab'

  try {
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execFileAsync = promisify(execFile)
    const { stdout } = await execFileAsync('where', ['glab'])
    const found = stdout.trim().split(/\r?\n/)[0]
    if (found && existsSync(found)) {
      return found
    }
  } catch {}

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

export class GitLabManager {
  private authProcess: ChildProcess | null = null

  /**
   * Maps a raw GitLab API project object to the shared GitHubRepo interface
   * so the UI can handle both providers uniformly.
   */
  private mapRepo(raw: Record<string, unknown>): GitHubRepo {
    const pathWithNamespace = raw.path_with_namespace as string
    const httpUrl = raw.http_url_to_repo as string
    return {
      name: raw.path as string,
      fullName: pathWithNamespace,
      defaultBranch: (raw.default_branch as string) || 'main',
      cloneUrl: httpUrl,
      description: (raw.description as string) || '',
      isPrivate: (raw.visibility as string) === 'private'
    }
  }

  /**
   * Fetches paginated results from a GitLab API endpoint.
   * Uses glab's built-in --paginate flag (supported since glab 1.x) which
   * automatically follows pagination headers and merges results.
   * Query params are embedded directly in the URL for clarity.
   */
  private async fetchPaginatedProjects(basePath: string, extraParams = ''): Promise<GitHubRepo[]> {
    const separator = basePath.includes('?') ? '&' : '?'
    const url = `${basePath}${separator}per_page=100&order_by=updated_at&sort=desc${extraParams ? '&' + extraParams : ''}`

    console.log(`[GitLabManager] Fetching: glab api ${url} --paginate`)
    const glabPath = await findGlabPath()
    const { stdout } = await execFileAsync(glabPath, [
      'api', url, '--paginate'
    ], { maxBuffer: GLAB_API_MAX_BUFFER, timeout: 60000 })


    const raw = JSON.parse(stdout) as Record<string, unknown>[]

    // Deduplicate by fullName
    const deduped = new Map<string, GitHubRepo>()
    for (const project of raw) {
      const mapped = this.mapRepo(project)
      deduped.set(mapped.fullName, mapped)
    }
    console.log(`[GitLabManager] Fetched ${deduped.size} projects from ${basePath}`)
    return Array.from(deduped.values())
  }

  /**
   * Fetches all projects accessible to the authenticated user via the GitLab REST API.
   * Uses glab to proxy the request so authentication tokens are handled automatically.
   */
  private async fetchAccessibleRepos(): Promise<GitHubRepo[]> {
    return this.fetchPaginatedProjects('/projects', 'membership=true')
  }

  async checkGlabCli(): Promise<GlabCliStatus> {
    const glabPath = await findGlabPath()
    try {
      await execFileAsync(glabPath, ['--version'])
    } catch {
      return { installed: false, authenticated: false }
    }

    try {
      const { stdout } = await execFileAsync(glabPath, ['auth', 'status'])
      // glab auth status outputs "Logged in to <hostname> as <username>"
      const match = stdout.match(/Logged in to .+ as (\S+)/) ||
                    stdout.match(/as (\S+)/)
      return { installed: true, authenticated: true, username: match?.[1] }
    } catch (error: unknown) {
      const execErr = error as { stderr?: string; stdout?: string }
      const output = (execErr?.stderr || '') + (execErr?.stdout || '')
      if (output.includes('Logged in')) {
        const match = output.match(/as (\S+)/)
        return { installed: true, authenticated: true, username: match?.[1] }
      }
      return { installed: true, authenticated: false }
    }
  }

  async startWebAuth(onDeviceCode?: (code: string) => void): Promise<void> {
    const glabPath = await findGlabPath()
    return new Promise((resolve, reject) => {
      this.authProcess = spawn(
        glabPath,
        ['auth', 'login', '--hostname', 'gitlab.com', '--web', '--git-protocol', 'https'],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      )

      let completed = false
      let browserOpened = false
      let output = ''
      const timeout = setTimeout(() => {
        if (!completed) {
          this.authProcess?.kill()
          reject(new Error('Auth timeout'))
        }
      }, 120000)

      const handleOutput = (data: Buffer): void => {
        output += data.toString()

        // glab uses a web-based flow similar to gh
        if (onDeviceCode) {
          const codeMatch = output.match(/code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/)
          if (codeMatch) {
            onDeviceCode(codeMatch[1])
          }
        }

        if (!browserOpened) {
          const urlMatch = output.match(/(https:\/\/gitlab\.com\/\S+)/)
          if (urlMatch) {
            browserOpened = true
            shell.openExternal(urlMatch[1])
          }
        }
      }

      this.authProcess.stderr?.on('data', handleOutput)
      this.authProcess.stdout?.on('data', handleOutput)

      this.authProcess.on('close', (code) => {
        completed = true
        clearTimeout(timeout)
        this.authProcess = null
        if (code === 0) resolve()
        else reject(new Error(`glab auth login exited with code ${code}`))
      })

      this.authProcess.on('error', (err) => {
        completed = true
        clearTimeout(timeout)
        this.authProcess = null
        reject(err)
      })

      // Write newline for any potential prompts
      this.authProcess.stdin?.write('\n')
    })
  }

  /**
   * Fetches all unique groups/namespaces the authenticated user has access to.
   * Mirrors GitHubManager.fetchUserOrgs() for UI compatibility.
   */
  async fetchUserOrgs(): Promise<string[]> {
    const [status, repos] = await Promise.all([
      this.checkGlabCli(),
      this.fetchAccessibleRepos()
    ])

    const owners = new Set<string>()
    for (const repo of repos) {
      // GitLab uses nested namespaces (e.g. "group/subgroup/project")
      // We extract the top-level namespace (first segment)
      const parts = repo.fullName.split('/')
      if (parts.length >= 2) {
        const owner = parts[0]
        if (owner && owner !== status.username) {
          owners.add(owner)
        }
      }
    }

    return Array.from(owners).sort((left, right) => left.localeCompare(right))
  }

  /**
   * Fetches repos for a specific organization/group.
   * Uses the GitLab Groups API directly for efficiency instead of fetching
   * all accessible projects. Falls back to the general /projects endpoint
   * with prefix filtering if the group lookup fails (e.g. personal namespace).
   */
  async fetchOrgRepos(org: string): Promise<GitHubRepo[]> {
    try {
      // Use the Groups API — more targeted and reliable than fetching all projects
      const encodedGroup = encodeURIComponent(org)
      const repos = await this.fetchPaginatedProjects(
        `/groups/${encodedGroup}/projects`,
        'include_subgroups=true'
      )
      console.log(`[GitLabManager] fetchOrgRepos via Groups API: ${repos.length} repos for "${org}"`)
      return repos
    } catch (error) {
      // Group lookup can fail for personal namespaces — fall back to general search
      console.log(`[GitLabManager] Groups API failed for "${org}", falling back to /projects:`, (error as Error).message)
      const repos = await this.fetchAccessibleRepos()
      return repos.filter((repo) => repo.fullName.startsWith(`${org}/`))
    }
  }

  /**
   * Fetches repos owned by the authenticated user.
   */
  async fetchUserRepos(): Promise<GitHubRepo[]> {
    const status = await this.checkGlabCli()
    if (!status.username) return []

    const repos = await this.fetchAccessibleRepos()
    return repos.filter((repo) => repo.fullName.startsWith(`${status.username}/`))
  }
}
