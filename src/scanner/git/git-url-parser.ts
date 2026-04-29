import { ParsedGitUrl, GitError } from './types.js';

export class GitUrlParser {
  private static readonly GIT_URL_PATTERNS = [
    // HTTPS patterns
    /^https?:\/\/([^\/]+)\/([^\/]+)\/([^\/]+?)(?:\.git)?(?:\/.*)?$/,
    // SSH patterns
    /^git@([^:]+):([^\/]+)\/([^\/]+?)(?:\.git)?$/,
    // Git protocol patterns
    /^git:\/\/([^\/]+)\/([^\/]+)\/([^\/]+?)(?:\.git)?(?:\/.*)?$/
  ];

  private static readonly KNOWN_PROVIDERS = {
    'github.com': 'github',
    'gitlab.com': 'gitlab',
    'bitbucket.org': 'bitbucket',
    'dev.azure.com': 'azure'
  } as const;

  // Azure DevOps URL pattern: https://dev.azure.com/{org}/{project}/_git/{repo}
  // or https://{org}.visualstudio.com/{project}/_git/{repo}
  private static readonly AZURE_DEVOPS_PATTERNS = [
    /^https?:\/\/dev\.azure\.com\/([^\/]+)\/([^\/]+)\/_git\/([^\/]+?)(?:\.git)?(?:\/.*)?$/,
    /^https?:\/\/([^\.]+)\.visualstudio\.com\/([^\/]+)\/_git\/([^\/]+?)(?:\.git)?(?:\/.*)?$/,
    /^([^\.]+)@vs-ssh\.visualstudio\.com:v3\/([^\/]+)\/([^\/]+)\/([^\/]+?)(?:\.git)?$/
  ];

  static parse(url: string): ParsedGitUrl {
    if (!url || typeof url !== 'string') {
      throw new GitError('Invalid URL: URL must be a non-empty string', 'INVALID_URL', url);
    }

    const trimmedUrl = url.trim();
    
    // Try Azure DevOps patterns first (more specific)
    // SSH: git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
    const azureSshMatch = trimmedUrl.match(/^git@ssh\.dev\.azure\.com:v3\/([^\/]+)\/([^\/]+)\/([^\/]+?)(?:\.git)?$/);
    if (azureSshMatch) {
      const [, org, project, repo] = azureSshMatch;
      return {
        protocol: 'ssh',
        provider: 'azure',
        host: 'ssh.dev.azure.com',
        owner: `${org}/${project}`,
        repo: this.cleanRepoName(repo),
        originalUrl: trimmedUrl
      };
    }

    // HTTPS: https://dev.azure.com/{org}/{project}/_git/{repo}
    // Also handles: https://{user}@dev.azure.com/{org}/{project}/_git/{repo}
    const azureHttpsMatch = trimmedUrl.match(/^https?:\/\/(?:[^@]+@)?dev\.azure\.com\/([^\/]+)\/([^\/]+)\/_git\/([^\/]+?)(?:\.git)?(?:\/.*)?$/);
    if (azureHttpsMatch) {
      const [, org, project, repo] = azureHttpsMatch;
      return {
        protocol: 'https',
        provider: 'azure',
        host: 'dev.azure.com',
        owner: `${org}/${project}`,
        repo: this.cleanRepoName(repo),
        originalUrl: trimmedUrl
      };
    }

    const azureVsMatch = trimmedUrl.match(/^https?:\/\/([^\.]+)\.visualstudio\.com\/([^\/]+)\/_git\/([^\/]+?)(?:\.git)?(?:\/.*)?$/);
    if (azureVsMatch) {
      const [, org, project, repo] = azureVsMatch;
      return {
        protocol: 'https',
        provider: 'azure',
        host: `${org}.visualstudio.com`,
        owner: `${org}/${project}`,
        repo: this.cleanRepoName(repo),
        originalUrl: trimmedUrl
      };
    }

    // Try HTTPS pattern
    const httpsMatch = trimmedUrl.match(/^https?:\/\/([^\/]+)\/([^\/]+)\/([^\/]+?)(?:\.git)?(?:\/.*)?$/);
    if (httpsMatch) {
      const [, host, owner, repo] = httpsMatch;
      return {
        protocol: 'https',
        provider: this.getProvider(host),
        host,
        owner,
        repo: this.cleanRepoName(repo),
        originalUrl: trimmedUrl
      };
    }

    // Try SSH pattern
    const sshMatch = trimmedUrl.match(/^git@([^:]+):([^\/]+)\/([^\/]+?)(?:\.git)?$/);
    if (sshMatch) {
      const [, host, owner, repo] = sshMatch;
      return {
        protocol: 'ssh',
        provider: this.getProvider(host),
        host,
        owner,
        repo: this.cleanRepoName(repo),
        originalUrl: trimmedUrl
      };
    }

    // Try git protocol pattern
    const gitMatch = trimmedUrl.match(/^git:\/\/([^\/]+)\/([^\/]+)\/([^\/]+?)(?:\.git)?(?:\/.*)?$/);
    if (gitMatch) {
      const [, host, owner, repo] = gitMatch;
      return {
        protocol: 'git',
        provider: this.getProvider(host),
        host,
        owner,
        repo: this.cleanRepoName(repo),
        originalUrl: trimmedUrl
      };
    }

    throw new GitError(
      `Unsupported git URL format: ${trimmedUrl}. Supported formats: https://github.com/owner/repo, git@github.com:owner/repo, git://github.com/owner/repo`,
      'UNSUPPORTED_URL_FORMAT',
      trimmedUrl
    );
  }

