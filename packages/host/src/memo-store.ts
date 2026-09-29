import { KalaStateStore } from './store/state-store.js'

export type MemoDocument = { content: string; revision: number; updatedAt: string }

export class MemoStore {
  private readonly state: KalaStateStore
  constructor(root: string | KalaStateStore) {
    this.state = typeof root === 'string'
      ? new KalaStateStore(root, { legacyMemoDirectory: root })
      : root
  }

  async read(owner: string): Promise<MemoDocument> {
    return this.state.readMemo(owner)
  }

  async write(owner: string, input: { content: string; expectedRevision?: number }): Promise<MemoDocument> {
    return this.state.writeMemo(owner, input)
  }
}
