import { describe, expect, test, vi } from 'vitest'
import { listActionTags } from './action-tags.js'

describe('listActionTags', () => {
  test('accumulates across pages, drops the floating tag, sorts by semver', async () => {
    const octokit: any = {
      paginate: vi.fn(async (_route: unknown, _params: unknown, mapFn: any) => {
        const page1 = {
          data: [
            { ref: 'refs/tags/ladon/setup/v1.0.0' },
            { ref: 'refs/tags/ladon/setup/v1' },
          ],
        }
        const page2 = {
          data: [
            { ref: 'refs/tags/ladon/setup/v1.0.10' },
            { ref: 'refs/tags/ladon/setup/v1.0.2' },
          ],
        }
        return [...mapFn(page1), ...mapFn(page2)]
      }),
      rest: { git: { listMatchingRefs: vi.fn() } },
    }

    const tags = await listActionTags({
      octokit,
      owner: 'o',
      repo: 'r',
      action: 'ladon/setup',
    })

    expect(tags.map((tag) => tag.version)).toEqual(['1.0.10', '1.0.2', '1.0.0'])
    expect(tags[0].name).toBe('ladon/setup/v1.0.10')
    expect(octokit.paginate).toHaveBeenCalledWith(
      octokit.rest.git.listMatchingRefs,
      expect.objectContaining({
        owner: 'o',
        repo: 'r',
        ref: 'tags/ladon/setup/v',
        per_page: 100,
      }),
      expect.any(Function),
    )
  })

  test('returns an empty array when no tags match', async () => {
    const octokit: any = {
      paginate: vi.fn(async (_route: unknown, _params: unknown, mapFn: any) =>
        mapFn({ data: [] }),
      ),
      rest: { git: { listMatchingRefs: vi.fn() } },
    }

    expect(
      await listActionTags({ octokit, owner: 'o', repo: 'r', action: 'x' }),
    ).toEqual([])
  })
})