  static isGitUrl(url: string): boolean {
    try {
      this.parse(url);
      return true;
    } catch {
      return false;
    }
  }

  static validateUrl(url: string): { valid: boolean; error?: string } {
    try {
      this.parse(url);
      return { valid: true };
    } catch (error) {
      return { 
        valid: false, 
        error: error instanceof GitError ? error.message : 'Unknown error parsing URL' 
      };
    }
  }

  static normalizeUrl(parsedUrl: ParsedGitUrl): string {
    // Convert to HTTPS format for consistency
    return `https://${parsedUrl.host}/${parsedUrl.owner}/${parsedUrl.repo}.git`;
  }

  static buildCloneUrl(parsedUrl: ParsedGitUrl, useToken?: string): string {
    if (parsedUrl.protocol === 'ssh') {
      // Azure DevOps SSH has a special format
      if (parsedUrl.provider === 'azure') {
        return `git@ssh.dev.azure.com:v3/${parsedUrl.owner}/${parsedUrl.repo}`;
      }
      return `git@${parsedUrl.host}:${parsedUrl.owner}/${parsedUrl.repo}.git`;
    }

    if (useToken && parsedUrl.provider === 'github') {
      return `https://${useToken}@${parsedUrl.host}/${parsedUrl.owner}/${parsedUrl.repo}.git`;
    }

    if (useToken && parsedUrl.provider === 'gitlab') {
      return `https://oauth2:${useToken}@${parsedUrl.host}/${parsedUrl.owner}/${parsedUrl.repo}.git`;
    }

    if (useToken && parsedUrl.provider === 'azure') {
      if (parsedUrl.host === 'dev.azure.com' || parsedUrl.host === 'ssh.dev.azure.com') {
        return `https://pat:${useToken}@dev.azure.com/${parsedUrl.owner}/_git/${parsedUrl.repo}`;
      }
      return `https://pat:${useToken}@${parsedUrl.host}/${parsedUrl.owner.split('/')[1]}/_git/${parsedUrl.repo}`;
    }

    return `https://${parsedUrl.host}/${parsedUrl.owner}/${parsedUrl.repo}.git`;
  }

  private static getProvider(host: string): ParsedGitUrl['provider'] {
    const normalizedHost = host.toLowerCase();
    if (normalizedHost.endsWith('.visualstudio.com')) return 'azure';
    if (normalizedHost === 'ssh.dev.azure.com') return 'azure';
    return (this.KNOWN_PROVIDERS[normalizedHost as keyof typeof this.KNOWN_PROVIDERS]) || 'custom';
  }

  private static cleanRepoName(repo: string): string {
    return repo.replace(/\.git$/, '');
  }
}