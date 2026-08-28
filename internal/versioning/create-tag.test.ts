import { describe, expect, test, vi } from 'vitest'
import { createOrBumpTag } from './create-tag.js'

function octokitWith(createRef: unknown) {
  return { rest: { git: { createRef } } } as never
}

describe('createOrBumpTag', () => {
  test('returns the version it created', async () => {
    const createRef = vi.fn(async () => ({}))
    const created = await createOrBumpTag({
      octokit: octokitWith(createRef),
      owner: 'o',
      repo: 'r',
      action: 'x',
      version: '1.0.0',
      sha: 'abc',
    })
    expect(created).toBe('1.0.0')
    expect(createRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'refs/tags/x/v1.0.0', sha: 'abc' }),
    )
  })

  test('patch-bumps and returns the bumped version when the tag exists', async () => {
    const createRef = vi.fn(async (params: { ref: string }) => {
      if (params.ref === 'refs/tags/x/v1.0.0') {
        throw new Error('Reference already exists')
      }
      return {}
    })
    const created = await createOrBumpTag({
      octokit: octokitWith(createRef),
      owner: 'o',
      repo: 'r',
      action: 'x',
      version: '1.0.0',
      sha: 'abc',
    })
    expect(created).toBe('1.0.1')
  })

  test('rethrows errors that are not "Reference already exists"', async () => {
    const createRef = vi.fn(async () => {
      throw new Error('boom')
    })
    await expect(
      createOrBumpTag({
        octokit: octokitWith(createRef),
        owner: 'o',
        repo: 'r',
        action: 'x',
        version: '1.0.0',
        sha: 'abc',
      }),
    ).rejects.toThrow('boom')
  })
})
