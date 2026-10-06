import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

type CarryOver = { repository: string; originalPullRequest: number; mergedPullRequest: number; authorCommit: string };
type Config = { username: string; carryOverContributions: CarryOver[] };
type Contribution = { repository: string; number: number; mergedAt: string; kind: 'direct' | 'carry-over'; originalPullRequest?: number; authorCommit?: string };
type Repository = { repository: string; stars: number; contributions: Contribution[] };
type SearchItem = { user: { login: string }; repository_url: string; number: number; pull_request?: { merged_at?: string } };
type Get = (path: string) => Promise<any>;

export const START = '<!-- CONTRIBUTIONS:START -->';
export const END = '<!-- CONTRIBUTIONS:END -->';

export async function collectContributions(config: Config, get: Get): Promise<Repository[]> {
  const entries = new Map<string, Contribution>();
  const query = `is:pr is:merged is:public author:${config.username} -user:${config.username}`;
  let total = 0;
  let received = 0;
  for (let page = 1; page <= 10; page++) {
    const result = await get(`/search/issues?q=${encodeURIComponent(query)}&per_page=100&page=${page}`);
    if (result.incomplete_results || !Array.isArray(result.items) || !Number.isInteger(result.total_count) || result.total_count > 1000) {
      throw new Error('GitHub search is incomplete; preserving the current README.');
    }
    if (page === 1) total = result.total_count;
    if (result.total_count !== total) throw new Error('Search changed during pagination; retry on the next run.');
    received += result.items.length;
    for (const item of result.items as SearchItem[]) {
      if (item.user.login.toLowerCase() !== config.username.toLowerCase() || !item.pull_request?.merged_at) {
        throw new Error('Search returned a PR without verified author or merge status.');
      }
      const match = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)$/.exec(item.repository_url);
      if (!match) throw new Error('Unexpected repository URL.');
      const repository = match[1];
      entries.set(`${repository.toLowerCase()}#${item.number}`, {
        repository, number: item.number, mergedAt: item.pull_request.merged_at, kind: 'direct',
      });
    }
    if (received >= total) break;
    if (result.items.length === 0) throw new Error('Missing search results.');
  }
  if (received !== total || entries.size !== total) throw new Error('Missing or duplicated search results.');

  for (const carry of config.carryOverContributions) {
    const repository = carry.repository;
    if (entries.has(`${repository.toLowerCase()}#${carry.originalPullRequest}`) || entries.has(`${repository.toLowerCase()}#${carry.mergedPullRequest}`)) continue;
    const pr = await get(`/repos/${repository}/pulls/${carry.mergedPullRequest}`);
    if (!pr.merged || !pr.merged_at) throw new Error('The configured carry-over PR is not merged.');
    const commit = await get(`/repos/${repository}/commits/${carry.authorCommit}`);
    if (commit.author?.login?.toLowerCase() !== config.username.toLowerCase()) throw new Error('Carry-over author attribution could not be verified.');
    let included = false;
    for (let page = 1; page <= 3; page++) {
      const commits = await get(`/repos/${repository}/pulls/${carry.mergedPullRequest}/commits?per_page=100&page=${page}`);
      if (!Array.isArray(commits)) throw new Error('Invalid PR commits response.');
      included ||= commits.some((entry: { sha: string }) => entry.sha === carry.authorCommit);
      if (included || commits.length < 100) break;
    }
    if (!included) throw new Error('The attributed carry-over commit is not in the merged PR.');
    entries.set(`${repository.toLowerCase()}#${carry.mergedPullRequest}`, {
      repository, number: carry.mergedPullRequest, mergedAt: pr.merged_at, kind: 'carry-over',
      originalPullRequest: carry.originalPullRequest, authorCommit: carry.authorCommit,
    });
  }

  const groups = new Map<string, Contribution[]>();
  for (const contribution of entries.values()) {
    const contributions = groups.get(contribution.repository) ?? [];
    contributions.push(contribution);
    groups.set(contribution.repository, contributions);
  }
  const repositories: Repository[] = [];
  for (const [repository, contributions] of groups) {
    const info = await get(`/repos/${repository}`);
    if (!Number.isInteger(info.stargazers_count) || info.stargazers_count < 0 || info.private) throw new Error('Invalid public repository statistics.');
    contributions.sort((a, b) => a.number - b.number);
    repositories.push({ repository, stars: info.stargazers_count, contributions });
  }
  return repositories.sort((a, b) => b.stars - a.stars || a.repository.localeCompare(b.repository, 'en'));
}

export function renderContributions(repositories: Repository[], updatedAt: string): string {
  const direct = repositories.flatMap(repo => repo.contributions).filter(item => item.kind === 'direct').length;
  const carry = repositories.flatMap(repo => repo.contributions).filter(item => item.kind === 'carry-over').length;
  const rows = repositories.map(repo => `| [${repo.repository}](https://github.com/${repo.repository}) | ${repo.stars.toLocaleString('en-US')} | ${repo.contributions.length} |`);
  const stamp = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' }).format(new Date(updatedAt));
  const note = carry ? ` · 包含本人 ${direct} 个已合并 PR 和 ${carry} 项保留作者署名的转接合入贡献` : '';
  return [START, '', `已向 **${repositories.length} 个开源项目**贡献 **${direct + carry} 项已合入贡献**。`, '',
    '| 项目 | Stars | 已合入贡献 |', '| :--- | ---: | ---: |', ...rows, '',
    `<sub>每 15 分钟自动同步 · 统计更新于 ${stamp}（北京时间）${note}。</sub>`, '', END].join('\n');
}

export function replaceContributions(readme: string, block: string): string {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start < 0 || end < start || readme.indexOf(START, start + START.length) !== -1 || readme.indexOf(END, end + END.length) !== -1) {
    throw new Error('Expected one contribution block; preserving the current README.');
  }
  return readme.slice(0, start) + block + readme.slice(end + END.length);
}

async function githubGet(path: string) {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'profile-contribution-updater', 'X-GitHub-Api-Version': '2022-11-28' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(30000) });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({})) as { message?: string; errors?: { message?: string }[] };
    const reason = [detail.message, ...(detail.errors ?? []).map(error => error.message)].filter(Boolean).join(' ');
    throw new Error(`GitHub API returned HTTP ${response.status} for ${path.split('?')[0]}: ${reason}`);
  }
  return response.json();
}

async function main() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const config: Config = JSON.parse(await readFile(resolve(root, 'profile-config.json'), 'utf8'));
  const readmePath = resolve(root, 'README.md');
  const readme = await readFile(readmePath, 'utf8');
  const repositories = await collectContributions(config, githubGet);
  const snapshotPath = resolve(root, 'data/contributions.json');
  let previous;
  try { previous = JSON.parse(await readFile(snapshotPath, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const unchanged = JSON.stringify(previous?.repositories) === JSON.stringify(repositories);
  const updatedAt = unchanged ? previous.updatedAt : new Date().toISOString();
  const next = replaceContributions(readme, renderContributions(repositories, updatedAt));
  if (next !== readme) await writeFile(readmePath, next, 'utf8');
  if (!unchanged) {
    await mkdir(resolve(root, 'data'), { recursive: true });
    await writeFile(snapshotPath, JSON.stringify({ updatedAt, repositories }, null, 2) + '\n', 'utf8');
  }
  console.log(next === readme && unchanged ? 'Contribution statistics unchanged.' : 'Contribution statistics updated.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
