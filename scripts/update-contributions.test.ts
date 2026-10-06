import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectContributions, renderContributions, replaceContributions, START, END } from './update-contributions.ts';

const config = { username: 'Xx-173', carryOverContributions: [{ repository: 'tt-a1i/archify', originalPullRequest: 502, mergedPullRequest: 504, authorCommit: 'author-sha' }] };
const item = (number: number, repository = 'example/project') => ({ user: { login: 'Xx-173' }, repository_url: `https://api.github.com/repos/${repository}`, number, pull_request: { merged_at: '2026-10-06T00:00:00Z' } });
function api(items: ReturnType<typeof item>[], override: Record<string, unknown> = {}) {
  return async (path: string) => {
    if (Object.hasOwn(override, path)) return override[path];
    if (path.startsWith('/search/issues')) {
      const page = Number(new URL(`https://api.github.com${path}`).searchParams.get('page'));
      return { total_count: items.length, incomplete_results: false, items: items.slice((page - 1) * 100, page * 100) };
    }
    if (path.endsWith('/pulls/504')) return { merged: true, merged_at: '2026-09-22T14:56:43Z' };
    if (path.includes('/pulls/504/commits')) return [{ sha: 'author-sha' }];
    if (path.endsWith('/commits/author-sha')) return { author: { login: 'Xx-173' } };
    return { stargazers_count: path.includes('archify') ? 78525 : 100, private: false };
  };
}

test('paginates all merged PRs and retains attributed carry-over contribution', async () => {
  const repositories = await collectContributions(config, api(Array.from({ length: 103 }, (_, i) => item(i + 1))));
  assert.equal(repositories.length, 2);
  assert.equal(repositories[0].repository, 'tt-a1i/archify');
  assert.equal(repositories[0].contributions[0].kind, 'carry-over');
  assert.equal(repositories[1].contributions.length, 103);
});

test('does not double-count a carry-over PR or its original PR', async () => {
  for (const number of [502, 504]) {
    const repositories = await collectContributions(config, api([item(number, 'tt-a1i/archify')]));
    assert.equal(repositories[0].contributions.length, 1);
  }
});

test('rejects incomplete search results before publishing', async () => {
  await assert.rejects(collectContributions(config, async () => ({ total_count: 1, incomplete_results: true, items: [] })), /incomplete/);
});

test('rejects unverified carry-over merge, author or commit membership', async () => {
  const overrides = [
    { '/repos/tt-a1i/archify/pulls/504': { merged: false } },
    { '/repos/tt-a1i/archify/commits/author-sha': { author: { login: 'another-user' } } },
    { '/repos/tt-a1i/archify/pulls/504/commits?per_page=100&page=1': [{ sha: 'another-sha' }] },
  ];
  for (const override of overrides) await assert.rejects(collectContributions(config, api([], override)));
});

test('discovers a newly merged project and renders plain counts without touching other content', async () => {
  const repositories = await collectContributions(config, api([item(1, 'new/project'), item(2, 'new/project')]));
  const block = renderContributions(repositories, '2026-10-06T00:00:00Z');
  assert.match(block, /\*\*2 个开源项目\*\*/);
  assert.match(block, /\*\*3 项已合入贡献\*\*/);
  assert.match(block, /\| 100 \| 2 \|/);
  assert.doesNotMatch(block, /\| \[\d+\]/);
  assert.match(block, /2026-10-06 08:00/);
  const readme = `intro\n${START}\nold\n${END}\nprojects`;
  assert.equal(replaceContributions(readme, block), `intro\n${block}\nprojects`);
  assert.throws(() => replaceContributions('missing markers', block), /Expected one/);
});
